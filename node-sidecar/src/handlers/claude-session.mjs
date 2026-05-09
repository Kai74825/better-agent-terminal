// claude.* session lifecycle + setters + getters.
// startSession, resumeSession, resetSession, restSession, wakeSession,
// isResting, stopSession, abortSession, setAutoContinue, getAutoContinue,
// setPermissionMode, setModel, setEffort, getSessionState, getSessionMeta,
// getContextUsage.

import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import { sessions, ensureSession, buildSessionMeta } from '../lib/state.mjs'
import { expectedContextWindowForModel } from '../lib/models.mjs'

registerHandler('claude.startSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.startSession: missing sessionId')
  }
  const s = ensureSession(sessionId)
  s.active = true
  s.options = params?.options ?? null
  // Some options carry per-session config the renderer expects to read
  // back via getSessionMeta — capture them now.
  if (s.options && typeof s.options === 'object') {
    if (typeof s.options.model === 'string') s.model = s.options.model
    if (typeof s.options.permissionMode === 'string') s.permissionMode = s.options.permissionMode
    if (typeof s.options.effort === 'string') s.effort = s.options.effort
    if (typeof s.options.autoCompactWindow === 'number') s.autoCompactWindow = s.options.autoCompactWindow
    // startSession can also pre-populate sdkSessionId for the resume
    // path. The renderer's reload-from-history flow goes through
    // claude.resumeSession (below), but the underlying mechanism is
    // identical: stash the SDK id so the next sendMessage uses
    // `resume: <id>` and the SDK reconstructs the conversation.
    if (typeof s.options.sdkSessionId === 'string') s.sdkSessionId = s.options.sdkSessionId
  }
  return { ok: true, sessionId }
})

// claude.resumeSession: rewire a session to an existing SDK session id.
// Mirror of electron/claude-agent-manager.ts:2461. Aborts any in-flight
// query, swaps the session record, and pre-populates sdkSessionId so
// the next sendMessage passes `resume: <id>` — the SDK then rehydrates
// the conversation from its own session store. We default the
// permissionMode to 'bypassPermissions' to match Electron's resume
// contract (resumed sessions don't re-prompt for prior approvals).
registerHandler('claude.resumeSession', async (params) => {
  const sessionId = params?.sessionId
  const sdkSessionIdToResume = params?.sdkSessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.resumeSession: missing sessionId')
  }
  if (typeof sdkSessionIdToResume !== 'string' || !sdkSessionIdToResume) {
    throw new Error('claude.resumeSession: missing sdkSessionId')
  }
  const existing = sessions.get(sessionId)
  if (existing?.abortController) {
    try { existing.abortController.abort() } catch { /* already aborted */ }
  }
  // Drop the prior record (if any) and rebuild from the resume options.
  sessions.delete(sessionId)
  const s = ensureSession(sessionId)
  s.active = true
  s.options = params?.options ?? null
  s.sdkSessionId = sdkSessionIdToResume
  s.permissionMode = 'bypassPermissions'
  if (s.options && typeof s.options === 'object') {
    if (typeof s.options.cwd === 'string') {
      // Keep cwd in options so sendMessage's queryOptions picks it up.
    }
    if (typeof s.options.model === 'string') s.model = s.options.model
    if (typeof s.options.permissionMode === 'string') s.permissionMode = s.options.permissionMode
    if (typeof s.options.effort === 'string') s.effort = s.options.effort
    if (typeof s.options.autoCompactWindow === 'number') s.autoCompactWindow = s.options.autoCompactWindow
  }
  return { ok: true, sessionId, sdkSessionId: sdkSessionIdToResume }
})

// claude.restSession / wakeSession / isResting: mirror the resting-UX
// flag from electron/claude-agent-manager.ts:2481+. The renderer flips
// a session into "resting" when the user wants to pause it without
// destroying the SDK session id — abort any in-flight query, clear the
// streaming guard, and emit a single system-message hint so the panel
// shows "tap to wake". Wake clears the flag; the next sendMessage also
// clears it (see claude.sendMessage below).
registerHandler('claude.restSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const session = sessions.get(sessionId)
  if (!session) return false
  if (session.abortController) {
    try { session.abortController.abort() } catch { /* already aborted */ }
  }
  session.abortController = null
  session.streaming = false
  session.isResting = true
  sendEvent('claude:message', {
    sessionId,
    message: {
      id: `sys-rest-${Date.now()}`,
      sessionId,
      role: 'system',
      content: 'Session is resting. Send a message to wake it up.',
      timestamp: Date.now(),
    },
  })
  return true
})
registerHandler('claude.wakeSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const session = sessions.get(sessionId)
  if (!session) return false
  session.isResting = false
  return true
})
registerHandler('claude.isResting', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const session = sessions.get(sessionId)
  return session?.isResting === true
})

