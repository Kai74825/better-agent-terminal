// remote.* / tunnel.* stubs.
//
// remote/tunnel run the cross-machine server and the LAN/Tailscale
// presence advertiser. Real implementations will land in Phase 3 (or as
// a sibling sidecar). For now we return shapes that match the renderer's
// destructuring contract so polling clientStatus / serverStatus doesn't
// crash when it reads `.connected` / `.running`.

import { registerHandler } from '../lib/protocol.mjs'

const REMOTE_STUB_ERR = 'remote ops not yet wired through Tauri sidecar'

registerHandler('remote.startServer', async () => ({ error: REMOTE_STUB_ERR }))
registerHandler('remote.stopServer', async () => false)
registerHandler('remote.serverStatus', async () => ({
  running: false, port: null, fingerprint: null, bindInterface: null, boundHost: null, clients: [],
}))
registerHandler('remote.connect', async () => ({ error: REMOTE_STUB_ERR }))
registerHandler('remote.disconnect', async () => false)
registerHandler('remote.clientStatus', async () => ({ connected: false, info: null }))
registerHandler('remote.testConnection', async () => ({ ok: false, error: REMOTE_STUB_ERR }))
registerHandler('remote.listProfiles', async () => ({ error: REMOTE_STUB_ERR }))

registerHandler('tunnel.getConnection', async () => ({ error: 'tunnel not yet wired through Tauri sidecar' }))
