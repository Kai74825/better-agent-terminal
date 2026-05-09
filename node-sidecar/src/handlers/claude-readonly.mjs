// claude.* read-only metadata + worktree-related claude.* handlers.
// Houses findClaudeCliPath / listSessionsFallback (the disk-walking
// session lister) since they only feed claude.listSessions / getCliPath.

import { readdir, stat } from 'node:fs/promises'
import { createReadStream, accessSync, constants as fsConstants } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir, platform } from 'node:os'
import { join, basename } from 'node:path'

import { registerHandler, sendEvent } from '../lib/protocol.mjs'
import { loadAnthropicSdk } from '../lib/sdk-loader.mjs'
import { CLAUDE_BUILTIN_MODELS, CLAUDE_BUILTIN_DEDUP_KEYS } from '../lib/models.mjs'
import { scanSkills } from '../lib/skills.mjs'
import { activeWorktrees, worktreeStatus, worktreeRemove } from './worktree.mjs'

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const PREVIEW_LINE_LIMIT = 20
const PREVIEW_CHARS = 120
const SESSION_LIST_LIMIT = 50

export function findClaudeCliPath() {
  // Walk PATH and look for "claude" (or claude.cmd / claude.exe / claude.bat
  // on Windows). Returns the first match or null. We deliberately do not
  // shell out to `which` / `where` — readdir-by-PATHEXT is cheaper and
  // doesn't depend on platform tooling being present.
  const PATH = process.env.PATH ?? ''
  const sep = platform() === 'win32' ? ';' : ':'
  const dirs = PATH.split(sep).filter(Boolean)
  const exts = platform() === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toLowerCase())
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `claude${ext}`)
      try {
        accessSync(candidate, fsConstants.F_OK)
        return candidate
      } catch { /* not here, try next */ }
    }
  }
  return null
}

export async function listSessionsFallback(cwd) {
  // Sessions live under ~/.claude/projects/<encoded>/, where <encoded> is
  // the cwd with all non-alphanumeric chars replaced by "-". Windows
  // sometimes case-folds the first letter, so we probe a couple of
  // alt-cased variants to be safe.
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const candidates = [join(CLAUDE_PROJECTS_DIR, encoded)]
  if (platform() === 'win32' && encoded.length > 0) {
    const lower = encoded[0].toLowerCase() + encoded.slice(1)
    const upper = encoded[0].toUpperCase() + encoded.slice(1)
    if (lower !== encoded) candidates.push(join(CLAUDE_PROJECTS_DIR, lower))
    if (upper !== encoded) candidates.push(join(CLAUDE_PROJECTS_DIR, upper))
  }

  const results = []
  for (const dir of candidates) {
    let entries
    try {
      entries = (await readdir(dir)).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of entries) {
      const filePath = join(dir, file)
      const sdkSessionId = basename(file, '.jsonl')
      try {
        const st = await stat(filePath)
        const { preview, messageCount } = await readSessionPreview(filePath)
        results.push({
          sdkSessionId,
          timestamp: st.mtimeMs,
          preview: preview || '(no preview)',
          messageCount,
        })
      } catch { /* skip unreadable */ }
    }
  }

  const seen = new Set()
  const deduped = results.filter(r => {
    if (seen.has(r.sdkSessionId)) return false
    seen.add(r.sdkSessionId)
    return true
  })
  deduped.sort((a, b) => b.timestamp - a.timestamp)
  return deduped.slice(0, SESSION_LIST_LIMIT)
}

async function readSessionPreview(filePath) {
  // Stream up to PREVIEW_LINE_LIMIT lines and stop. We only need the
  // first user message for the preview; any further reading is wasted I/O
  // on JSONL files that can be hundreds of MB.
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let preview = ''
  let messageCount = 0
  let lineCount = 0
  try {
    for await (const line of rl) {
      lineCount++
      if (lineCount > PREVIEW_LINE_LIMIT) break
      try {
        const obj = JSON.parse(line)
        messageCount++
        if (!preview && obj?.type === 'user') {
          const content = obj?.message?.content
          if (typeof content === 'string') {
            preview = content.slice(0, PREVIEW_CHARS)
          } else if (Array.isArray(content)) {
            const textBlock = content.find(b => b?.type === 'text')
            if (textBlock?.text) preview = String(textBlock.text).slice(0, PREVIEW_CHARS)
          }
        }
      } catch { /* skip malformed */ }
    }
  } finally {
    stream.destroy()
  }
  return { preview, messageCount }
}

// --- handlers --------------------------------------------------------------

