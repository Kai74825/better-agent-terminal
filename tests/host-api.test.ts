// Unit tests for src/host-api.ts.
//
// Run with: pnpm exec tsx tests/host-api.test.ts
// (or via the test:host-api script).

import * as assert from 'node:assert/strict'

// jsdom-free: we synthesise a globalThis.window that the adapter inspects.
type WinShape = { batAppAPI?: unknown; __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }
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

  // 3) Tauri detection + stub error
  {
    setWindow({ __TAURI_INTERNALS__: {} })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'tauri')
    assert.equal(mod.isElectron(), false)
    assert.equal(mod.isTauri(), true)
    assert.throws(() => (mod.host as { settings: { load: () => unknown } }).settings.load(),
      /settings\.load is not yet implemented under Tauri/)
  }

  // 4) Legacy __TAURI__ marker still works
  {
    setWindow({ __TAURI__: {} })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'tauri')
  }

  // 5) Electron wins when both markers exist (host already created window)
  {
    setWindow({ batAppAPI: { ping: () => 'pong' }, __TAURI_INTERNALS__: {} })
    const mod = await loadFreshAdapter()
    assert.equal(mod.getHostKind(), 'electron')
  }

  console.log('host-api: passed')
}

run().catch(err => {
  console.error(err)
  process.exitCode = 1
})
