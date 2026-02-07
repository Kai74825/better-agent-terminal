import { BrowserWindow } from 'electron'
import type { ClaudeMessage, ClaudeToolCall, ClaudeSessionState } from '../src/types/claude-agent'

// Lazy import the SDK (it's an ES module)
let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null

async function getQuery() {
  if (!queryFn) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    queryFn = sdk.query
  }
  return queryFn
}

interface SessionMetadata {
  model?: string
  sdkSessionId?: string
  cwd?: string
  totalCost: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  numTurns: number
}

interface SessionInstance {
  abortController: AbortController
  state: ClaudeSessionState
  sdkSessionId?: string
  cwd: string
  metadata: SessionMetadata
}

// Persists SDK session IDs across stop/restart so we can resume conversations
const sdkSessionIds = new Map<string, string>()

export class ClaudeAgentManager {
  private sessions: Map<string, SessionInstance> = new Map()
  private window: BrowserWindow

  constructor(window: BrowserWindow) {
    this.window = window
  }

  private send(channel: string, ...args: unknown[]) {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, ...args)
    }
  }

  private addMessage(sessionId: string, msg: ClaudeMessage) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(msg)
    }
    this.send('claude:message', sessionId, msg)
  }

  private addToolCall(sessionId: string, tool: ClaudeToolCall) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(tool)
    }
    this.send('claude:tool-use', sessionId, tool)
  }

  private updateToolCall(sessionId: string, toolId: string, updates: Partial<ClaudeToolCall>) {
    const session = this.sessions.get(sessionId)
    if (session) {
      const idx = session.state.messages.findIndex(
        m => 'toolName' in m && m.id === toolId
      )
      if (idx !== -1) {
        Object.assign(session.state.messages[idx], updates)
      }
    }
    this.send('claude:tool-result', sessionId, { id: toolId, ...updates })
  }

  async startSession(sessionId: string, options: { cwd: string; prompt?: string }): Promise<boolean> {
    // Prevent duplicate session creation
    if (this.sessions.has(sessionId)) {
      return true
    }

    try {
      const abortController = new AbortController()
      const state: ClaudeSessionState = {
        sessionId,
        messages: [],
        isStreaming: false,
      }

      // Restore SDK session ID if we had one before (for resume after restart)
      const previousSdkSessionId = sdkSessionIds.get(sessionId)

      this.sessions.set(sessionId, {
        abortController,
        state,
        sdkSessionId: previousSdkSessionId,
        cwd: options.cwd,
        metadata: {
          totalCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          numTurns: 0,
        },
      })

      // If no initial prompt, just set up session and wait
      if (!options.prompt) {
        const resumeNote = previousSdkSessionId ? ' (resumed)' : ''
        this.send('claude:message', sessionId, {
          id: `sys-init-${sessionId}`,
          sessionId,
          role: 'system',
          content: `Claude Code session ready${resumeNote}. Type a message to start.`,
          timestamp: Date.now(),
        } satisfies ClaudeMessage)
        return true
      }

      await this.runQuery(sessionId, options.prompt)
      return true
    } catch (error) {
      console.error('Failed to start Claude session:', error)
      this.send('claude:error', sessionId, String(error))
      return false
    }
  }

  async sendMessage(sessionId: string, prompt: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.send('claude:error', sessionId, 'Session not found')
      return false
    }

    if (session.state.isStreaming) {
      this.send('claude:error', sessionId, 'Session is busy')
      return false
    }

    // Add user message
    this.addMessage(sessionId, {
      id: `user-${Date.now()}`,
      sessionId,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    })

    await this.runQuery(sessionId, prompt)
    return true
  }

  private async runQuery(sessionId: string, prompt: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.state.isStreaming = true
    session.abortController = new AbortController()

    try {
      const query = await getQuery()

      // Build options — resume if we have a previous SDK session ID
      const resumeId = session.sdkSessionId
      const queryOptions: Record<string, unknown> = {
        abortController: session.abortController,
        cwd: session.cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: { type: 'preset', preset: 'claude_code' },
        permissionMode: 'default',
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
      }

      if (resumeId) {
        queryOptions.resume = resumeId
        queryOptions.continue = true
      }

      const generator = query({
        prompt,
        options: queryOptions as Parameters<typeof query>[0]['options'],
      })

      for await (const message of generator) {
        // Check abort
        if (session.abortController.signal.aborted) break

        if (message.type === 'system' && message.subtype === 'init') {
          // Capture and persist the SDK session ID
          const initMsg = message as { session_id: string; model?: string; cwd?: string }
          session.sdkSessionId = initMsg.session_id
          sdkSessionIds.set(sessionId, initMsg.session_id)

          // Extract metadata from init message
          session.metadata.model = initMsg.model
          session.metadata.sdkSessionId = initMsg.session_id
          session.metadata.cwd = initMsg.cwd || session.cwd
          this.send('claude:status', sessionId, { ...session.metadata })
        }

        if (message.type === 'assistant') {
          const content = message.message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if ('text' in block && block.text) {
                this.addMessage(sessionId, {
                  id: message.uuid || `asst-${Date.now()}`,
                  sessionId,
                  role: 'assistant',
                  content: block.text,
                  timestamp: Date.now(),
                })
              }
              if ('type' in block && block.type === 'tool_use') {
                const toolBlock = block as { id: string; name: string; input: Record<string, unknown> }
                this.addToolCall(sessionId, {
                  id: toolBlock.id,
                  sessionId,
                  toolName: toolBlock.name,
                  input: toolBlock.input || {},
                  status: 'running',
                  timestamp: Date.now(),
                })
              }
              if ('type' in block && block.type === 'tool_result') {
                const resultBlock = block as { tool_use_id: string; content?: string; is_error?: boolean }
                const resultContent = typeof resultBlock.content === 'string'
                  ? resultBlock.content
                  : JSON.stringify(resultBlock.content)
                this.updateToolCall(sessionId, resultBlock.tool_use_id, {
                  status: resultBlock.is_error ? 'error' : 'completed',
                  result: resultContent,
                })
              }
            }
          }
        }

        if (message.type === 'user') {
          // User messages in SDK are tool results
          const content = message.message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if ('type' in block && block.type === 'tool_result') {
                const resultBlock = block as { tool_use_id: string; content?: unknown; is_error?: boolean }
                const resultStr = typeof resultBlock.content === 'string'
                  ? resultBlock.content
                  : JSON.stringify(resultBlock.content)
                this.updateToolCall(sessionId, resultBlock.tool_use_id, {
                  status: resultBlock.is_error ? 'error' : 'completed',
                  result: resultStr?.slice(0, 2000), // Truncate long results
                })
              }
            }
          }
        }

        if (message.type === 'stream_event') {
          // Partial streaming content
          const event = message.event as { type?: string; delta?: { text?: string }; content_block?: { type?: string; id?: string; name?: string; input?: string } }
          if (event.type === 'content_block_delta' && event.delta?.text) {
            this.send('claude:stream', sessionId, {
              text: event.delta.text,
              parentToolUseId: message.parent_tool_use_id,
            })
          }
        }

        if (message.type === 'result') {
          const resultMsg = message as {
            subtype: string
            total_cost_usd?: number
            usage?: { input_tokens?: number; output_tokens?: number }
            duration_ms?: number
            num_turns?: number
            result?: string
            errors?: string[]
          }

          session.state.totalCost = resultMsg.total_cost_usd
          session.state.totalTokens =
            (resultMsg.usage?.input_tokens || 0) + (resultMsg.usage?.output_tokens || 0)

          // Accumulate metadata
          session.metadata.totalCost = resultMsg.total_cost_usd ?? session.metadata.totalCost
          session.metadata.inputTokens += resultMsg.usage?.input_tokens || 0
          session.metadata.outputTokens += resultMsg.usage?.output_tokens || 0
          session.metadata.durationMs += resultMsg.duration_ms || 0
          session.metadata.numTurns += resultMsg.num_turns || 0

          this.send('claude:status', sessionId, { ...session.metadata })

          this.send('claude:result', sessionId, {
            subtype: resultMsg.subtype,
            totalCost: resultMsg.total_cost_usd,
            totalTokens: session.state.totalTokens,
            result: resultMsg.result,
            errors: resultMsg.errors,
          })
        }
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      if (errMsg !== 'aborted' && errMsg !== 'The operation was aborted') {
        console.error('Claude query error:', error)
        this.send('claude:error', sessionId, errMsg)
      }
    } finally {
      if (session) {
        session.state.isStreaming = false
      }
    }
  }

  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.abortController.abort()
      // Keep sdkSessionIds so restart can resume the conversation
      this.sessions.delete(sessionId)
      return true
    }
    return false
  }

  getSessionState(sessionId: string): ClaudeSessionState | null {
    const session = this.sessions.get(sessionId)
    return session?.state || null
  }

  dispose() {
    for (const [id] of this.sessions) {
      this.stopSession(id)
    }
    sdkSessionIds.clear()
  }
}
