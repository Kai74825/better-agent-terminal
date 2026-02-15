import { useState, useEffect, useRef, useCallback } from 'react'

interface ProfileEntry {
  id: string
  name: string
  type: 'local' | 'remote'
  remoteHost?: string
  remotePort?: number
  remoteToken?: string
  createdAt: number
  updatedAt: number
}

interface ProfilePanelProps {
  onClose: () => void
  onSwitch: (profileId: string) => void
}

export function ProfilePanel({ onClose, onSwitch }: ProfilePanelProps) {
  const [profiles, setProfiles] = useState<ProfileEntry[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string>('default')
  const [creating, setCreating] = useState<'local' | 'remote' | false>(false)
  const [newName, setNewName] = useState('')
  const [remoteHost, setRemoteHost] = useState('')
  const [remotePort, setRemotePort] = useState('9876')
  const [remoteToken, setRemoteToken] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null)
  const createInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  const loadProfiles = useCallback(async () => {
    const result = await window.electronAPI.profile.list()
    setProfiles(result.profiles)
    setActiveProfileId(result.activeProfileId)
  }, [])

  useEffect(() => {
    loadProfiles()
  }, [loadProfiles])

  useEffect(() => {
    if (creating && createInputRef.current) {
      createInputRef.current.focus()
    }
  }, [creating])

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (creating) { setCreating(false); setNewName('') }
        else if (editingId) { setEditingId(null); setEditValue('') }
        else if (confirmDelete) { setConfirmDelete(null) }
        else if (confirmSwitch) { setConfirmSwitch(null) }
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [creating, editingId, confirmDelete, confirmSwitch, onClose])

  const handleCreate = async () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    if (creating === 'remote') {
      if (!remoteHost.trim() || !remoteToken.trim()) return
      await window.electronAPI.profile.create(trimmed, {
        type: 'remote',
        remoteHost: remoteHost.trim(),
        remotePort: parseInt(remotePort) || 9876,
        remoteToken: remoteToken.trim(),
      })
    } else {
      await window.electronAPI.profile.create(trimmed)
    }
    setCreating(false)
    setNewName('')
    setRemoteHost('')
    setRemotePort('9876')
    setRemoteToken('')
    loadProfiles()
  }

  const handleRename = async (profileId: string) => {
    const trimmed = editValue.trim()
    if (!trimmed) { setEditingId(null); return }
    await window.electronAPI.profile.rename(profileId, trimmed)
    setEditingId(null)
    setEditValue('')
    loadProfiles()
  }

  const handleDelete = async (profileId: string) => {
    await window.electronAPI.profile.delete(profileId)
    setConfirmDelete(null)
    loadProfiles()
  }

  const handleDuplicate = async (profileId: string) => {
    const source = profiles.find(p => p.id === profileId)
    if (!source) return
    await window.electronAPI.profile.duplicate(profileId, `${source.name} (Copy)`)
    loadProfiles()
  }

  const handleSaveCurrent = async () => {
    await window.electronAPI.profile.save(activeProfileId)
    loadProfiles()
  }

  const handleSwitchRequest = (profileId: string) => {
    if (profileId === activeProfileId) return
    setConfirmSwitch(profileId)
  }

  const handleSwitchConfirm = async (saveFirst: boolean) => {
    if (!confirmSwitch) return
    if (saveFirst) {
      await window.electronAPI.profile.save(activeProfileId)
    }
    setConfirmSwitch(null)
    onSwitch(confirmSwitch)
  }

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleString()
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="settings-header">
          <h2>Profiles</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>
        <div className="settings-body" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button className="profile-action-btn" onClick={handleSaveCurrent} title="Save current workspaces to active profile">
              Save Current
            </button>
            <button className="profile-action-btn" onClick={() => { setCreating('local'); setNewName('') }}>
              + Local
            </button>
            <button className="profile-action-btn" onClick={() => { setCreating('remote'); setNewName('') }}>
              + Remote
            </button>
          </div>

          {creating && (
            <div className="profile-create-row" style={{ flexDirection: 'column', gap: 8 }}>
              <input
                ref={createInputRef}
                type="text"
                className="profile-name-input"
                placeholder="Profile name..."
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && creating === 'local') handleCreate()
                  if (e.key === 'Escape') { setCreating(false); setNewName('') }
                }}
              />
              {creating === 'remote' && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    className="profile-name-input"
                    placeholder="Host (e.g. 192.168.1.100)"
                    value={remoteHost}
                    onChange={e => setRemoteHost(e.target.value)}
                    style={{ flex: '1 1 120px' }}
                  />
                  <input
                    type="number"
                    className="profile-name-input"
                    placeholder="Port"
                    value={remotePort}
                    onChange={e => setRemotePort(e.target.value)}
                    style={{ width: 70 }}
                  />
                  <input
                    type="text"
                    className="profile-name-input"
                    placeholder="Token"
                    value={remoteToken}
                    onChange={e => setRemoteToken(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
                    style={{ flex: '1 1 160px' }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="profile-action-btn" onClick={handleCreate}>Create</button>
                <button className="profile-action-btn" onClick={() => { setCreating(false); setNewName('') }}>Cancel</button>
              </div>
            </div>
          )}

          <div className="profile-list">
            {profiles.map(profile => (
              <div
                key={profile.id}
                className={`profile-item ${profile.id === activeProfileId ? 'active' : ''}`}
                onClick={() => handleSwitchRequest(profile.id)}
              >
                <div className="profile-item-info">
                  {editingId === profile.id ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      className="profile-name-input"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onBlur={() => handleRename(profile.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRename(profile.id)
                        if (e.key === 'Escape') { setEditingId(null); setEditValue('') }
                      }}
                      onClick={e => e.stopPropagation()}
                    />
                  ) : (
                    <>
                      <span className="profile-item-name">
                        {profile.id === activeProfileId && <span className="profile-active-dot" />}
                        {profile.name}
                        {(profile.type === 'remote') && (
                          <span style={{ fontSize: 10, color: '#58a6ff', marginLeft: 6, opacity: 0.8 }}>REMOTE</span>
                        )}
                      </span>
                      <span className="profile-item-meta">
                        {profile.type === 'remote'
                          ? `${profile.remoteHost}:${profile.remotePort}`
                          : `Updated ${formatDate(profile.updatedAt)}`}
                      </span>
                    </>
                  )}
                </div>
                <div className="profile-item-actions" onClick={e => e.stopPropagation()}>
                  <button
                    className="profile-icon-btn"
                    title="Rename"
                    onClick={() => { setEditingId(profile.id); setEditValue(profile.name) }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    className="profile-icon-btn"
                    title="Duplicate"
                    onClick={() => handleDuplicate(profile.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  {profile.id !== 'default' && (
                    <button
                      className="profile-icon-btn danger"
                      title="Delete"
                      onClick={() => setConfirmDelete(profile.id)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <div className="settings-overlay" style={{ zIndex: 1001 }} onClick={() => setConfirmDelete(null)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 360, padding: 20 }}>
            <h3 style={{ margin: '0 0 12px', color: '#e5534b' }}>Delete Profile</h3>
            <p style={{ margin: '0 0 16px', color: '#aaa' }}>
              Are you sure you want to delete "{profiles.find(p => p.id === confirmDelete)?.name}"? This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="profile-action-btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="profile-action-btn danger" onClick={() => handleDelete(confirmDelete)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm switch dialog */}
      {confirmSwitch && (
        <div className="settings-overlay" style={{ zIndex: 1001 }} onClick={() => setConfirmSwitch(null)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 400, padding: 20 }}>
            <h3 style={{ margin: '0 0 12px' }}>Switch Profile</h3>
            <p style={{ margin: '0 0 16px', color: '#aaa' }}>
              Switching profiles will close all terminals and reload workspaces. Save current state first?
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="profile-action-btn" onClick={() => setConfirmSwitch(null)}>Cancel</button>
              <button className="profile-action-btn" onClick={() => handleSwitchConfirm(false)}>Switch Without Saving</button>
              <button className="profile-action-btn primary" onClick={() => handleSwitchConfirm(true)}>Save &amp; Switch</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
