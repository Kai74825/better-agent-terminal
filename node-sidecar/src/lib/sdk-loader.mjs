// Lazy SDK loader. Tries to import @anthropic-ai/claude-agent-sdk once;
// caches the resolved module or null if the import fails (e.g. release
// build without bundled node_modules). Subsequent calls return the
// cached value instantly. This lets feature handlers opportunistically
// use real SDK calls when available and fall back to stubs otherwise.
//
// We expose loadAnthropicSdk for tests so they can stub a fake module
// and verify augmentation paths without depending on the real SDK
// (which spawns the claude CLI on first call).

let _sdkLoadAttempted = false
let _sdkModule = null
let _sdkOverrideSet = false
let _sdkOverride = null

export async function loadAnthropicSdk() {
  if (_sdkOverrideSet) return _sdkOverride
  if (_sdkLoadAttempted) return _sdkModule
  _sdkLoadAttempted = true
  // Escape hatch for tests + dev shells: BAT_SIDECAR_DISABLE_SDK=1
  // forces the SDK-unavailable path even if @anthropic-ai/claude-agent-sdk
  // is importable. The e2e test uses this so claude.sendMessage takes
  // the deterministic stub path instead of trying to call the real API.
  if (process.env.BAT_SIDECAR_DISABLE_SDK === '1') {
    _sdkModule = null
    return null
  }
  try {
    _sdkModule = await import('@anthropic-ai/claude-agent-sdk')
    return _sdkModule
  } catch {
    _sdkModule = null
    return null
  }
}

// Test-only setter — pass an object to swap in a fake SDK, null to
// force the "SDK unavailable" path, undefined to clear the override
// and let normal lazy loading resume.
export function __setSdkOverrideForTests(value) {
  if (value === undefined) {
    _sdkOverrideSet = false
    _sdkOverride = null
  } else {
    _sdkOverrideSet = true
    _sdkOverride = value
  }
}
