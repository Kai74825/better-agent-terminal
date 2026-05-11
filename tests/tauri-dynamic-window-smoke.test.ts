// Smoke test for Tauri dynamic window creation.
//
// This launches the built Tauri executable with a test-only env hook that
// opens a profile window through the same Rust window-registry path as Ctrl+N.
// It then watches Tauri's debug.log for the dynamic window lifecycle markers.
//
// Run with:
//   TAURI_PROFILE=debug pnpm run test:tauri-dynamic-window-smoke

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const exePath = resolve(
  'src-tauri',
  'target',
  process.env.TAURI_PROFILE === 'debug' ? 'debug' : 'release',
  process.platform === 'win32' ? 'better-agent-terminal.exe' : 'better-agent-terminal',
)

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function appDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) throw new Error('APPDATA is not set')
    return join(appData, 'com.tonyq.better-agent-terminal')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'com.tonyq.better-agent-terminal')
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'com.tonyq.better-agent-terminal')
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
}

function readLog(logPath: string): string {
  if (!existsSync(logPath)) return ''
  return readFileSync(logPath, 'utf8')
}

async function waitFor(
  label: string,
  fn: () => string | null,
  timeoutMs = 15_000,
): Promise<string> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = fn()
    if (value) return value
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function run(): Promise<void> {
  if (!existsSync(exePath)) {
    console.log(`tauri-dynamic-window-smoke: skipped — exe not found at ${exePath}`)
    return
  }

  const token = `dyn-${Date.now()}-${process.pid}`
  const logPath = join(appDataDir(), 'logs', 'debug.log')
  const proc = spawn(exePath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      BAT_TAURI_DYNAMIC_WINDOW_SMOKE_TOKEN: token,
    },
  })
  let stderr = ''
  let exitedEarly: number | null = null
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  proc.stdout?.on('data', () => { /* drain */ })
  proc.on('exit', code => {
    if (exitedEarly === null) exitedEarly = code ?? -1
  })

  try {
    const requestLine = await waitFor('dynamic window request log', () => {
      const match = readLog(logPath).match(new RegExp(`\\[window-smoke:${token}\\] requested label=([^\\s]+)`))
      return match?.[1] ?? null
    })
    const windowLabel = requestLine

    await waitFor(`created log for ${windowLabel}`, () =>
      readLog(logPath).includes(`[window] created label=${windowLabel}`) ? 'created' : null,
    )
    await waitFor(`page-load Finished log for ${windowLabel}`, () => {
      const log = readLog(logPath)
      return log.includes(`[window] page-load label=${windowLabel} event=Finished`) ? 'finished' : null
    })

    if (exitedEarly !== null) {
      throw new Error(`tauri-dynamic-window-smoke: exe exited early with code ${exitedEarly}; stderr=${stderr}`)
    }
    if (/thread '[^']*' panicked/.test(stderr)) {
      throw new Error(`tauri-dynamic-window-smoke: panic detected on stderr:\n${stderr}`)
    }

    console.log(`tauri-dynamic-window-smoke: passed (${windowLabel})`)
  } finally {
    if (proc.pid) killTree(proc.pid)
    await sleep(500)
  }
}

run().catch(err => {
  console.error(err)
  process.exitCode = 1
})
