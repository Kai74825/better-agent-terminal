// Unit tests for src/host-api.ts.
//
// Run with: pnpm exec tsx tests/host-api.test.ts
// (or via the test:host-api script).

import * as assert from 'node:assert/strict'

// jsdom-free: we synthesise a globalThis.window that the adapter inspects.
type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
type WinShape = {
  batAppAPI?: unknown
  __TAURI_INTERNALS__?: { invoke?: TauriInvoke }
  __TAURI__?: unknown
}
const setWindow = (shape: WinShape | undefined) => {
  ;(globalThis as { window?: WinShape | undefined }).window = shape
}

// Force a fresh module per scenario so the adapter's cached host gets reset.
async function loadFreshAdapter() {
  const url = new URL('../src/host-api.ts', import.meta.url)
  const cacheBust = `${url.href}?t=${Date.now()}-${Math.random()}`
  return import(cacheBust)
}

async function run() {
  // 1) No window -> getHostKind === 'unknown'
  setWindow(undefined)
  {
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'unknown')
    assert.equal(mod.isElectron(), false)
    assert.equal(mod.isTauri(), false)
    assert.throws(() => (mod.host as { settings: { load: () => unknown } }).settings.load(),
      /no host runtime detected/)
  }

  // 2) Electron detection + delegation
  {
    const calls: string[] = []
    const batAppAPI = {
      settings: {
        load: () => { calls.push('load'); return Promise.resolve('{}') },
      },
      shell: {
        openExternal: (url: string) => { calls.push(`open:${url}`); return Promise.resolve() },
      },
    }
    setWindow({ batAppAPI })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'electron')
    assert.equal(mod.isElectron(), true)
    assert.equal(mod.isTauri(), false)
    await mod.host.settings.load()
    await mod.host.shell.openExternal('https://example.com')
    assert.deepEqual(calls, ['load', 'open:https://example.com'])
  }

  // 3) Tauri detection routes ported namespaces through invoke
  {
    const invokeCalls: { cmd: string; args?: Record<string, unknown> }[] = []
    const invoke: TauriInvoke = async <T>(cmd: string, args?: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args })
      // Mirror Rust return shapes for the commands we care about.
      if (cmd === 'settings_load') return null as unknown as T
      if (cmd === 'settings_save') return undefined as unknown as T
      if (cmd === 'shell_open_external') return undefined as unknown as T
      throw new Error(`unexpected invoke: ${cmd}`)
    }
    setWindow({ __TAURI_INTERNALS__: { invoke } })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'tauri')
    assert.equal(mod.isElectron(), false)
    assert.equal(mod.isTauri(), true)

    const loaded = await mod.host.settings.load()
    assert.equal(loaded, null)

    await mod.host.settings.save('{"theme":"dark"}')
    await mod.host.shell.openExternal('https://example.com')

    assert.deepEqual(invokeCalls, [
      { cmd: 'settings_load', args: undefined },
      { cmd: 'settings_save', args: { data: '{"theme":"dark"}' } },
      { cmd: 'shell_open_external', args: { url: 'https://example.com' } },
    ])
  }

  // 4) Tauri detection still throws "not implemented" for unported namespaces
  {
    const invoke: TauriInvoke = async () => undefined as unknown as never
    setWindow({ __TAURI_INTERNALS__: { invoke } })
    const mod = await loadFreshAdapter()
    assert.throws(() => (mod.host as { pty: { create: () => unknown } }).pty.create(),
      /pty\.create is not yet implemented under Tauri/)
  }

  // 5) Legacy __TAURI__ marker still works (detection only — invoke can't be
  //    resolved without __TAURI_INTERNALS__, so calls error clearly).
  {
    setWindow({ __TAURI__: {} })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'tauri')
    assert.throws(() => (mod.host as { settings: { load: () => unknown } }).settings.load(),
      /tauri invoke not available/)
  }

  // 6) Electron wins when both markers exist
  {
    setWindow({ batAppAPI: { ping: () => 'pong' }, __TAURI_INTERNALS__: { invoke: () => Promise.resolve(null) } })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'electron')
  }

  console.log('host-api: passed')
}

run().catch(err => {
  console.error(err)
  process.exitCode = 1
})
