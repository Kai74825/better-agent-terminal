// JSON-RPC protocol primitives + handler registry. Shared singleton state.
//
// `handlers` Map: method name → async fn(params). Populated as each
// handler module is imported for side effects in server.mjs.
//
// `sendEvent` writes a JSON-RPC notification to stdout. Host-originated
// proxied events are also mirrored to the remote broadcast hub using the
// legacy-v1 positional event shape consumed by Electron remote clients.
// Tests swap the underlying impl via __setSendEventForTests so they can
// capture emits without spawning a child process.

import { broadcastHub } from './remote-broadcast.mjs'
import { PROXIED_EVENTS } from './remote-protocol.mjs'

const handlers = new Map()

export function registerHandler(method, fn) {
  if (handlers.has(method)) {
    throw new Error(`sidecar: handler already registered for ${method}`)
  }
  handlers.set(method, fn)
}

export { handlers }

export function writeMessage(obj) {
  // Single write to keep the line atomic. Node guarantees a single
  // synchronous write to a pipe doesn't interleave with another writer in
  // this process.
  process.stdout.write(JSON.stringify(obj) + '\n')
}

// Tests can swap _emitImpl to capture events without touching stdout.
// Production callers use sendEvent which trampolines through _emitImpl.
let _emitImpl = (name, params) => {
  writeMessage({ jsonrpc: '2.0', method: `event:${name}`, params: params ?? null })
}

const CLAUDE_EVENT_PAYLOAD_KEYS = {
  'claude:message': 'message',
  'claude:tool-use': 'toolCall',
  'claude:tool-result': 'result',
  'claude:stream': 'data',
  'claude:result': 'result',
  'claude:turn-end': 'payload',
  'claude:error': 'error',
  'claude:status': 'meta',
  'claude:permission-request': 'data',
  'claude:permission-resolved': 'toolUseId',
  'claude:ask-user': 'data',
  'claude:ask-user-resolved': 'toolUseId',
  'claude:modeChange': 'mode',
  'claude:history': 'items',
  'claude:resume-loading': 'loading',
  'claude:prompt-suggestion': 'suggestion',
  'claude:worktree-info': 'payload',
  'claude:rate-limit': 'info',
}

export function eventParamsToLegacyV1Args(name, params) {
  if (Array.isArray(params)) return params
  if (name === 'pty:output') return [params?.id, params?.data]
  if (name === 'pty:exit') return [params?.id, params?.exitCode]
  if (name === 'claude:session-reset') return [params?.sessionId]

  const payloadKey = CLAUDE_EVENT_PAYLOAD_KEYS[name]
  if (payloadKey) return [params?.sessionId, params?.[payloadKey]]

  if (name === 'fs:changed') return [params]
  if (name === 'workspace:detached' || name === 'workspace:reattached' || name === 'workspace:reload') {
    return [params]
  }
  if (name === 'system:resume') return [params]
  return [params]
}

export function sendEvent(name, params, options = {}) {
  const payload = params ?? null
  _emitImpl(name, payload)
  if (options.broadcast !== false && PROXIED_EVENTS.has(name)) {
    broadcastHub.broadcast(name, ...eventParamsToLegacyV1Args(name, payload))
  }
}
// Returns a restore() function that resets to the production impl.
export function __setSendEventForTests(fn) {
  const prev = _emitImpl
  _emitImpl = fn
  return () => { _emitImpl = prev }
}

export async function dispatch(message) {
  if (!message || typeof message !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }
  }
  const { id, method, params } = message
  if (typeof method !== 'string') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'missing method' } }
  }
  const handler = handlers.get(method)
  if (!handler) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `method not found: ${method}` } }
  }
  try {
    const result = await handler(params)
    // Notifications (no id) get no response.
    if (id === undefined || id === null) return null
    return { jsonrpc: '2.0', id, result: result ?? null }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }
}
