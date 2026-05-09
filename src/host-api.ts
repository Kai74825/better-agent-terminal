// Host API adapter.
//
// Renderer code should import { host } from this module instead of reading
// window.batAppAPI directly. The adapter currently delegates straight to
// window.batAppAPI under Electron; once a Tauri host is wired up the same
// surface will route to invoke()/listen() without renderer-side changes.
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

// The Tauri stub never changes shape so we lazily memoise it; the Electron
// API is resolved on every access so renderer reloads (or test scenarios
// that swap `window`) pick up the fresh reference without a manual reset.
let tauriStub: BatAppAPI | null = null

function resolveHost(): BatAppAPI {
  const kind = getHostKind()
  if (kind === 'electron') {
    const api = (globalThis as unknown as { window?: { batAppAPI?: BatAppAPI } }).window?.batAppAPI
    if (!api) throw new Error('host-api: electron runtime detected but window.batAppAPI is missing')
    return api
  }
  if (kind === 'tauri') {
    if (!tauriStub) tauriStub = createTauriHostStub()
    return tauriStub
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

// --- Tauri stub --------------------------------------------------------------
// A real Tauri implementation will be filled in incrementally. For now we
// surface a stub that errors loudly on any method access; the renderer should
// gate Tauri-only paths via isTauri()/isElectron() until coverage lands.

function notImplemented(name: string): never {
  throw new Error(`host-api: ${name} is not yet implemented under Tauri`)
}

function createTauriHostStub(): BatAppAPI {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      const key = String(prop)
      // Synthesise nested namespaces so callers like host.shell.openExternal()
      // still throw a useful error instead of "Cannot read properties of
      // undefined".
      return new Proxy({}, {
        get(_t, sub) {
          notImplemented(`${key}.${String(sub)}`)
        },
      })
    },
  }
  // The proxy intentionally lies about its shape so TS-level callers compile.
  return new Proxy({}, handler) as BatAppAPI
}
