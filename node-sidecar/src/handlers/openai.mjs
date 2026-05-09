// openai.* handlers + the on-disk session lister.
//
// openai.listSessions walks ~/.better-agent-terminal/openai-sessions/
// <yyyy>/<mm>/<dd>/*.jsonl. Mirrors persistence.listAllSessions
// from electron/openai-agent/persistence.ts. The cwd parameter is
// accepted but unused — the Electron impl ignores it too because
// OpenAI sessions aren't grouped by working directory.

import { readdir, stat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { registerHandler } from '../lib/protocol.mjs'

export const OPENAI_SESSIONS_ROOT = join(homedir(), '.better-agent-terminal', 'openai-sessions')

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
  return results
}

// --- handlers --------------------------------------------------------------

registerHandler('openai.getApiKeyStatus', async () => ({ hasKey: false }))
registerHandler('openai.setApiKey', async (params) => {
  if (typeof params?.apiKey !== 'string') {
    throw new Error('openai.setApiKey: missing apiKey')
  }
  return false
})
registerHandler('openai.clearApiKey', async () => true)
registerHandler('openai.listSessions', async () => listOpenAISessions())
registerHandler('openai.compactNow', async (params) => {
  if (typeof params?.sessionId !== 'string' || !params.sessionId) {
    throw new Error('openai.compactNow: missing sessionId')
  }
  return false
})
