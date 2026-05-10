// claude.sendMessage — Electron-aligned one-shot SDK Query per turn.
//
// Electron's ClaudeAgentManager calls sdk.query({ prompt, options }) for
// every user turn, carrying queryOptions.resume=<sdkSessionId> after the
// first SDK result. Keep the Tauri sidecar on the same contract: a
// running query exposes control/read methods through session.currentQuery,
// then the next user prompt builds a fresh query with resume context.
//
// SDKMessage→event mapping (mirror of Electron's processMessage):
//   system/init      → claude:status (full meta + sdkSessionId capture)
//   rate_limit_event → claude:rate-limit
//   stream_event     → claude:stream (text/thinking deltas) + usage tracking
//   assistant        → claude:message + claude:tool-use per block
//   user             → claude:tool-result per tool_result block
//   result/success   → claude:result + claude:turn-end
//   result/!success  → claude:error + claude:turn-end
//   stream throw     → handled by sendMessage's catch → claude:error /
//                      claude:turn-end
//
// SDK-unavailable fallback (releases without bundled node_modules)
// preserves the old stub so the renderer doesn't hang on a never-
// resolving promise.

import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import { sessions, ensureSession, buildSessionMeta } from '../lib/state.mjs'
import { loadAnthropicSdk } from '../lib/sdk-loader.mjs'
import { info as logInfo, warn as logWarn } from '../lib/logger.mjs'
import { sdkModelForClaudeSelection } from '../lib/models.mjs'
import { loadInstalledPlugins, dataUrlToContentBlock } from '../lib/plugins.mjs'
import { resolveClaudeCliBinary } from './claude-auth.mjs'
import { buildCanUseTool } from './claude-permission.mjs'

// processMessage: dispatch a single SDKMessage to the renderer-shaped
// event(s). Pure-ish — only mutates session state (sdkSessionId, model,
// permissionMode, lastUsage) and emits via sendEvent.
function processMessage(s, sessionId, msg) {
  if (msg && typeof msg.session_id === 'string') {
    s.sdkSessionId = msg.session_id
  }
  const t = msg?.type
  if (t === 'system' && msg.subtype === 'init') {
    if (typeof msg.session_id === 'string') s.sdkSessionId = msg.session_id
    if (typeof msg.model === 'string') s.model = msg.model
    if (typeof msg.permissionMode === 'string') s.permissionMode = msg.permissionMode
    const meta = buildSessionMeta(s)
    if (typeof msg.cwd === 'string' && meta) meta.cwd = msg.cwd
    sendEvent('claude:status', { sessionId, meta })
    return
  }
  if (t === 'rate_limit_event') {
    const info = msg.rate_limit_info
    if (info && typeof info.rateLimitType === 'string' && typeof info.resetsAt === 'number') {
      sendEvent('claude:rate-limit', {
        sessionId,
        info: {
          rateLimitType: info.rateLimitType,
          resetsAt: info.resetsAt * 1000,
          utilization: typeof info.utilization === 'number' ? info.utilization : null,
          isUsingOverage: info.isUsingOverage ?? false,
        },
      })
    }
    return
  }
  if (t === 'stream_event') {
    const ev = msg.event
    if (ev && (ev.type === 'message_start' || ev.type === 'message_delta')) {
      const u = ev.usage || ev.message?.usage
      if (u && !msg.parent_tool_use_id) {
        const inputTotal = (u.input_tokens || 0)
          + (u.cache_creation_input_tokens || 0)
          + (u.cache_read_input_tokens || 0)
        s.lastUsage = {
          input_tokens: u.input_tokens || 0,
          output_tokens: u.output_tokens || s.lastUsage?.output_tokens || 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
          cache_read_input_tokens: u.cache_read_input_tokens || 0,
          totalTokens: inputTotal,
          model: s.model || s.lastUsage?.model || null,
        }
      }
    }
    if (ev && ev.type === 'content_block_delta') {
      const d = ev.delta
      if (d?.text) {
        sendEvent('claude:stream', { sessionId, data: { text: d.text, parentToolUseId: msg.parent_tool_use_id ?? null } })
      }
      if (d?.thinking) {
        sendEvent('claude:stream', { sessionId, data: { thinking: d.thinking, parentToolUseId: msg.parent_tool_use_id ?? null } })
      }
    }
    return
  }
  if (t === 'assistant') {
    sendEvent('claude:message', { sessionId, message: msg })
    const blocks = msg.message?.content
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && block.type === 'tool_use' && typeof block.id === 'string') {
          sendEvent('claude:tool-use', {
            sessionId,
            toolCall: {
              id: block.id,
              sessionId,
              toolName: block.name,
              input: block.input || {},
              status: 'running',
              parentToolUseId: msg.parent_tool_use_id ?? null,
              timestamp: Date.now(),
            },
          })
        }
      }
    }
    return
  }
  if (t === 'user') {
    const blocks = msg.message?.content
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          sendEvent('claude:tool-result', {
            sessionId,
            result: {
              id: block.tool_use_id,
              status: block.is_error ? 'error' : 'success',
              result: block.content,
            },
          })
        }
      }
    }
    return
  }
  if (t === 'result') {
    if (msg.usage) {
      const u = msg.usage
      const inputTotal = (u.input_tokens || 0)
        + (u.cache_creation_input_tokens || 0)
        + (u.cache_read_input_tokens || 0)
      s.lastUsage = {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
        cache_read_input_tokens: u.cache_read_input_tokens || 0,
        totalTokens: inputTotal,
        model: s.model || s.lastUsage?.model || null,
        totalCostUsd: msg.total_cost_usd ?? s.lastUsage?.totalCostUsd ?? 0,
        numTurns: msg.num_turns ?? s.lastUsage?.numTurns ?? 0,
      }
    }
    if (msg.subtype === 'success') {
      sendEvent('claude:result', { sessionId, result: msg })
      sendEvent('claude:turn-end', { sessionId, payload: { reason: 'completed', result: msg.result, sdkSessionId: msg.session_id } })
    } else {
      sendEvent('claude:error', { sessionId, error: msg.message || 'query error' })
      sendEvent('claude:turn-end', { sessionId, payload: { reason: 'error' } })
    }
  }
}

