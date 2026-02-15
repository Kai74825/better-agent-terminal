import { useState, useEffect } from 'react'
import type { AppSettings, ShellType, FontType, ColorPresetId } from '../types'
import { FONT_OPTIONS, COLOR_PRESETS, SHELL_OPTIONS } from '../types'
import { settingsStore } from '../stores/settings-store'
import { EnvVarEditor } from './EnvVarEditor'
import { AGENT_PRESETS, AgentPresetId } from '../types/agent-presets'

interface SettingsPanelProps {
  onClose: () => void
}

// Check if a font is available using CSS Font Loading API
const checkFontAvailable = (fontFamily: string): boolean => {
  // Extract the primary font name (first in the list)
  const fontName = fontFamily.split(',')[0].trim().replace(/['"]/g, '')
  if (fontName === 'monospace') return true

  try {
    return document.fonts.check(`12px "${fontName}"`)
  } catch {
    return false
  }
}

interface RemoteServerStatus {
  running: boolean
  port: number | null
  clients: { label: string; connectedAt: number }[]
}

interface RemoteClientStatus {
  connected: boolean
  info: { host: string; port: number } | null
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<AppSettings>(settingsStore.getSettings())
  const [availableFonts, setAvailableFonts] = useState<Set<FontType>>(new Set())

  // Remote server state
  const [serverStatus, setServerStatus] = useState<RemoteServerStatus>({ running: false, port: null, clients: [] })
  const [serverPort, setServerPort] = useState('9876')
  const [serverToken, setServerToken] = useState<string | null>(null)
  const [clientStatus, setClientStatus] = useState<RemoteClientStatus>({ connected: false, info: null })

  // Get current platform for filtering shell options
  const platform = window.electronAPI?.platform || 'darwin'
  const platformShellOptions = SHELL_OPTIONS.filter(opt => opt.platforms.includes(platform))

  useEffect(() => {
    return settingsStore.subscribe(() => {
      setSettings(settingsStore.getSettings())
    })
  }, [])

  // Check font availability on mount
  useEffect(() => {
    const checkFonts = async () => {
      // Wait for fonts to be loaded
      await document.fonts.ready

      const available = new Set<FontType>()
      for (const font of FONT_OPTIONS) {
        if (font.id === 'system' || font.id === 'custom' || checkFontAvailable(font.fontFamily)) {
          available.add(font.id)
        }
      }
      setAvailableFonts(available)
    }
    checkFonts()
  }, [])

  const handleShellChange = (shell: ShellType) => {
    settingsStore.setShell(shell)
  }

  const handleCustomPathChange = (path: string) => {
    settingsStore.setCustomShellPath(path)
  }

  const handleFontSizeChange = (size: number) => {
    settingsStore.setFontSize(size)
  }

  const handleFontFamilyChange = (fontFamily: FontType) => {
    settingsStore.setFontFamily(fontFamily)
  }

  const handleCustomFontFamilyChange = (customFontFamily: string) => {
    settingsStore.setCustomFontFamily(customFontFamily)
  }

  const handleColorPresetChange = (colorPreset: ColorPresetId) => {
    settingsStore.setColorPreset(colorPreset)
  }

  const handleCustomBackgroundColorChange = (color: string) => {
    settingsStore.setCustomBackgroundColor(color)
  }

  const handleCustomForegroundColorChange = (color: string) => {
    settingsStore.setCustomForegroundColor(color)
  }

  const handleCustomCursorColorChange = (color: string) => {
    settingsStore.setCustomCursorColor(color)
  }

  // Load remote status on mount and poll
  useEffect(() => {
    const refresh = async () => {
      const ss = await window.electronAPI.remote.serverStatus()
      setServerStatus(ss)
      const cs = await window.electronAPI.remote.clientStatus()
      setClientStatus(cs)
    }
    refresh()
    const interval = setInterval(refresh, 3000)
    return () => clearInterval(interval)
  }, [])

  const handleStartServer = async () => {
    const result = await window.electronAPI.remote.startServer(parseInt(serverPort) || 9876)
    if ('error' in result) {
      alert(`Failed to start server: ${result.error}`)
    } else {
      setServerToken(result.token)
      setServerPort(String(result.port))
    }
    const ss = await window.electronAPI.remote.serverStatus()
    setServerStatus(ss)
  }

  const handleStopServer = async () => {
    await window.electronAPI.remote.stopServer()
    setServerToken(null)
    const ss = await window.electronAPI.remote.serverStatus()
    setServerStatus(ss)
  }

  const terminalColors = settingsStore.getTerminalColors()

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-content">
          <div className="settings-section">
            <h3>Shell</h3>
            <div className="settings-group">
              <label>Default Shell</label>
              <select
                value={settings.shell}
                onChange={e => handleShellChange(e.target.value as ShellType)}
              >
                {platformShellOptions.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.name}</option>
                ))}
              </select>
            </div>

            {settings.shell === 'custom' && (
              <div className="settings-group">
                <label>Custom Shell Path</label>
                <input
                  type="text"
                  value={settings.customShellPath}
                  onChange={e => handleCustomPathChange(e.target.value)}
                  placeholder={platform === 'win32' ? 'C:\\path\\to\\shell.exe' : '/path/to/shell'}
                />
              </div>
            )}

            <div className="settings-group">
              <label>Default Terminals per Workspace: {settings.defaultTerminalCount || 1}</label>
              <input
                type="range"
                min="1"
                max="5"
                value={settings.defaultTerminalCount || 1}
                onChange={e => settingsStore.setDefaultTerminalCount(Number(e.target.value))}
              />
            </div>

            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.createDefaultAgentTerminal === true}
                  onChange={e => settingsStore.setCreateDefaultAgentTerminal(e.target.checked)}
                />
                Create Agent Terminal by default
              </label>
              <p className="settings-hint">When enabled, new workspaces will include an Agent Terminal.</p>
            </div>

            {settings.createDefaultAgentTerminal && (
              <>
                <div className="settings-group">
                  <label>Default Agent</label>
                  <select
                    value={settings.defaultAgent || 'claude-code'}
                    onChange={e => settingsStore.setDefaultAgent(e.target.value as AgentPresetId)}
                  >
                    {AGENT_PRESETS.filter(p => p.id !== 'none').map(preset => (
                      <option key={preset.id} value={preset.id}>
                        {preset.icon} {preset.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.agentAutoCommand === true}
                      onChange={e => settingsStore.setAgentAutoCommand(e.target.checked)}
                    />
                    Auto-run agent command
                  </label>
                  <p className="settings-hint">Automatically execute the agent command (e.g., `claude`) when creating an Agent Terminal.</p>
                </div>
              </>
            )}

            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.allowBypassPermissions === true}
                  onChange={e => settingsStore.setAllowBypassPermissions(e.target.checked)}
                />
                Allow bypass permissions without confirmation
              </label>
              <p className="settings-hint">When enabled, switching to bypassPermissions mode in Claude Agent Panel will not show a confirmation dialog. Use with caution.</p>
            </div>
          </div>

          <div className="settings-section">
            <h3>Appearance</h3>
            <div className="settings-group">
              <label>Font Size: {settings.fontSize}px</label>
              <input
                type="range"
                min="10"
                max="24"
                value={settings.fontSize}
                onChange={e => handleFontSizeChange(Number(e.target.value))}
              />
            </div>

            <div className="settings-group">
              <label>Font Family</label>
              <select
                value={settings.fontFamily}
                onChange={e => handleFontFamilyChange(e.target.value as FontType)}
              >
                {FONT_OPTIONS.map(font => (
                  <option key={font.id} value={font.id} disabled={!availableFonts.has(font.id) && font.id !== 'custom'}>
                    {font.name} {availableFonts.has(font.id) ? '✓' : '(not installed)'}
                  </option>
                ))}
              </select>
            </div>

            {settings.fontFamily === 'custom' && (
              <div className="settings-group">
                <label>Custom Font Name</label>
                <input
                  type="text"
                  value={settings.customFontFamily}
                  onChange={e => handleCustomFontFamilyChange(e.target.value)}
                  placeholder="e.g., Fira Code, JetBrains Mono"
                />
              </div>
            )}

            <div className="settings-group">
              <label>Color Theme</label>
              <select
                value={settings.colorPreset}
                onChange={e => handleColorPresetChange(e.target.value as ColorPresetId)}
              >
                {COLOR_PRESETS.map(preset => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </div>

            {settings.colorPreset === 'custom' && (
              <>
                <div className="settings-group color-picker-group">
                  <label>Background Color</label>
                  <div className="color-input-wrapper">
                    <input
                      type="color"
                      value={settings.customBackgroundColor}
                      onChange={e => handleCustomBackgroundColorChange(e.target.value)}
                    />
                    <input
                      type="text"
                      value={settings.customBackgroundColor}
                      onChange={e => handleCustomBackgroundColorChange(e.target.value)}
                      placeholder="#1f1d1a"
                    />
                  </div>
                </div>

                <div className="settings-group color-picker-group">
                  <label>Text Color</label>
                  <div className="color-input-wrapper">
                    <input
                      type="color"
                      value={settings.customForegroundColor}
                      onChange={e => handleCustomForegroundColorChange(e.target.value)}
                    />
                    <input
                      type="text"
                      value={settings.customForegroundColor}
                      onChange={e => handleCustomForegroundColorChange(e.target.value)}
                      placeholder="#dfdbc3"
                    />
                  </div>
                </div>

                <div className="settings-group color-picker-group">
                  <label>Cursor Color</label>
                  <div className="color-input-wrapper">
                    <input
                      type="color"
                      value={settings.customCursorColor}
                      onChange={e => handleCustomCursorColorChange(e.target.value)}
                    />
                    <input
                      type="text"
                      value={settings.customCursorColor}
                      onChange={e => handleCustomCursorColorChange(e.target.value)}
                      placeholder="#dfdbc3"
                    />
                  </div>
                </div>
              </>
            )}

            <div className="settings-group font-preview">
              <label>Preview</label>
              <div
                className="font-preview-box"
                style={{
                  fontFamily: settingsStore.getFontFamilyString(),
                  fontSize: settings.fontSize,
                  backgroundColor: terminalColors.background,
                  color: terminalColors.foreground
                }}
              >
                $ echo "Hello World" 你好世界 0123456789
              </div>
            </div>
          </div>

          <div className="settings-section">
            <h3>Environment Variables</h3>
            <p className="settings-hint" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              Global environment variables applied to ALL workspaces. Workspace-specific variables (⚙ button) will override these.
            </p>
            <EnvVarEditor
              envVars={settings.globalEnvVars || []}
              onAdd={(envVar) => settingsStore.addGlobalEnvVar(envVar)}
              onRemove={(key) => settingsStore.removeGlobalEnvVar(key)}
              onUpdate={(key, updates) => settingsStore.updateGlobalEnvVar(key, updates)}
            />
          </div>
          <div className="settings-section">
            <h3>Remote Access</h3>
            <p className="settings-hint" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              Allow other Better Agent Terminal instances on your LAN to connect and control this instance.
            </p>

            {serverStatus.running ? (
              <>
                <div className="settings-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#3fb950', fontSize: 12 }}>Server running on port {serverStatus.port}</span>
                  <button className="profile-action-btn danger" onClick={handleStopServer} style={{ marginLeft: 'auto' }}>
                    Stop Server
                  </button>
                </div>
                {serverToken && (
                  <div className="settings-group">
                    <label>Connection Token</label>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="text"
                        readOnly
                        value={serverToken}
                        style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }}
                        onClick={e => (e.target as HTMLInputElement).select()}
                      />
                      <button
                        className="profile-action-btn"
                        onClick={() => navigator.clipboard.writeText(serverToken)}
                        title="Copy token"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                )}
                {serverStatus.clients.length > 0 && (
                  <div className="settings-group">
                    <label>Connected Clients ({serverStatus.clients.length})</label>
                    {serverStatus.clients.map((c, i) => (
                      <div key={i} style={{ fontSize: 12, color: '#aaa', padding: '2px 0' }}>
                        {c.label} — connected {new Date(c.connectedAt).toLocaleTimeString()}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="settings-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="number"
                  value={serverPort}
                  onChange={e => setServerPort(e.target.value)}
                  placeholder="Port"
                  style={{ width: 80 }}
                />
                <button className="profile-action-btn primary" onClick={handleStartServer}>
                  Start Server
                </button>
              </div>
            )}

            {clientStatus.connected && clientStatus.info && (
              <div className="settings-group" style={{ marginTop: 8 }}>
                <span style={{ color: '#58a6ff', fontSize: 12 }}>
                  Connected to remote: {clientStatus.info.host}:{clientStatus.info.port}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="settings-footer">
          <p className="settings-note">Changes are saved automatically. Font changes apply immediately to all terminals.</p>
        </div>
      </div>
    </div>
  )
}
