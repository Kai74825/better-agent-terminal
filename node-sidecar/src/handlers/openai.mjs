// openai.* handlers + the on-disk session lister.
//
// openai.listSessions walks ~/.better-agent-terminal/openai-sessions/
// <yyyy>/<mm>/<dd>/*.jsonl. Mirrors persistence.listAllSessions
// from electron/openai-agent/persistence.ts. The cwd parameter is
// accepted but unused — the Electron impl ignores it too because
// OpenAI sessions aren't grouped by working directory.

import { mkdir, readdir, stat, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { registerHandler } from '../lib/protocol.mjs'
import { resolveDataDir } from '../lib/data-paths.mjs'

export const OPENAI_SESSIONS_ROOT = join(homedir(), '.better-agent-terminal', 'openai-sessions')
const OPENAI_KEY_FILE = 'openai-api-key.bin'

function openAIKeyPath() {
  return join(resolveDataDir(), OPENAI_KEY_FILE)
}

async function loadCodexOAuthToken() {
  const authPath = join(homedir(), '.codex', 'auth.json')
  try {
    const raw = await readFile(authPath, 'utf-8')
    const auth = JSON.parse(raw)
    const token = auth?.tokens?.access_token
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

async function loadOpenAIKey() {
  try {
    const key = (await readFile(openAIKeyPath(), 'utf-8')).trim()
    if (key) return key
  } catch { /* configured key missing */ }

  const codexToken = await loadCodexOAuthToken()
  if (codexToken) return codexToken

  const envKey = process.env.OPENAI_API_KEY
  return typeof envKey === 'string' && envKey.length > 0 ? envKey : null
}

async function setOpenAIKey(apiKey) {
  const path = openAIKeyPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, apiKey, { encoding: 'utf-8', mode: 0o600 })
  return true
}

async function clearOpenAIKey() {
  try {
    await rm(openAIKeyPath(), { force: true })
  } catch { /* ignore */ }
  return true
}

export async function listOpenAISessions() {
  const results = []
  let years
  try {
    years = (await readdir(OPENAI_SESSIONS_ROOT, { withFileTypes: true })).filter(e => e.isDirectory())
  } catch {
    return [] // root doesn't exist — fresh install
  }
  for (const y of years) {
    const yp = join(OPENAI_SESSIONS_ROOT, y.name)
    let months
    try { months = (await readdir(yp, { withFileTypes: true })).filter(e => e.isDirectory()) } catch { continue }
    for (const m of months) {
      const mp = join(yp, m.name)
      let days
      try { days = (await readdir(mp, { withFileTypes: true })).filter(e => e.isDirectory()) } catch { continue }
      for (const dd of days) {
        const dp = join(mp, dd.name)
        let files
        try {
          files = (await readdir(dp, { withFileTypes: true }))
            .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
        } catch { continue }
        for (const f of files) {
          const full = join(dp, f.name)
          const id = f.name.replace(/\.jsonl$/, '')
          try {
            const st = await stat(full)
            const content = await readFile(full, 'utf-8').catch(() => '')
            let preview = ''
            let count = 0
            for (const line of content.split('\n')) {
              if (!line.trim()) continue
              count++
              if (!preview) {
                try {
                  const entry = JSON.parse(line)
                  if (entry?.type === 'user' && typeof entry?.payload?.content === 'string') {
                    preview = entry.payload.content.split('\n')[0].slice(0, 120)
                  }
                } catch { /* skip */ }
              }
            }
            results.push({
              sdkSessionId: id,
              timestamp: st.mtimeMs,
              preview: preview || `(${id.slice(0, 8)}...)`,
              messageCount: count,
            })
          } catch { /* skip */ }
        }
      }
    }
  }
  results.sort((a, b) => b.timestamp - a.timestamp)
  return results.slice(0, 50)
}

// --- handlers --------------------------------------------------------------

registerHandler('openai.getApiKeyStatus', async () => ({ hasKey: !!(await loadOpenAIKey()) }))
registerHandler('openai.setApiKey', async (params) => {
  if (typeof params?.apiKey !== 'string') {
    throw new Error('openai.setApiKey: missing apiKey')
  }
  return setOpenAIKey(params.apiKey)
})
registerHandler('openai.clearApiKey', async () => clearOpenAIKey())
registerHandler('openai.listSessions', async () => listOpenAISessions())
registerHandler('openai.compactNow', async (params) => {
  if (typeof params?.sessionId !== 'string' || !params.sessionId) {
    throw new Error('openai.compactNow: missing sessionId')
  }
  return false
})