async function buildQueryOptions(s, sessionId, prompt) {
  const cwd = (s.options && typeof s.options === 'object' && typeof s.options.cwd === 'string') ? s.options.cwd : process.cwd()
  const sdkMode = s.permissionMode === 'bypassPlan' ? 'plan' : s.permissionMode
  const sdkModel = sdkModelForClaudeSelection(s.model)
  const claudeCodePath = resolveClaudeCliBinary()
  const queryOptions = {
    cwd,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    includePartialMessages: true,
    promptSuggestions: true,
    settingSources: ['user', 'project', 'local'],
    agentProgressSummaries: true,
    toolConfig: { askUserQuestion: { previewFormat: 'html' } },
  }
  if (sdkMode && sdkMode !== 'default') queryOptions.permissionMode = sdkMode
  if (s.permissionMode === 'bypassPermissions') queryOptions.allowDangerouslySkipPermissions = true
  if (s.effort) queryOptions.effort = s.effort
  if (sdkModel) queryOptions.model = sdkModel
  if (claudeCodePath) queryOptions.pathToClaudeCodeExecutable = claudeCodePath
  const installedPlugins = await loadInstalledPlugins()
  if (installedPlugins.length > 0) queryOptions.plugins = installedPlugins
  queryOptions.canUseTool = (toolName, input, opts) => buildCanUseTool(s, sessionId, toolName, input, opts)
  if (s.autoCompactWindow) {
    queryOptions.env = { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(s.autoCompactWindow) }
  }
  if (s.sdkSessionId) {
    queryOptions.resume = s.sdkSessionId
    if (typeof prompt === 'string' && (!prompt || prompt.trim() === '' || prompt.trim() === ' ')) {
      queryOptions.continue = true
    }
  }
  return queryOptions
}

// buildUserMessage: shape an SDKUserMessage from the prompt + optional
// image attachments (data URLs). Mirrors the pre-LiveQuery promptArg
// generator: a single content block array carrying images then text.
function buildUserMessage(prompt, images) {
  const text = prompt || ' '
  const imageList = Array.isArray(images) ? images : null
  if (imageList && imageList.length > 0) {
    const imageBlocks = imageList.map(dataUrlToContentBlock).filter(Boolean)
    if (imageBlocks.length > 0) {
      const contentBlocks = [
        ...imageBlocks,
        ...(prompt ? [{ type: 'text', text: prompt }] : []),
      ]
      return { type: 'user', message: { role: 'user', content: contentBlocks } }
    }
  }
  return { type: 'user', message: { role: 'user', content: text } }
}

function buildPromptArg(prompt, images) {
  const imageList = Array.isArray(images) ? images : null
  if (imageList && imageList.length > 0) {
    const userMessage = buildUserMessage(prompt, imageList)
    return (async function* singleMessage() {
      yield userMessage
    })()
  }
  return prompt || ' '
}

// closeLiveQuery: shared cleanup used by the lifecycle handlers in
// claude-session.mjs (abort / reset / stop / rest / resume) and also
// invoked locally when a control method fails. It now also closes the
// one-shot currentQuery used by sendMessage. Idempotent.
//
// abortController is intentionally NOT cleared — sendMessage's catch
// reads s.abortController?.signal.aborted to distinguish 'aborted' vs
// 'error' turn-end reasons after sdk.query rejects. sendMessage installs
// a fresh AbortController on the next turn.
export function closeLiveQuery(s) {
  if (!s) return
  if (s.liveQuery) {
    try { s.liveQuery.close() } catch { /* ignore */ }
  } else if (s.currentQuery && typeof s.currentQuery.close === 'function') {
    try { s.currentQuery.close() } catch { /* ignore */ }
  }
  s.liveQuery = null
  s.currentQuery = null
}