// Read-only metadata. Two of these are now real implementations:
//   - claude.getCliPath: locate the `claude` binary on PATH (no SDK dep).
//   - claude.listSessions: parse JSONL session files under
//     ~/.claude/projects/<encoded-cwd>/, mirroring the fallback path
//     of the Electron-side claude-agent-manager.listSessionsFallback().
// The rest return inert defaults until @anthropic-ai/claude-agent-sdk
// moves into the sidecar.
registerHandler('claude.getCliPath', async () => findClaudeCliPath() ?? '')
registerHandler('claude.listSessions', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!cwd) return []
  return listSessionsFallback(cwd)
})

// Returns the builtin claude model list, optionally augmented with
// SDK-discovered models when @anthropic-ai/claude-agent-sdk is
// importable. Builtin entries are always present and tagged source:
// 'builtin'; SDK entries are tagged source: 'sdk' and de-duped against
// the builtin values (including [1m] variants). Mirrors the Electron
// claudeAgentManager.getSupportedModels() behaviour, including the
// "SDK fails → builtins-only" fallback.
//
// In release builds without bundled node_modules, the SDK import will
// fail and we silently return builtins. Drift guard test still applies.
registerHandler('claude.getSupportedModels', async () => {
  const builtins = CLAUDE_BUILTIN_MODELS.map(m => ({ ...m, source: 'builtin' }))
  try {
    const sdk = await loadAnthropicSdk()
    if (!sdk) return builtins
    const dedupKeys = new Set(CLAUDE_BUILTIN_DEDUP_KEYS)
    const instance = sdk.query({ prompt: '', options: { cwd: '/' } })
    const sdkModels = await instance.supportedModels()
    const sdkFiltered = (Array.isArray(sdkModels) ? sdkModels : [])
      .filter(m => m && typeof m.value === 'string'
        && !dedupKeys.has(m.value)
        && !dedupKeys.has(`${m.value}[1m]`))
      .map(m => ({ ...m, source: 'sdk' }))
    return [...builtins, ...sdkFiltered]
  } catch {
    return builtins
  }
})
// getSupportedCommands / getSupportedAgents / getAccountInfo follow the
// same SDK-augmentation pattern as getSupportedModels: try the SDK
// first, fall back to the previous stub shape (empty list / null) if
// the SDK isn't reachable. The Query instance is short-lived — we
// instantiate it just to call the read method, no actual prompt sent,
// matching what getSupportedModels does.
registerHandler('claude.getSupportedCommands', async () => {
  try {
    const sdk = await loadAnthropicSdk()
    if (!sdk || typeof sdk.query !== 'function') return []
    const instance = sdk.query({ prompt: '', options: { cwd: '/' } })
    const cmds = await instance.supportedCommands()
    return Array.isArray(cmds) ? cmds : []
  } catch {
    return []
  }
})
registerHandler('claude.getSupportedAgents', async () => {
  try {
    const sdk = await loadAnthropicSdk()
    if (!sdk || typeof sdk.query !== 'function') return []
    const instance = sdk.query({ prompt: '', options: { cwd: '/' } })
    const agents = await instance.supportedAgents()
    return Array.isArray(agents) ? agents : []
  } catch {
    return []
  }
})
registerHandler('claude.getAccountInfo', async () => {
  try {
    const sdk = await loadAnthropicSdk()
    if (!sdk || typeof sdk.query !== 'function') return null
    const instance = sdk.query({ prompt: '', options: { cwd: '/' } })
    const info = await instance.accountInfo()
    return info ?? null
  } catch {
    return null
  }
})

registerHandler('claude.getWorktreeStatus', async (params) => {
  const sessionId = String(params?.sessionId ?? '')
  if (!sessionId) return null
  const info = activeWorktrees.get(sessionId)
  if (!info) return null
  return worktreeStatus(sessionId)
})
// claude.scanSkills walks <cwd>/.claude/skills + ~/.claude/skills and
// returns SkillMeta entries. No SDK dep — pure fs walk + YAML
// frontmatter parsing. Mirrors electron/openai-agent/skills-scanner.ts.
// claude.cleanupWorktree drops the worktree associated with a session.
// In the Electron flow it also resets the agent session's cwd back to
// originalCwd and emits claude:worktree-info — those happen in the
// session manager, which still lives in the renderer/Electron side
// for now. The sidecar just runs the disk-level cleanup.
registerHandler('claude.cleanupWorktree', async (params) => {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
  const deleteBranch = params?.deleteBranch !== false
  if (!sessionId) return false
  try {
    await worktreeRemove(sessionId, deleteBranch)
    sendEvent('claude:worktree-info', { sessionId, payload: null })
    return true
  } catch {
    return false
  }
})
registerHandler('claude.scanSkills', async (params) => {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
  if (!cwd) return []
  return scanSkills(cwd)
})
