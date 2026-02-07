import { useState, useEffect, useRef, useCallback } from 'react'
import type { ClaudeMessage, ClaudeToolCall } from '../types/claude-agent'
import { isToolCall } from '../types/claude-agent'
import { settingsStore } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'

interface SessionMeta {
  model?: string
  sdkSessionId?: string
  cwd?: string
  totalCost: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  numTurns: number
  contextWindow: number
  permissionMode?: string
}

interface ModelInfo {
  value: string
  displayName: string
  description: string
}

interface PendingPermission {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
}

interface AskUserQuestion {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiSelect: boolean
}

interface PendingAskUser {
  toolUseId: string
  questions: AskUserQuestion[]
}

interface SessionSummary {
  sdkSessionId: string
  timestamp: number
  preview: string
  messageCount: number
}

interface ClaudeAgentPanelProps {
  sessionId: string
  cwd: string
  isActive: boolean
  workspaceId?: string
  savedSdkSessionId?: string
}

interface AttachedImage {
  path: string
  dataUrl: string
}

type MessageItem = ClaudeMessage | ClaudeToolCall

// Track sessions that have been started to prevent duplicate calls across StrictMode remounts
const startedSessions = new Set<string>()

export function ClaudeAgentPanel({ sessionId, cwd, isActive, workspaceId, savedSdkSessionId }: Readonly<ClaudeAgentPanelProps>) {
  const [messages, setMessages] = useState<MessageItem[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [showThinking, setShowThinking] = useState(false)
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
  const [autoExpandThinking, setAutoExpandThinking] = useState(false)
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null)
  const [permissionMode, setPermissionMode] = useState<string>('default')
  const [currentModel, setCurrentModel] = useState<string>('')
  // const [effortLevel, setEffortLevel] = useState<string>('medium') // hidden until SDK supports per-model effort
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [permissionFocus, setPermissionFocus] = useState(0) // 0=Yes, 1=Yes always, 2=No, 3=custom text
  const [permissionCustomText, setPermissionCustomText] = useState('')
  const [pendingQuestion, setPendingQuestion] = useState<PendingAskUser | null>(null)
  const [askAnswers, setAskAnswers] = useState<Record<string, string>>({})
  const [askOtherText, setAskOtherText] = useState<Record<string, string>>({})
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [showResumeList, setShowResumeList] = useState(false)
  const [resumeSessions, setResumeSessions] = useState<SessionSummary[]>([])
  const [resumeLoading, setResumeLoading] = useState(false)
  const [showModelList, setShowModelList] = useState(false)
  const historyLoadedRef = useRef(false)
  const sessionStartedRef = useRef(false)
  const inputHistoryRef = useRef<string[]>([])
  const inputHistoryIndexRef = useRef(-1)
  const inputDraftRef = useRef('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const permissionCardRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom — use instant scroll to avoid layout thrashing with rapid updates
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, streamingText, streamingThinking, scrollToBottom])

  // Sync pending action state to workspace store for breathing light indicator
  useEffect(() => {
    const hasPending = !!(pendingPermission || pendingQuestion)
    workspaceStore.setTerminalPendingAction(sessionId, hasPending)
  }, [sessionId, pendingPermission, pendingQuestion])

  // Subscribe to IPC events
  useEffect(() => {
    const api = window.electronAPI.claude

    const unsubs = [
      api.onMessage((sid: string, msg: unknown) => {
        if (sid !== sessionId) return
        workspaceStore.updateTerminalActivity(sessionId)
        const message = msg as ClaudeMessage
        // On restart, sys-init message arrives again — reset messages
        // But skip reset if history will be loaded (resume flow)
        if (message.id === `sys-init-${sessionId}`) {
          if (!historyLoadedRef.current) {
            setMessages([message])
          }
          setStreamingText('')
          setStreamingThinking('')
          setIsStreaming(false)
          setSessionMeta(null)
          return
        }
        // Deduplicate by id; attach streaming thinking if backend didn't provide it
        setStreamingThinking(prevThinking => {
          const finalMsg = (!message.thinking && prevThinking && message.role === 'assistant')
            ? { ...message, thinking: prevThinking }
            : message
          setMessages(prev => {
            if (prev.some(m => m.id === finalMsg.id)) return prev
            return [...prev, finalMsg]
          })
          return ''
        })
        setStreamingText('')
      }),

      api.onToolUse((sid: string, tool: unknown) => {
        if (sid !== sessionId) return
        workspaceStore.updateTerminalActivity(sessionId)
        const toolCall = tool as ClaudeToolCall
        setMessages(prev => {
          if (prev.some(m => 'toolName' in m && m.id === toolCall.id)) return prev
          return [...prev, toolCall]
        })
      }),

      api.onToolResult((sid: string, result: unknown) => {
        if (sid !== sessionId) return
        workspaceStore.updateTerminalActivity(sessionId)
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
        setStreamingThinking('')
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
        workspaceStore.updateTerminalActivity(sessionId)
        const d = data as { text?: string; thinking?: string }
        if (d.text) setStreamingText(prev => prev + d.text)
        if (d.thinking) setStreamingThinking(prev => prev + d.thinking)
      }),

      api.onStatus((sid: string, meta: unknown) => {
        if (sid !== sessionId) return
        const m = meta as SessionMeta
        setSessionMeta(m)
        if (m.permissionMode) setPermissionMode(m.permissionMode)
        if (m.model) setCurrentModel(m.model)
        // Persist SDK session ID for auto-resume
        if (m.sdkSessionId && workspaceId) {
          workspaceStore.setLastSdkSessionId(workspaceId, m.sdkSessionId)
        }
      }),

      api.onPermissionRequest((sid: string, data: unknown) => {
        if (sid !== sessionId) return
        setPendingPermission(data as PendingPermission)
        setPermissionFocus(0)
        setPermissionCustomText('')
      }),

      api.onAskUser((sid: string, data: unknown) => {
        if (sid !== sessionId) return
        setPendingQuestion(data as PendingAskUser)
        setAskAnswers({})
        setAskOtherText({})
      }),

      api.onHistory((sid: string, items: unknown[]) => {
        if (sid !== sessionId) return
        historyLoadedRef.current = true
        // Replace messages with the full history batch
        setMessages(items as MessageItem[])
        setStreamingText('')
        setStreamingThinking('')
        // Reset the flag after a tick so future restarts work normally
        setTimeout(() => { historyLoadedRef.current = false }, 100)
      }),
    ]

    return () => {
      unsubs.forEach(unsub => unsub())
    }
  }, [sessionId])

  // Start session on mount (guarded against StrictMode double-mount)
  // If savedSdkSessionId exists, auto-resume that session
  useEffect(() => {
    if (!sessionStartedRef.current && !startedSessions.has(sessionId)) {
      sessionStartedRef.current = true
      startedSessions.add(sessionId)
      if (savedSdkSessionId) {
        window.electronAPI.claude.startSession(sessionId, { cwd, sdkSessionId: savedSdkSessionId })
      } else {
        window.electronAPI.claude.startSession(sessionId, { cwd })
      }
    }
    return () => {
      // Don't remove from startedSessions on unmount — StrictMode will remount
    }
  }, [sessionId, cwd, savedSdkSessionId])

  // Fetch supported models once session metadata arrives
  useEffect(() => {
    if (sessionMeta?.sdkSessionId && availableModels.length === 0) {
      window.electronAPI.claude.getSupportedModels(sessionId).then((models: ModelInfo[]) => {
        if (models && models.length > 0) {
          setAvailableModels(models)
        }
      }).catch(() => {})
    }
  }, [sessionId, sessionMeta?.sdkSessionId, availableModels.length])

  // Fetch git branch on mount and when cwd changes
  useEffect(() => {
    window.electronAPI.git.getBranch(cwd).then(branch => setGitBranch(branch)).catch(() => setGitBranch(null))
  }, [cwd])

  // Focus textarea when active
  useEffect(() => {
    if (isActive) {
      textareaRef.current?.focus()
    }
  }, [isActive])

  const handleModelSelect = useCallback(async (modelValue: string) => {
    setShowModelList(false)
    setCurrentModel(modelValue)
    await window.electronAPI.claude.setModel(sessionId, modelValue)
  }, [sessionId])

  const handleResumeSelect = useCallback(async (sdkSessionId: string) => {
    setShowResumeList(false)
    setResumeSessions([])
    setStreamingText('')
    setStreamingThinking('')
    setIsStreaming(false)
    // Reset the started guard so the new session can start
    startedSessions.delete(sessionId)
    sessionStartedRef.current = false
    // Mark that history will be loaded — prevents sys-init from wiping messages
    historyLoadedRef.current = true
    await window.electronAPI.claude.resumeSession(sessionId, sdkSessionId, cwd)
    if (workspaceId) {
      workspaceStore.setLastSdkSessionId(workspaceId, sdkSessionId)
    }
  }, [sessionId, cwd, workspaceId])

  const handleSend = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed) return

    // Save to input history
    inputHistoryRef.current.push(trimmed)
    inputHistoryIndexRef.current = -1
    inputDraftRef.current = ''

    // Intercept /resume command (only when not streaming)
    if (!isStreaming && trimmed === '/resume') {
      setInput('')
      setResumeLoading(true)
      setShowResumeList(true)
      try {
        const sessions = await window.electronAPI.claude.listSessions(cwd)
        setResumeSessions(sessions || [])
      } catch {
        setResumeSessions([])
      } finally {
        setResumeLoading(false)
      }
      return
    }

    // Intercept /model command
    if (trimmed === '/model') {
      setInput('')
      setShowModelList(true)
      return
    }

    const imagePaths = attachedImages.map(i => i.path)
    setInput('')
    setAttachedImages([])
    if (!isStreaming) {
      setIsStreaming(true)
      setStreamingText('')
      setStreamingThinking('')
    }

    // Add user message locally
    const imageNote = imagePaths.length > 0
      ? `\n[${imagePaths.length} image${imagePaths.length > 1 ? 's' : ''} attached]`
      : ''
    setMessages(prev => [...prev, {
      id: `user-${Date.now()}`,
      sessionId,
      role: 'user' as const,
      content: trimmed + imageNote,
      timestamp: Date.now(),
    }])

    await window.electronAPI.claude.sendMessage(sessionId, trimmed, imagePaths.length > 0 ? imagePaths : undefined)
  }, [input, isStreaming, sessionId, attachedImages])

  const handleStop = useCallback(() => {
    if (!isStreaming) return
    window.electronAPI.claude.stopSession(sessionId)
    setIsStreaming(false)
    setStreamingText('')
    setStreamingThinking('')
    setMessages(prev => [...prev, {
      id: `sys-stop-${Date.now()}`,
      sessionId,
      role: 'system' as const,
      content: 'Interrupted by user. You can continue typing.',
      timestamp: Date.now(),
    }])
    // Focus textarea so user can type immediately
    textareaRef.current?.focus()
  }, [sessionId, isStreaming])

  const permissionModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const
  const permissionModeLabels: Record<string, string> = {
    default: '\u270F Ask before edits',
    acceptEdits: '\u270F Auto-accept edits',
    bypassPermissions: '\u26A0 Bypass permissions',
    plan: '\uD83D\uDCCB Plan mode',
  }

  const handlePermissionModeCycle = useCallback(async () => {
    const idx = permissionModes.indexOf(permissionMode as typeof permissionModes[number])
    const nextMode = permissionModes[(idx + 1) % permissionModes.length]
    if (nextMode === 'bypassPermissions' && !settingsStore.getSettings().allowBypassPermissions) {
      if (!window.confirm('Warning: bypassPermissions allows all tool calls without confirmation. Continue?')) {
        return
      }
    }
    setPermissionMode(nextMode)
    await window.electronAPI.claude.setPermissionMode(sessionId, nextMode)
  }, [sessionId, permissionMode])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      handlePermissionModeCycle()
      return
    }
    if (e.key === 'ArrowUp' && !e.shiftKey) {
      const history = inputHistoryRef.current
      if (history.length === 0) return
      e.preventDefault()
      if (inputHistoryIndexRef.current === -1) {
        // Save current draft before navigating
        inputDraftRef.current = input
        inputHistoryIndexRef.current = history.length - 1
      } else if (inputHistoryIndexRef.current > 0) {
        inputHistoryIndexRef.current--
      }
      setInput(history[inputHistoryIndexRef.current])
      return
    }
    if (e.key === 'ArrowDown' && !e.shiftKey) {
      if (inputHistoryIndexRef.current === -1) return
      e.preventDefault()
      const history = inputHistoryRef.current
      if (inputHistoryIndexRef.current < history.length - 1) {
        inputHistoryIndexRef.current++
        setInput(history[inputHistoryIndexRef.current])
      } else {
        // Back to draft
        inputHistoryIndexRef.current = -1
        setInput(inputDraftRef.current)
      }
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend, handlePermissionModeCycle, input])

  const handleModelCycle = useCallback(async () => {
    if (availableModels.length === 0) return
    const idx = availableModels.findIndex(m => m.value === currentModel)
    const next = availableModels[(idx + 1) % availableModels.length]
    setCurrentModel(next.value)
    await window.electronAPI.claude.setModel(sessionId, next.value)
  }, [sessionId, currentModel, availableModels])

  // Effort control hidden until SDK supports per-model effort metadata
  // const effortLevels = ['low', 'medium', 'high'] as const
  // const handleEffortCycle = useCallback(async () => { ... }, [sessionId, effortLevel])

  const PERMISSION_OPTION_COUNT = 4 // 0=Yes, 1=Yes always, 2=No, 3=custom text

  const handlePermissionSelect = useCallback((index?: number) => {
    if (!pendingPermission) return
    const choice = index ?? permissionFocus
    if (choice === 0) {
      // Yes — allow once
      window.electronAPI.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
        behavior: 'allow',
        updatedInput: pendingPermission.input,
      })
      setPendingPermission(null)
    } else if (choice === 1) {
      // Yes, always for this session
      window.electronAPI.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
        behavior: 'allow',
        updatedInput: pendingPermission.input,
      })
      setPendingPermission(null)
    } else if (choice === 2) {
      // No — use the same message as VS Code CLI
      const toolId = pendingPermission.toolUseId
      setMessages(prev => prev.map(m => {
        if ('toolName' in m && m.id === toolId) {
          return { ...m, denied: true } as ClaudeToolCall
        }
        return m
      }))
      window.electronAPI.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
        behavior: 'deny',
        message: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
      })
      setPendingPermission(null)
    } else if (choice === 3) {
      // Custom text — deny with reason message
      const msg = permissionCustomText.trim()
      if (!msg) return // don't submit empty
      // Update the tool call in messages to show the deny reason
      const toolId = pendingPermission.toolUseId
      setMessages(prev => prev.map(m => {
        if ('toolName' in m && m.id === toolId) {
          return { ...m, denyReason: msg, denied: true } as ClaudeToolCall
        }
        return m
      }))
      window.electronAPI.claude.resolvePermission(sessionId, pendingPermission.toolUseId, {
        behavior: 'deny',
        message: msg,
      })
      setPendingPermission(null)
      setPermissionCustomText('')
    }
  }, [sessionId, pendingPermission, permissionFocus, permissionCustomText])

  // Auto-focus permission card when it appears or when panel becomes active again
  useEffect(() => {
    if (isActive && pendingPermission && permissionCardRef.current) {
      permissionCardRef.current.focus()
    }
  }, [isActive, pendingPermission])

  const permissionCustomRef = useRef<HTMLInputElement>(null)

  // Auto-focus custom text input when option 3 is selected
  useEffect(() => {
    if (permissionFocus === 3 && permissionCustomRef.current) {
      permissionCustomRef.current.focus()
    }
  }, [permissionFocus])

  // Global keyboard listener
  useEffect(() => {
    if (!isActive) return
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showModelList) {
          e.preventDefault()
          setShowModelList(false)
          return
        }
        if (showResumeList) {
          e.preventDefault()
          setShowResumeList(false)
          setResumeSessions([])
          return
        }
        if (pendingPermission) {
          e.preventDefault()
          handlePermissionSelect(2) // Deny
          return
        }
        if (isStreaming) {
          e.preventDefault()
          handleStop()
          return
        }
      }
      if (pendingPermission) {
        // If typing in custom text input, only handle Enter/Escape/ArrowUp
        if (permissionFocus === 3) {
          if (e.key === 'Enter') {
            e.preventDefault()
            handlePermissionSelect(3)
            return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setPermissionFocus(2)
            return
          }
          return // let other keys go to the input
        }
        // Number key shortcuts
        if (e.key === '1') { e.preventDefault(); handlePermissionSelect(0); return }
        if (e.key === '2') { e.preventDefault(); handlePermissionSelect(1); return }
        if (e.key === '3') { e.preventDefault(); handlePermissionSelect(2); return }
        // Arrow up/down navigation
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setPermissionFocus(prev => Math.max(0, prev - 1))
          return
        }
        if (e.key === 'ArrowDown' || e.key === 'Tab') {
          e.preventDefault()
          setPermissionFocus(prev => Math.min(PERMISSION_OPTION_COUNT - 1, prev + 1))
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          handlePermissionSelect()
          return
        }
        // Legacy shortcuts
        if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); handlePermissionSelect(0); return }
        if (e.key === 'n' || e.key === 'N') { e.preventDefault(); handlePermissionSelect(2); return }
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [isActive, isStreaming, handleStop, pendingPermission, permissionFocus, handlePermissionSelect, showResumeList, showModelList])

  const handleAskUserSubmit = useCallback(() => {
    if (!pendingQuestion) return
    // Merge selected answers with "Other" text inputs
    const finalAnswers = { ...askAnswers }
    for (const [key, text] of Object.entries(askOtherText)) {
      if (text.trim()) {
        finalAnswers[key] = text.trim()
      }
    }
    window.electronAPI.claude.resolveAskUser(sessionId, pendingQuestion.toolUseId, finalAnswers)
    setPendingQuestion(null)
    setAskAnswers({})
    setAskOtherText({})
  }, [sessionId, pendingQuestion, askAnswers, askOtherText])

  const MAX_IMAGES = 5

  const addImageByPath = useCallback(async (filePath: string) => {
    setAttachedImages(prev => {
      if (prev.length >= MAX_IMAGES) return prev
      if (prev.some(img => img.path === filePath)) return prev
      return prev // will be updated after async
    })
    // Check limit and dedup before reading
    const current = attachedImages
    if (current.length >= MAX_IMAGES || current.some(img => img.path === filePath)) return
    try {
      const dataUrl = await window.electronAPI.image.readAsDataUrl(filePath)
      setAttachedImages(prev => {
        if (prev.length >= MAX_IMAGES) return prev
        if (prev.some(img => img.path === filePath)) return prev
        return [...prev, { path: filePath, dataUrl }]
      })
    } catch (err) {
      console.error('Failed to read image:', err)
    }
  }, [attachedImages])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const filePath = await window.electronAPI.clipboard.saveImage()
        if (filePath) {
          await addImageByPath(filePath)
        }
        return
      }
    }
  }, [addImageByPath])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const files = e.dataTransfer.files
    for (const file of files) {
      if (file.type.startsWith('image/') && file.path) {
        await addImageByPath(file.path)
      }
    }
  }, [addImageByPath])

  const handleSelectImages = useCallback(async () => {
    const paths = await window.electronAPI.dialog.selectImages()
    for (const p of paths) {
      await addImageByPath(p)
    }
  }, [addImageByPath])

  const removeImage = useCallback((filePath: string) => {
    setAttachedImages(prev => prev.filter(img => img.path !== filePath))
  }, [])

  const toggleTool = useCallback((id: string, isThinking?: boolean) => {
    setExpandedTools(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        // Once the user expands any thinking block, auto-expand all future ones
        if (isThinking) setAutoExpandThinking(true)
      }
      return next
    })
  }, [])

  const toolInputSummary = (_toolName: string, input: Record<string, unknown>): string => {
    // Show a compact one-line summary of tool input
    if (input.command) return String(input.command).slice(0, 80)
    if (input.file_path) return String(input.file_path)
    if (input.pattern) return String(input.pattern)
    if (input.query) return String(input.query).slice(0, 80)
    if (input.url) return String(input.url).slice(0, 80)
    const keys = Object.keys(input)
    if (keys.length === 0) return ''
    return keys.slice(0, 2).map(k => `${k}: ${String(input[k]).slice(0, 40)}`).join(', ')
  }

  // Extract main content string for the IN block display
  const toolInputContent = (input: Record<string, unknown>): string => {
    if (input.command) return String(input.command)
    if (input.file_path) return String(input.file_path)
    if (input.pattern) return String(input.pattern)
    if (input.query) return String(input.query)
    if (input.url) return String(input.url)
    return JSON.stringify(input, null, 2)
  }

  const toolDescription = (input: Record<string, unknown>): string | null => {
    if (input.description) return String(input.description)
    return null
  }

  const [copiedId, setCopiedId] = useState<string | null>(null)
  const handleCopyBlock = useCallback((text: string, blockId: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(blockId)
      setTimeout(() => setCopiedId(null), 1500)
    })
  }, [])

  const renderMessage = (item: MessageItem, index: number) => {
    if (isToolCall(item)) {
      const dotClass = item.status === 'running' ? 'dot-running' : item.status === 'completed' ? 'dot-success' : 'dot-error'
      const desc = toolDescription(item.input)
      const inContent = toolInputContent(item.input)
      const inBlockId = `in-${item.id}`
      const outBlockId = `out-${item.id}`
      return (
        <div key={item.id || index} className="tl-item">
          <div className={`tl-dot ${dotClass}`} />
          <div className="tl-content">
            <div className="claude-tool-header" onClick={() => toggleTool(item.id)}>
              <span className="claude-tool-name">{item.toolName}</span>
              {desc && <span className="claude-tool-desc">{desc}</span>}
              {!desc && <span className="claude-tool-summary">{toolInputSummary(item.toolName, item.input)}</span>}
            </div>
            {item.denyReason && (
              <div className="claude-tool-reason">Reason: {item.denyReason}</div>
            )}
            <div className="claude-tool-blocks">
              <div
                className="claude-tool-row"
                onClick={() => handleCopyBlock(inContent, inBlockId)}
                title="Click to copy"
              >
                <span className="claude-tool-row-label">IN</span>
                <span className="claude-tool-row-content">{inContent}</span>
                <span className={`claude-tool-row-copy ${copiedId === inBlockId ? 'copied' : ''}`}>
                  {copiedId === inBlockId ? '✓' : '⧉'}
                </span>
              </div>
              {item.result && (
                <div
                  className="claude-tool-row"
                  onClick={() => handleCopyBlock(item.result!, outBlockId)}
                  title="Click to copy"
                >
                  <span className="claude-tool-row-label">OUT</span>
                  <span className="claude-tool-row-content">{item.result}</span>
                  <span className={`claude-tool-row-copy ${copiedId === outBlockId ? 'copied' : ''}`}>
                    {copiedId === outBlockId ? '✓' : '⧉'}
                  </span>
                </div>
              )}
            </div>
            {item.denied && (
              <div className="claude-tool-interrupted">Tool interrupted</div>
            )}
            {expandedTools.has(item.id) && (
              <div className="claude-tool-body">
                <div className="claude-tool-input">
                  <div className="claude-tool-label">Full Input</div>
                  <pre>{JSON.stringify(item.input, null, 2)}</pre>
                </div>
              </div>
            )}
          </div>
        </div>
      )
    }

    const msg = item as ClaudeMessage
    if (msg.role === 'system') {
      return (
        <div key={msg.id || index} className="tl-item tl-item-system">
          <div className="tl-dot dot-system" />
          <div className="tl-content claude-message-system">{msg.content}</div>
        </div>
      )
    }
    if (msg.role === 'user') {
      return (
        <div key={msg.id || index} className="tl-item tl-item-user">
          <div className="tl-dot dot-user" />
          <div className="tl-content claude-message-user">{msg.content}</div>
        </div>
      )
    }
    // assistant
    return (
      <div key={msg.id || index} className="tl-item">
        <div className="tl-dot dot-assistant" />
        <div className="tl-content claude-message-assistant">
          {msg.thinking && (() => {
            const isExpanded = expandedTools.has(msg.id) || (autoExpandThinking && !expandedTools.has(`${msg.id}-collapsed`))
            return (
              <div className="claude-thinking-block">
                <div
                  className="claude-thinking-toggle"
                  onClick={() => {
                    if (isExpanded && autoExpandThinking) {
                      // If auto-expanded, clicking collapses by marking it explicitly collapsed
                      setExpandedTools(prev => { const next = new Set(prev); next.add(`${msg.id}-collapsed`); return next })
                    } else {
                      toggleTool(msg.id, true)
                    }
                  }}
                >
                  <span className={`claude-tool-chevron ${isExpanded ? 'expanded' : ''}`}>&#9654;</span>
                  <span className="claude-thinking-label">Thinking</span>
                </div>
                {isExpanded && (
                  <pre className="claude-thinking-content">{msg.thinking}</pre>
                )}
              </div>
            )
          })()}
          {msg.content && <div className="claude-markdown">{msg.content}</div>}
        </div>
      </div>
    )
  }

  return (
    <div
      className="claude-agent-panel"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="claude-messages claude-timeline">
        {messages.map((item, i) => renderMessage(item, i))}
        {isStreaming && !streamingText && !streamingThinking && (
          <div className="tl-item">
            <div className="tl-dot dot-thinking" />
            <div className="tl-content claude-thinking">
              <span className="claude-thinking-text">Thinking</span>
              <span className="claude-thinking-dots"><span>.</span><span>.</span><span>.</span></span>
            </div>
          </div>
        )}
        {streamingThinking && (
          <div className="tl-item">
            <div className="tl-dot dot-thinking" />
            <div className="tl-content claude-thinking-block">
              <div
                className="claude-thinking-toggle"
                onClick={() => setShowThinking(prev => !prev)}
              >
                <span className={`claude-tool-chevron ${showThinking ? 'expanded' : ''}`}>&#9654;</span>
                <span className="claude-thinking-label">Thinking{isStreaming && streamingThinking && !streamingText ? '...' : ''}</span>
              </div>
              {showThinking && (
                <pre className="claude-thinking-content">{streamingThinking}</pre>
              )}
            </div>
          </div>
        )}
        {streamingText && (
          <div className="tl-item">
            <div className="tl-dot dot-assistant" />
            <div className="tl-content claude-message-assistant">
              <div className="claude-markdown">{streamingText}<span className="claude-cursor">|</span></div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Permission Request Card — VS Code style vertical list */}
      {pendingPermission && (
        <div
          ref={permissionCardRef}
          tabIndex={-1}
          className={`claude-permission-card ${
            ['Bash', 'Write', 'NotebookEdit'].includes(pendingPermission.toolName) ? 'danger'
            : ['Edit', 'TaskCreate', 'TaskUpdate'].includes(pendingPermission.toolName) ? 'warning'
            : 'safe'
          }`}
        >
          <div className="claude-permission-title">
            Allow this <strong>{pendingPermission.toolName}</strong> call?
          </div>
          <div className="claude-permission-command">
            {toolInputSummary(pendingPermission.toolName, pendingPermission.input)}
          </div>
          {pendingPermission.input.description && (
            <div className="claude-permission-desc">
              {String(pendingPermission.input.description)}
            </div>
          )}
          <div className="claude-permission-options">
            <div
              className={`claude-permission-option ${permissionFocus === 0 ? 'focused' : ''}`}
              onClick={() => handlePermissionSelect(0)}
              onMouseEnter={() => setPermissionFocus(0)}
            >
              <span className="claude-permission-option-num">1</span>
              <span className="claude-permission-option-label">Yes</span>
            </div>
            <div
              className={`claude-permission-option ${permissionFocus === 1 ? 'focused' : ''}`}
              onClick={() => handlePermissionSelect(1)}
              onMouseEnter={() => setPermissionFocus(1)}
            >
              <span className="claude-permission-option-num">2</span>
              <span className="claude-permission-option-label">Yes, don't ask again for this session</span>
            </div>
            <div
              className={`claude-permission-option ${permissionFocus === 2 ? 'focused' : ''}`}
              onClick={() => handlePermissionSelect(2)}
              onMouseEnter={() => setPermissionFocus(2)}
            >
              <span className="claude-permission-option-num">3</span>
              <span className="claude-permission-option-label">No</span>
            </div>
            <div
              className={`claude-permission-option custom ${permissionFocus === 3 ? 'focused' : ''}`}
              onClick={() => { setPermissionFocus(3); permissionCustomRef.current?.focus() }}
              onMouseEnter={() => setPermissionFocus(3)}
            >
              <input
                ref={permissionCustomRef}
                className="claude-permission-custom-input"
                type="text"
                placeholder="Tell Claude what to do instead"
                value={permissionCustomText}
                onChange={e => setPermissionCustomText(e.target.value)}
                onFocus={() => setPermissionFocus(3)}
              />
            </div>
          </div>
          <div className="claude-permission-hint">Esc to cancel</div>
        </div>
      )}

      {/* AskUserQuestion Card */}
      {pendingQuestion && (
        <div className="claude-ask-card">
          {pendingQuestion.questions.map((q, qi) => (
            <div key={qi} className="claude-ask-question">
              <div className="claude-ask-header">{q.header}</div>
              <div className="claude-ask-text">{q.question}</div>
              <div className="claude-ask-options">
                {q.options.map((opt, oi) => (
                  <button
                    key={oi}
                    className={`claude-ask-option ${askAnswers[String(qi)] === opt.label ? 'selected' : ''}`}
                    onClick={() => setAskAnswers(prev => ({ ...prev, [String(qi)]: opt.label }))}
                    title={opt.description}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="claude-ask-other">
                <input
                  type="text"
                  placeholder="Other..."
                  value={askOtherText[String(qi)] || ''}
                  onChange={e => setAskOtherText(prev => ({ ...prev, [String(qi)]: e.target.value }))}
                />
              </div>
            </div>
          ))}
          <div className="claude-ask-actions">
            <button className="claude-permission-btn allow" onClick={handleAskUserSubmit}>Submit</button>
          </div>
        </div>
      )}

      {/* Resume Session List */}
      {showResumeList && (
        <div className="claude-resume-card">
          <div className="claude-permission-title">Resume a previous session</div>
          {resumeLoading ? (
            <div className="claude-resume-empty">Loading sessions...</div>
          ) : resumeSessions.length === 0 ? (
            <div className="claude-resume-empty">No sessions found</div>
          ) : (
            <div className="claude-resume-list">
              {resumeSessions.map(s => (
                <div
                  key={s.sdkSessionId}
                  className="claude-resume-item"
                  onClick={() => handleResumeSelect(s.sdkSessionId)}
                >
                  <div className="claude-resume-item-header">
                    <span className="claude-resume-item-id">{s.sdkSessionId.slice(0, 8)}</span>
                    <span className="claude-resume-item-time">
                      {new Date(s.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="claude-resume-item-preview">{s.preview}</div>
                </div>
              ))}
            </div>
          )}
          <div className="claude-permission-hint">Esc to cancel</div>
        </div>
      )}

      {/* Model Selection List */}
      {showModelList && (
        <div className="claude-resume-card">
          <div className="claude-permission-title">Select a model</div>
          {availableModels.length === 0 ? (
            <div className="claude-resume-empty">No models available</div>
          ) : (
            <div className="claude-resume-list">
              {availableModels.map(m => (
                <div
                  key={m.value}
                  className={`claude-resume-item${m.value === currentModel ? ' active' : ''}`}
                  onClick={() => handleModelSelect(m.value)}
                >
                  <div className="claude-resume-item-header">
                    <span className="claude-resume-item-id">{m.displayName}</span>
                  </div>
                  <div className="claude-resume-item-preview">{m.description}</div>
                </div>
              ))}
            </div>
          )}
          <div className="claude-permission-hint">Esc to cancel</div>
        </div>
      )}

      {/* Input area — hidden when permission card, ask-user card, or resume/model list is visible */}
      {!pendingPermission && !pendingQuestion && !showResumeList && !showModelList && (
      <div className={`claude-input-area${isDragOver ? ' drag-over' : ''}`}>
        <textarea
          ref={textareaRef}
          className="claude-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isStreaming ? 'Press Escape to stop...' : 'Type a message... (Enter to send, Shift+Tab to switch mode)'}
          disabled={false}
          rows={1}
        />
        {attachedImages.length > 0 && (
          <div className="claude-attachments">
            {attachedImages.map(img => (
              <div key={img.path} className="claude-attachment">
                <img src={img.dataUrl} className="claude-attachment-thumb" alt="attached" />
                <button
                  className="claude-attachment-remove"
                  onClick={() => removeImage(img.path)}
                  title="Remove image"
                >
                  &times;
                </button>
              </div>
            ))}
            {attachedImages.length < MAX_IMAGES && (
              <button
                className="claude-add-image-btn"
                onClick={handleSelectImages}
                title="Add image"
              >
                +
              </button>
            )}
          </div>
        )}
        <div className="claude-input-footer">
          <div className="claude-input-controls">
            <span
              className={`claude-status-btn claude-mode-${permissionMode}`}
              onClick={handlePermissionModeCycle}
              title={`Permission: ${permissionMode} (click to cycle)`}
            >
              {permissionModeLabels[permissionMode] || permissionMode}
            </span>

            <span
              className="claude-status-btn"
              onClick={handleSelectImages}
              title="Attach images (max 5)"
            >
              &#128206;
            </span>

            {currentModel && (
              <span
                className="claude-status-btn"
                onClick={handleModelCycle}
                title={`Model: ${currentModel} (click to cycle)`}
              >
                {'</>'} {currentModel}
              </span>
            )}
          </div>

          <div className="claude-input-actions">
            {sessionMeta && sessionMeta.totalCost > 0 && (
              <span className="claude-input-meta" title={`${sessionMeta.numTurns} turns | ${sessionMeta.inputTokens.toLocaleString()}/${sessionMeta.outputTokens.toLocaleString()} tok | ${(sessionMeta.durationMs / 1000).toFixed(1)}s`}>
                ${sessionMeta.totalCost.toFixed(4)}
              </span>
            )}
            {isStreaming ? (
              <button
                className="claude-send-btn claude-stop-btn"
                onClick={handleStop}
                title="Stop (Esc)"
              >
                ■
              </button>
            ) : (
              <button
                className="claude-send-btn"
                onClick={handleSend}
                disabled={!input.trim()}
                title="Send message"
              >
                ▶
              </button>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Status lines */}
      <div className="claude-statuslines">
        <div className="claude-statusline">
          {gitBranch && <span className="claude-statusline-item claude-statusline-branch">[{gitBranch}]</span>}
          {currentModel && <span className="claude-statusline-item">{currentModel}</span>}
          {sessionMeta && sessionMeta.contextWindow > 0 && (
            <span className="claude-statusline-item" title={`${(sessionMeta.inputTokens + sessionMeta.outputTokens).toLocaleString()} / ${sessionMeta.contextWindow.toLocaleString()} tokens`}>
              ctx {Math.round(((sessionMeta.inputTokens + sessionMeta.outputTokens) / sessionMeta.contextWindow) * 100)}%
            </span>
          )}
          {sessionMeta && sessionMeta.totalCost > 0 && (
            <span className="claude-statusline-item">${sessionMeta.totalCost.toFixed(4)}</span>
          )}
        </div>
        <div className="claude-statusline">
          {sessionMeta && (
            <span className="claude-statusline-item" title={`in: ${sessionMeta.inputTokens.toLocaleString()} / out: ${sessionMeta.outputTokens.toLocaleString()}`}>
              session: {(sessionMeta.inputTokens + sessionMeta.outputTokens).toLocaleString()} tok
            </span>
          )}
          {sessionMeta && sessionMeta.numTurns > 0 && (
            <span className="claude-statusline-item">{sessionMeta.numTurns} turns</span>
          )}
          {sessionMeta && sessionMeta.durationMs > 0 && (
            <span className="claude-statusline-item">{(sessionMeta.durationMs / 1000).toFixed(1)}s</span>
          )}
        </div>
      </div>
    </div>
  )
}
