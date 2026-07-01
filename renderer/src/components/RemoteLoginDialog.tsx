import { useCallback, useEffect, useRef, useState } from 'react'

import { host } from '../host-api'

type LoginKind = 'claude' | 'codex'

interface RemoteLoginDialogProps {
  kind: LoginKind
  onClose: () => void
  onSuccess: () => void
}

type Phase = 'starting' | 'awaiting-code' | 'awaiting-approval' | 'submitting' | 'error'

// Sign-in flows against a remote host. Both run the agent CLI on the host and
// surface its sign-in URL so a remote client can authenticate the host without
// a browser there.
//
// - claude: `claude auth login` prints a URL + "paste code" prompt; the user
//   signs in, copies the code the callback page shows, and pastes it back here.
//   See node-sidecar/src/handlers/claude-auth-login.mjs.
// - codex: `codex login --device-auth` prints a URL + one-time code, then polls
//   until the user approves in their browser and exits on its own. No paste-back
//   — we just display both and poll for completion. See
//   codex_app_server::account_login_device_start / _poll.
export function RemoteLoginDialog({ kind, onClose, onSuccess }: Readonly<RemoteLoginDialogProps>) {
  const [phase, setPhase] = useState<Phase>('starting')
  const [url, setUrl] = useState<string>('')
  const [deviceCode, setDeviceCode] = useState<string>('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'url' | 'code' | null>(null)
  const startedRef = useRef(false)
  const stoppedRef = useRef(false)

  const label = kind === 'codex' ? 'Codex' : 'Claude'

  const cancel = useCallback(() => {
    stoppedRef.current = true
    if (kind === 'codex') {
      void host.codex.authLoginDeviceCancel?.().catch(() => { /* best effort */ })
    } else {
      void (host.claude as { authLoginCancel?: () => Promise<unknown> }).authLoginCancel?.()
        .catch(() => { /* best effort */ })
    }
    onClose()
  }, [kind, onClose])

  // Poll the host until the codex device login completes, fails, or times out.
  const pollCodex = useCallback(() => {
    const tick = async () => {
      if (stoppedRef.current) return
      try {
        const res = await host.codex.authLoginDevicePoll()
        if (stoppedRef.current) return
        if (res?.status === 'success') {
          stoppedRef.current = true
          onSuccess()
          onClose()
          return
        }
        if (res?.status === 'error') {
          setError(res.error || 'Login failed.')
          setPhase('error')
          return
        }
      } catch (err) {
        if (stoppedRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
        return
      }
      if (!stoppedRef.current) setTimeout(() => void tick(), 2000)
    }
    setTimeout(() => void tick(), 2000)
  }, [onClose, onSuccess])

  // Kick off the login on mount.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    stoppedRef.current = false

    if (kind === 'codex') {
      // Device-code flow: get URL + code, then poll until the user approves.
      ;(async () => {
        try {
          const res = await host.codex.authLoginDeviceStart()
          if (stoppedRef.current) return
          if (res?.ok && res.url && res.code) {
            setUrl(res.url)
            setDeviceCode(res.code)
            setPhase('awaiting-approval')
            pollCodex()
          } else {
            setError(res?.error || 'Failed to start login on the host.')
            setPhase('error')
          }
        } catch (err) {
          if (stoppedRef.current) return
          setError(err instanceof Error ? err.message : String(err))
          setPhase('error')
        }
      })()
      return () => { stoppedRef.current = true }
    }

    // claude paste-code flow.
    ;(async () => {
      try {
        const api = host.claude as { authLoginStart: () => Promise<{ ok?: boolean; url?: string; error?: string }> }
        const res = await api.authLoginStart()
        if (stoppedRef.current) return
        if (res?.ok && res.url) {
          setUrl(res.url)
          setPhase('awaiting-code')
        } else {
          setError(res?.error || 'Failed to start login on the host.')
          setPhase('error')
        }
      } catch (err) {
        if (stoppedRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    })()
    return () => { stoppedRef.current = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  const submit = useCallback(async () => {
    const trimmed = code.trim()
    if (!trimmed) return
    setPhase('submitting')
    setError(null)
    try {
      const api = host.claude as { authLoginSubmitCode: (c: string) => Promise<{ success?: boolean; error?: string }> }
      const res = await api.authLoginSubmitCode(trimmed)
      if (res?.success) {
        onSuccess()
        onClose()
        return
      }
      setError(res?.error || 'Login failed.')
      setPhase('awaiting-code')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('awaiting-code')
    }
  }, [code, onClose, onSuccess])

  const copy = useCallback((value: string, which: 'url' | 'code') => {
    if (!value) return
    void navigator.clipboard?.writeText(value).then(
      () => { setCopied(which); setTimeout(() => setCopied(null), 1500) },
      () => { /* ignore */ },
    )
  }, [])

  const openUrl = useCallback(() => {
    if (url) void host.shell?.openExternal?.(url).catch(() => { /* ignore */ })
  }, [url])

  const urlBox = (
    <div
      className="dialog-login-url"
      style={{
        wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12,
        background: 'var(--bg-secondary)', padding: '8px 10px', borderRadius: 6,
        border: '1px solid var(--border-color, #333)', marginBottom: 8,
      }}
    >
      {url}
    </div>
  )

  return (
    <div className="dialog-overlay" onClick={cancel}>
      <div className="dialog" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h3>Sign in to {label} on the remote host</h3>

        {phase === 'starting' && (
          <p>Starting login on the host…</p>
        )}

        {phase === 'error' && (
          <p style={{ color: 'var(--text-error, #e06c75)' }}>{error}</p>
        )}

        {/* codex device-code flow */}
        {kind === 'codex' && phase === 'awaiting-approval' && (
          <>
            <p>
              1. Open this URL in your browser and sign in. 2. Enter the one-time
              code below when prompted. This dialog completes automatically once
              you approve.
            </p>
            {urlBox}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="dialog-btn secondary" onClick={openUrl} type="button">Open in browser</button>
              <button className="dialog-btn secondary" onClick={() => copy(url, 'url')} type="button">{copied === 'url' ? 'Copied!' : 'Copy URL'}</button>
            </div>
            <p style={{ marginBottom: 4 }}>One-time code:</p>
            <div
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                fontFamily: 'monospace', fontSize: 20, letterSpacing: 2,
                background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 6,
                border: '1px solid var(--border-color, #333)', marginBottom: 12,
              }}
            >
              <span>{deviceCode}</span>
              <button className="dialog-btn secondary" onClick={() => copy(deviceCode, 'code')} type="button">{copied === 'code' ? 'Copied!' : 'Copy'}</button>
            </div>
            <p style={{ opacity: 0.7, fontSize: 13 }}>Waiting for you to approve in the browser…</p>
          </>
        )}

        {/* claude paste-code flow */}
        {kind === 'claude' && (phase === 'awaiting-code' || phase === 'submitting') && (
          <>
            <p>
              1. Open this URL in your browser and sign in. 2. Copy the code the page shows.
              3. Paste it below.
            </p>
            {urlBox}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="dialog-btn secondary" onClick={openUrl} type="button">Open in browser</button>
              <button className="dialog-btn secondary" onClick={() => copy(url, 'url')} type="button">{copied === 'url' ? 'Copied!' : 'Copy URL'}</button>
            </div>
            <input
              className="dialog-input"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                border: '1px solid var(--border-color, #333)', borderRadius: 6, marginBottom: 4,
              }}
              type="text"
              placeholder="Paste authorization code"
              value={code}
              autoFocus
              disabled={phase === 'submitting'}
              onChange={e => setCode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void submit() }}
            />
            {error && <p style={{ color: 'var(--text-error, #e06c75)', marginTop: 4 }}>{error}</p>}
          </>
        )}

        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={cancel} type="button">Cancel</button>
          {kind === 'claude' && (phase === 'awaiting-code' || phase === 'submitting') && (
            <button
              className="dialog-btn confirm"
              onClick={() => void submit()}
              disabled={phase === 'submitting' || !code.trim()}
              type="button"
            >
              {phase === 'submitting' ? 'Signing in…' : 'Sign in'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
