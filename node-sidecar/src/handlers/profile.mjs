// profile.* — sidecar-visible profile surface for remote server invokes.
//
// Local Tauri renderer calls profile_* Rust commands directly. The remote
// WebSocket server, however, lives inside the sidecar and dispatches proxied
// `profile:list` frames through JSON-RPC. Keep a minimal default-profile
// implementation here so remote profile discovery works without requiring
// the sidecar to reach back into Rust.

import { registerHandler } from '../lib/protocol.mjs'

export const DEFAULT_PROFILE = {
  id: 'default',
  name: 'Default',
  type: 'local',
  createdAt: 0,
  updatedAt: 0,
}

export function listProfiles() {
  return {
    profiles: [DEFAULT_PROFILE],
    activeProfileIds: ['default'],
  }
}

registerHandler('profile.list', async () => listProfiles())
registerHandler('profile.getActiveIds', async () => ['default'])
registerHandler('profile.load', async () => null)
registerHandler('profile.loadSnapshot', async () => null)
registerHandler('profile.activate', async () => true)
registerHandler('profile.deactivate', async () => true)