function shortSessionId(sessionId) {
  return typeof sessionId === 'string' ? sessionId.slice(0, 8) : 'unknown'
}

async function performSendMessage(params) {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.sendMessage: missing sessionId')
  }
  const prompt = typeof params?.prompt === 'string' ? params.prompt : ''
  const s = ensureSession(sessionId)
  const sid = shortSessionId(sessionId)
  if (s.isResting) s.isResting = false

  const sdk = await loadAnthropicSdk()
  if (!sdk || typeof sdk.query !== 'function') {
    logWarn(`claude.sendMessage: SDK unavailable, returning stub for session ${sessionId}`)
    sendEvent('claude:message', { sessionId, message: { role: 'assistant', content: '(stub reply — SDK unavailable)' } })
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'completed', result: '(stub)' } })
    return { ok: true, stub: true }
  }

  const startedAt = Date.now()
  const images = Array.isArray(params?.images) ? params.images : null
  let queryOptions
  try {
    queryOptions = await buildQueryOptions(s, sessionId, prompt)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logWarn(`claude.sendMessage(${sid}): buildQueryOptions failed: ${errMsg}`)
    sendEvent('claude:error', { sessionId, error: errMsg })
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'error' } })
    return { ok: false, error: errMsg }
  }

  s.abortController = new AbortController()
  queryOptions.abortController = s.abortController
  s.streaming = true
  s.liveQuery = null
  let generator = null
  let lastResult = null
  logInfo(`claude.sendMessage(${sid}): start promptLen=${prompt.length} images=${images ? images.length : 0} resume=${queryOptions.resume || 'none'}`)
  try {
    generator = sdk.query({
      prompt: buildPromptArg(prompt, images),
      options: queryOptions,
    })
    s.currentQuery = generator
    for await (const msg of generator) {
      if (s.abortController?.signal.aborted) break
      if (msg?.type === 'result') lastResult = msg
      try { processMessage(s, sessionId, msg) }
      catch (err) {
        logWarn(`processMessage threw for ${sessionId}: ${err?.message || err}`)
      }
    }
    const elapsedMs = Date.now() - startedAt
    if (lastResult?.subtype === 'success') {
      logInfo(`claude.sendMessage(${sid}): completed ok elapsedMs=${elapsedMs}`)
      return { ok: true }
    }
    if (!lastResult && s.abortController?.signal.aborted) {
      logInfo(`claude.sendMessage(${sid}): aborted`)
      return { ok: true }
    }
    if (!lastResult) {
      logWarn(`claude.sendMessage(${sid}): completed without result elapsedMs=${elapsedMs}`)
      sendEvent('claude:turn-end', { sessionId, payload: { reason: 'completed' } })
      return { ok: true }
    }
    const errMsg = lastResult?.message || 'query error'
    logWarn(`claude.sendMessage(${sid}): completed error elapsedMs=${elapsedMs} error=${errMsg}`)
    return { ok: false, error: errMsg }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const aborted = s.abortController?.signal.aborted
      || /aborted/i.test(errMsg)
    if (!aborted) {
      logWarn(`claude.sendMessage(${sid}): push failed: ${errMsg}`)
      sendEvent('claude:error', { sessionId, error: errMsg })
    } else {
      logInfo(`claude.sendMessage(${sid}): aborted`)
    }
    sendEvent('claude:turn-end', { sessionId, payload: { reason: aborted ? 'aborted' : 'error' } })
    return { ok: !aborted, error: aborted ? undefined : errMsg }
  } finally {
    s.streaming = false
  }
}

registerHandler('claude.sendMessage', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.sendMessage: missing sessionId')
  }
  const s = ensureSession(sessionId)
  const sid = shortSessionId(sessionId)
  const wasQueued = Boolean(s.sendQueue)
  if (wasQueued) {
    logInfo(`claude.sendMessage(${sid}): queued behind active turn`)
  }
  const previous = s.sendQueue || Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    if (sessions.get(sessionId) !== s) {
      return { ok: false, error: 'session stopped' }
    }
    return performSendMessage(params)
  })
  const queued = run.finally(() => {
    if (s.sendQueue === queued) s.sendQueue = null
  })
  s.sendQueue = queued
  return queued
})

// claude.stopTask: cancel a running sub-agent / Agent tool by its
// task_id (or tool_use_id as fallback when no task mapping exists).
registerHandler('claude.stopTask', async (params) => {
  const sessionId = params?.sessionId
  const taskId = params?.taskId ?? params?.toolUseId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.stopTask: missing sessionId')
  }
  if (typeof taskId !== 'string' || !taskId) {
    throw new Error('claude.stopTask: missing taskId / toolUseId')
  }
  const s = sessions.get(sessionId)
  const query = s?.currentQuery
  if (!s || !s.streaming || !query || typeof query.stopTask !== 'function') {
    return { ok: false, error: 'no active query for session' }
  }
  try {
    await query.stopTask(taskId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})