registerHandler('claude.stopSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.stopSession: missing sessionId')
  }
  const s = sessions.get(sessionId)
  if (s?.abortController) {
    try { s.abortController.abort() } catch { /* already aborted */ }
  }
  const existed = sessions.delete(sessionId)
  return { ok: true, existed }
})

registerHandler('claude.abortSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('claude.abortSession: missing sessionId')
  }
  const session = sessions.get(sessionId)
  if (session?.abortController) {
    try { session.abortController.abort() } catch { /* already aborted */ }
  }
  if (session) {
    session.active = false
    // claude:turn-end is also emitted by sendMessage's catch, but we
    // emit here too in case abort is called after streaming finished
    // (the renderer expects an explicit signal).
    sendEvent('claude:turn-end', { sessionId, payload: { reason: 'aborted' } })
  }
  return { ok: true }
})

// Per-session state setters. These persist values into the session map
// so getters return what the renderer last set. When the SDK lands,
// these hooks will additionally push the change into the live query
// instance (e.g. set the model on a streaming session). For now they
// just maintain the visible state contract.

registerHandler('claude.setAutoContinue', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const opts = params?.opts || params?.options || {}
  const s = ensureSession(sessionId)
  if (typeof opts.enabled === 'boolean') s.autoContinue.enabled = opts.enabled
  if (typeof opts.max === 'number') s.autoContinue.max = opts.max
  if (typeof opts.prompt === 'string') s.autoContinue.prompt = opts.prompt
  // Reset usage counter when toggling, matches Electron behaviour.
  s.autoContinue.used = 0
  return true
})

registerHandler('claude.getAutoContinue', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return null
  const s = sessions.get(sessionId)
  return s ? { ...s.autoContinue } : null
})

registerHandler('claude.setPermissionMode', async (params) => {
  const sessionId = params?.sessionId
  const mode = params?.mode
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (typeof mode !== 'string') return false
  const s = ensureSession(sessionId)
  s.permissionMode = mode
  // Mirror Electron's claude:modeChange event so listeners refresh.
  sendEvent('claude:modeChange', { sessionId, mode })
  return true
})

registerHandler('claude.setModel', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const s = ensureSession(sessionId)
  if (typeof params?.model === 'string') s.model = params.model
  if (typeof params?.autoCompactWindow === 'number') s.autoCompactWindow = params.autoCompactWindow
  return true
})

registerHandler('claude.setEffort', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  const s = ensureSession(sessionId)
  if (typeof params?.effort === 'string') s.effort = params.effort
  return true
})

registerHandler('claude.resetSession', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return false
  // Drop the session record entirely. Next startSession recreates it.
  const existed = sessions.delete(sessionId)
  // Mirror Electron's claude:session-reset notification so renderer
  // panels can clear messages / status without polling.
  if (existed) sendEvent('claude:session-reset', { sessionId })
  return existed
})

// Session state lookups read from the per-session map populated by
// startSession + the various setters above. When no session exists for
// the given id we return null to match Electron's behaviour.
registerHandler('claude.getSessionState', async (params) => {
  const s = sessions.get(String(params?.sessionId ?? ''))
  if (!s) return null
  return {
    active: s.active,
    permissionMode: s.permissionMode,
    model: s.model,
    effort: s.effort,
    autoCompactWindow: s.autoCompactWindow,
  }
})

registerHandler('claude.getSessionMeta', async (params) => {
  const s = sessions.get(String(params?.sessionId ?? ''))
  return buildSessionMeta(s)
})

// claude.getContextUsage: surface the cached usage from the last
// stream_event / result for this session in a shape the renderer's
// ContextUsagePopup understands (subset of SDKControlGetContextUsageResponse:
// categories[], totalTokens, maxTokens, percentage, model, plus
// optional apiUsage). We return null if no turn has completed yet —
// renderer interprets that as "no data yet" and hides the popup.
//
// Live mid-turn data via the SDK control method (instance.getContextUsage())
// would require streaming-input mode, which we don't implement yet.
// Cached values cover the common case where the user opens the popup
// between turns.
registerHandler('claude.getContextUsage', async (params) => {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string') return null
  const s = sessions.get(sessionId)
  if (!s || !s.lastUsage) return null
  const u = s.lastUsage
  const model = u.model || s.model || null
  const maxTokens = expectedContextWindowForModel(model) || 200000
  const totalTokens = u.totalTokens || 0
  const percentage = maxTokens > 0 ? Math.round((totalTokens / maxTokens) * 100) : 0
  return {
    categories: [{ name: 'Context', tokens: totalTokens, color: '#8B5CF6' }],
    totalTokens,
    maxTokens,
    percentage,
    model: model || 'unknown',
    apiUsage: {
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens || 0,
    },
  }
})
