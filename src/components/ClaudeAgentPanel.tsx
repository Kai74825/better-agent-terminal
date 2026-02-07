import { useState, useEffect, useRef, useCallback } from 'react'
import type { ClaudeMessage, ClaudeToolCall } from '../types/claude-agent'
import { isToolCall } from '../types/claude-agent'

interface SessionMeta {
  model?: string
  sdkSessionId?: string
  cwd?: string
  totalCost: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  numTurns: number
}

interface ClaudeAgentPanelProps {
  sessionId: string
  cwd: string
  isActive: boolean
}

type MessageItem = ClaudeMessage | ClaudeToolCall

// Track sessions that have been started to prevent duplicate calls across StrictMode remounts
const startedSessions = new Set<string>()

export function ClaudeAgentPanel({ sessionId, cwd, isActive }: Readonly<ClaudeAgentPanelProps>) {
  const [messages, setMessages] = useState<MessageItem[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null)
  const sessionStartedRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, streamingText, scrollToBottom])

  // Subscribe to IPC events
  useEffect(() => {
    const api = window.electronAPI.claude

    const unsubs = [
      api.onMessage((sid: string, msg: unknown) => {
        if (sid !== sessionId) return
        const message = msg as ClaudeMessage
        // On restart, sys-init message arrives again — reset messages
        if (message.id === `sys-init-${sessionId}`) {
          setMessages([message])
          setStreamingText('')
          setIsStreaming(false)
          setSessionMeta(null)
          return
        }
        // Deduplicate by id
        setMessages(prev => {
          if (prev.some(m => m.id === message.id)) return prev
          return [...prev, message]
        })
        setStreamingText('')
      }),

      api.onToolUse((sid: string, tool: unknown) => {
        if (sid !== sessionId) return
        const toolCall = tool as ClaudeToolCall
        setMessages(prev => {
          if (prev.some(m => 'toolName' in m && m.id === toolCall.id)) return prev
          return [...prev, toolCall]
        })
      }),

      api.onToolResult((sid: string, result: unknown) => {
        if (sid !== sessionId) return
        const { id, ...updates } = result as { id: string; status: string; result?: string }
        setMessages(prev => prev.map(m => {
          if ('toolName' in m && m.id === id) {
            return { ...m, ...updates } as ClaudeToolCall
          }
          return m
        }))
      }),

      api.onResult((sid: string, _result: unknown) => {
        if (sid !== sessionId) return
        setIsStreaming(false)
        setStreamingText('')
      }),

      api.onError((sid: string, error: string) => {
        if (sid !== sessionId) return
        setMessages(prev => [...prev, {
          id: `err-${Date.now()}`,
          sessionId: sid,
          role: 'system' as const,
          content: `Error: ${error}`,
          timestamp: Date.now(),
        }])
        setIsStreaming(false)
      }),

      api.onStream((sid: string, data: unknown) => {
        if (sid !== sessionId) return
        const d = data as { text: string }
        setStreamingText(prev => prev + d.text)
      }),

      api.onStatus((sid: string, meta: unknown) => {
        if (sid !== sessionId) return
        setSessionMeta(meta as SessionMeta)
      }),
    ]

    return () => {
      unsubs.forEach(unsub => unsub())
    }
  }, [sessionId])

  // Start session on mount (guarded against StrictMode double-mount)
  useEffect(() => {
    if (!sessionStartedRef.current && !startedSessions.has(sessionId)) {
      sessionStartedRef.current = true
      startedSessions.add(sessionId)
      window.electronAPI.claude.startSession(sessionId, { cwd })
    }
    return () => {
      // Don't remove from startedSessions on unmount — StrictMode will remount
    }
  }, [sessionId, cwd])

  // Focus textarea when active
  useEffect(() => {
    if (isActive) {
      textareaRef.current?.focus()
    }
  }, [isActive])

  const handleSend = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return

    setInput('')
    setIsStreaming(true)
    setStreamingText('')

    // Add user message locally
    setMessages(prev => [...prev, {
      id: `user-${Date.now()}`,
      sessionId,
      role: 'user' as const,
      content: trimmed,
      timestamp: Date.now(),
    }])

    await window.electronAPI.claude.sendMessage(sessionId, trimmed)
  }, [input, isStreaming, sessionId])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const toggleTool = useCallback((id: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const renderMessage = (item: MessageItem, index: number) => {
    if (isToolCall(item)) {
      return (
        <div key={item.id || index} className="claude-tool-card">
          <div
            className="claude-tool-header"
            onClick={() => toggleTool(item.id)}
          >
            <span className={`claude-tool-chevron ${expandedTools.has(item.id) ? 'expanded' : ''}`}>
              &#9654;
            </span>
            <span className="claude-tool-name">{item.toolName}</span>
            <span className={`claude-tool-status ${item.status}`}>
              {item.status === 'running' ? '...' : item.status === 'completed' ? '✓' : '✗'}
            </span>
          </div>
          {expandedTools.has(item.id) && (
            <div className="claude-tool-body">
              <div className="claude-tool-input">
                <div className="claude-tool-label">Input</div>
                <pre>{JSON.stringify(item.input, null, 2)}</pre>
              </div>
              {item.result && (
                <div className="claude-tool-result">
                  <div className="claude-tool-label">Result</div>
                  <pre>{item.result}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )
    }

    const msg = item as ClaudeMessage
    return (
      <div
        key={msg.id || index}
        className={`claude-message claude-message-${msg.role}`}
      >
        <div className="claude-message-content">
          {msg.role === 'assistant' ? (
            <div className="claude-markdown">{msg.content}</div>
          ) : (
            <div>{msg.content}</div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="claude-agent-panel">
      <div className="claude-messages">
        {messages.map((item, i) => renderMessage(item, i))}
        {streamingText && (
          <div className="claude-message claude-message-assistant">
            <div className="claude-message-content">
              <div className="claude-markdown">{streamingText}<span className="claude-cursor">|</span></div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {sessionMeta && (
        <div className="claude-status-bar">
          {sessionMeta.model && <span className="claude-status-item" title="Model">{sessionMeta.model}</span>}
          {sessionMeta.sdkSessionId && (
            <span className="claude-status-item" title={sessionMeta.sdkSessionId}>
              {sessionMeta.sdkSessionId.slice(0, 8)}
            </span>
          )}
          {sessionMeta.numTurns > 0 && (
            <span className="claude-status-item" title="Turns">{sessionMeta.numTurns} turns</span>
          )}
          {(sessionMeta.inputTokens > 0 || sessionMeta.outputTokens > 0) && (
            <span className="claude-status-item" title="Tokens (in/out)">
              {sessionMeta.inputTokens.toLocaleString()} / {sessionMeta.outputTokens.toLocaleString()} tok
            </span>
          )}
          {sessionMeta.totalCost > 0 && (
            <span className="claude-status-item" title="Total cost">${sessionMeta.totalCost.toFixed(4)}</span>
          )}
          {sessionMeta.durationMs > 0 && (
            <span className="claude-status-item" title="Duration">{(sessionMeta.durationMs / 1000).toFixed(1)}s</span>
          )}
        </div>
      )}

      <div className="claude-input-area">
        <textarea
          ref={textareaRef}
          className="claude-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? 'Waiting for response...' : 'Type a message... (Enter to send, Shift+Enter for newline)'}
          disabled={isStreaming}
          rows={1}
        />
        <button
          className="claude-send-btn"
          onClick={handleSend}
          disabled={isStreaming || !input.trim()}
          title="Send message"
        >
          ▶
        </button>
      </div>
    </div>
  )
}
