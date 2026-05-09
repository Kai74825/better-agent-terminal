// Host API adapter.
//
// Renderer code should import { host } from this module instead of reading
// window.batAppAPI directly. The adapter delegates straight to
// window.batAppAPI under Electron and routes ported namespaces through
// tauri-invoke commands under Tauri. Anything that isn't ported yet
// throws a clear "not yet implemented" error so missing coverage fails
// loudly instead of silently no-oping.
//
// Runtime selection happens via getHostKind() — Electron is detected by the
// presence of window.batAppAPI, Tauri by window.__TAURI_INTERNALS__ (the
// stable detection hook for tauri 2.x; we also accept the legacy __TAURI__
// global so older shells keep working). Neither implies the other; we never
// fall back silently.

// Pull the surface type from the global declaration (src/types/electron.d.ts)
// rather than importing it directly from electron/preload, so we don't drag
// the renderer tsconfig into a project reference rebuild every time the
// preload changes.
type BatAppAPI = Window['batAppAPI']

export type HostKind = 'electron' | 'tauri' | 'unknown'

interface TauriInternals { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }

export function getHostKind(): HostKind {
  if (typeof globalThis === 'undefined') return 'unknown'
  const g = globalThis as unknown as { window?: unknown }
  const win = g.window as (TauriInternals & { batAppAPI?: unknown }) | undefined
  if (!win) return 'unknown'
  if (win.batAppAPI) return 'electron'
  if (win.__TAURI_INTERNALS__ !== undefined || win.__TAURI__ !== undefined) return 'tauri'
  return 'unknown'
}

export const isElectron = (): boolean => getHostKind() === 'electron'
export const isTauri = (): boolean => getHostKind() === 'tauri'

// The Tauri impl never changes shape so we lazily memoise it; the Electron
// API is resolved on every access so renderer reloads (or test scenarios
// that swap `window`) pick up the fresh reference without a manual reset.
let tauriImpl: BatAppAPI | null = null

function resolveHost(): BatAppAPI {
  const kind = getHostKind()
  if (kind === 'electron') {
    const api = (globalThis as unknown as { window?: { batAppAPI?: BatAppAPI } }).window?.batAppAPI
    if (!api) throw new Error('host-api: electron runtime detected but window.batAppAPI is missing')
    return api
  }
  if (kind === 'tauri') {
    if (!tauriImpl) tauriImpl = createTauriHost()
    return tauriImpl
  }
  throw new Error('host-api: no host runtime detected (neither Electron nor Tauri)')
}

// Single proxy so callers can keep a stable reference. Property reads forward
// to the resolved host object on each access — cheap, and safe across HMR
// reloads where the underlying impl might be swapped.
export const host: BatAppAPI = new Proxy({} as BatAppAPI, {
  get(_target, prop) {
    const target = resolveHost() as unknown as Record<string | symbol, unknown>
    return target[prop]
  },
}) as BatAppAPI

// --- Tauri implementation ----------------------------------------------------
//
// Each ported namespace lives in its own factory so adding the next one is a
// localised change. Anything unported delegates to a "not implemented" stub.

function notImplemented(name: string): never {
  throw new Error(`host-api: ${name} is not yet implemented under Tauri`)
}

// We import @tauri-apps/api lazily so nothing in this module pulls Tauri's
// runtime when we're under Electron — the tree-shaker can keep it out of the
// renderer bundle entirely if isTauri() is never true at build time.
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
function getInvoke(): Invoke {
  // Resolved synchronously through the Tauri-injected window global. We do
  // NOT cache because the global gets swapped during HMR and tests, and
  // the property read is cheap.
  const g = (globalThis as unknown as { window?: { __TAURI_INTERNALS__?: { invoke: Invoke } } }).window
  const direct = g?.__TAURI_INTERNALS__?.invoke
  if (direct) return direct
  throw new Error('host-api: tauri invoke not available; ensure window.__TAURI_INTERNALS__ is present')
}

function createTauriHost(): BatAppAPI {
  // Build a partial implementation: only ported namespaces are real; the rest
  // throw via a Proxy so missing coverage fails loudly.
  const ported: Record<string, unknown> = {
    settings: {
      load: () => getInvoke()<string | null>('settings_load'),
      save: (data: string) => getInvoke()<void>('settings_save', { data }),
      // Not yet ported — defer to Electron-shaped errors so callers see a
      // consistent failure mode.
      getShellPath: () => notImplemented('settings.getShellPath'),
      clearTerminalHistory: () => notImplemented('settings.clearTerminalHistory'),
      detectCx: () => notImplemented('settings.detectCx'),
    },
    shell: {
      openExternal: (url: string) => getInvoke()<void>('shell_open_external', { url }),
      openPath: () => notImplemented('shell.openPath'),
      getPathForFile: () => notImplemented('shell.getPathForFile'),
    },
  }

  return new Proxy({}, {
    get(_target, prop) {
      const key = String(prop)
      if (key in ported) return ported[key]
      // Synthesise a nested namespace proxy so calls like host.foo.bar()
      // produce a useful error instead of TypeError on undefined access.
      return new Proxy({}, {
        get(_t, sub) { notImplemented(`${key}.${String(sub)}`) },
      })
    },
  }) as BatAppAPI
}
