// Agent activity tree builder.
//
// The renderer already holds everything needed for a nested, history-keeping
// view of subagent activity:
//   - Task/Agent/Workflow tool_use blocks stay in the main message list after
//     they finish (the old active-tasks bar simply filtered them out),
//   - each subagent's inner messages are bucketed by parentToolUseId,
//   - best-effort `claude:task` lifecycle events carry workflow metadata
//     (workflowName / failed / killed) that tool blocks don't have.
// buildAgentTaskTree merges the three into a render-ready tree. Pure
// function — no React. Unit tests: tests/agent-task-tree.test.ts.

import type { ClaudeMessage, ClaudeToolCall } from '../types/claude-agent'
import { isToolCall } from '../types/claude-agent'

type MessageItem = ClaudeMessage | ClaudeToolCall

// Tool names whose tool_use blocks represent a spawned agent run.
const AGENT_TOOL_NAMES = new Set(['Task', 'Agent', 'Workflow'])

// Normalized `claude:task` lifecycle entry kept by the renderer. The sidecar
// emits terminal statuses (completed/failed/killed) right before dropping the
// task from its own map, so the renderer keeps them for the finished view.
export interface TaskLifecycle {
  id: string
  type?: string | null
  isWorkflow?: boolean
  workflowName?: string | null
  subagentType?: string | null
  description?: string
  status?: string
  startedAt?: number
  error?: string
}

export interface AgentTaskNode {
  id: string
  kind: 'task' | 'workflow'
  label: string
  subagentType?: string
  status: 'running' | 'completed' | 'error'
  /** Start time (ms). 0 when unknown (lifecycle-only nodes may omit it). */
  timestamp: number
  /** Approximate end time for finished nodes: last bucketed child activity. */
  endTimestamp?: number
  /** Progress text: tool description update or lifecycle description. */
  progressText?: string
  isBackground?: boolean
  /** Workflow name from `claude:task` lifecycle, when known. */
  workflowName?: string
  /** Lifecycle error message (failed/killed workflows). */
  error?: string
  children: AgentTaskNode[]
}

export interface AgentTreeSummary {
  running: number
  completed: number
  error: number
  total: number
}

const TERMINAL_ERROR_STATUSES = new Set(['failed', 'killed', 'error'])

function isAgentToolCall(item: MessageItem): item is ClaudeToolCall {
  return isToolCall(item) && AGENT_TOOL_NAMES.has(item.toolName)
}

function labelForToolCall(tool: ClaudeToolCall, lifecycle?: TaskLifecycle): string {
  if (typeof tool.input.description === 'string' && tool.input.description) {
    return tool.input.description.slice(0, 80)
  }
  if (lifecycle?.workflowName) return lifecycle.workflowName
  if (typeof tool.input.subagent_type === 'string' && tool.input.subagent_type) {
    return tool.input.subagent_type
  }
  return tool.toolName
}

// Approximate when a finished agent stopped: the newest timestamp among its
// bucketed descendants. Survives history reload (timestamps are persisted),
// unlike a renderer-side wall clock captured at result time.
function lastBucketActivity(
  id: string,
  buckets: ReadonlyMap<string, MessageItem[]>,
  visited: Set<string>,
): number {
  if (visited.has(id)) return 0
  visited.add(id)
  const bucket = buckets.get(id)
  if (!bucket || bucket.length === 0) return 0
  let last = 0
  for (const item of bucket) {
    if (typeof item.timestamp === 'number' && item.timestamp > last) last = item.timestamp
    if (isAgentToolCall(item)) {
      const childLast = lastBucketActivity(item.id, buckets, visited)
      if (childLast > last) last = childLast
    }
  }
  return last
}

function nodeFromToolCall(
  tool: ClaudeToolCall,
  buckets: ReadonlyMap<string, MessageItem[]>,
  lifecycle: ReadonlyMap<string, TaskLifecycle>,
  visited: Set<string>,
): AgentTaskNode {
  const life = lifecycle.get(tool.id)
  const lifeError = life?.status != null && TERMINAL_ERROR_STATUSES.has(life.status)
  const status: AgentTaskNode['status'] = tool.status === 'running'
    ? (lifeError ? 'error' : 'running')
    : tool.status === 'error' ? 'error' : 'completed'
  const node: AgentTaskNode = {
    id: tool.id,
    kind: tool.toolName === 'Workflow' || life?.isWorkflow ? 'workflow' : 'task',
    label: labelForToolCall(tool, life),
    status,
    timestamp: tool.timestamp,
    children: buildChildren(tool.id, buckets, lifecycle, visited),
  }
  const subagentType = typeof tool.input.subagent_type === 'string'
    ? tool.input.subagent_type
    : life?.subagentType || undefined
  if (subagentType) node.subagentType = subagentType
  // Claude's tool-result path never carries a description update (that is a
  // Codex-path feature), so the lifecycle description is usually the only
  // live progress text available for Task/Agent nodes.
  const progress = tool.description || life?.description
  if (progress) node.progressText = progress
  if (tool.input.run_in_background === true) node.isBackground = true
  if (life?.workflowName) node.workflowName = life.workflowName
  if (life?.error) node.error = life.error
  if (status !== 'running') {
    const ended = lastBucketActivity(tool.id, buckets, new Set())
    if (ended > 0) node.endTimestamp = ended
  }
  return node
}

function buildChildren(
  parentId: string,
  buckets: ReadonlyMap<string, MessageItem[]>,
  lifecycle: ReadonlyMap<string, TaskLifecycle>,
  visited: Set<string>,
): AgentTaskNode[] {
  if (visited.has(parentId)) return []
  visited.add(parentId)
  const bucket = buckets.get(parentId)
  if (!bucket || bucket.length === 0) return []
  const children: AgentTaskNode[] = []
  for (const item of bucket) {
    // visited check doubles as the cycle guard for malformed buckets.
    if (isAgentToolCall(item) && !visited.has(item.id)) {
      children.push(nodeFromToolCall(item, buckets, lifecycle, visited))
    }
  }
  return children
}

function nodeFromLifecycle(life: TaskLifecycle): AgentTaskNode {
  const status: AgentTaskNode['status'] = life.status != null && TERMINAL_ERROR_STATUSES.has(life.status)
    ? 'error'
    : life.status === 'completed' ? 'completed' : 'running'
  const node: AgentTaskNode = {
    id: life.id,
    kind: life.isWorkflow ? 'workflow' : 'task',
    label: life.workflowName || life.description?.slice(0, 80) || life.subagentType || 'Task',
    status,
    timestamp: life.startedAt ?? 0,
    children: [],
  }
  if (life.subagentType) node.subagentType = life.subagentType
  if (life.description) node.progressText = life.description
  if (life.workflowName) node.workflowName = life.workflowName
  if (life.error) node.error = life.error
  return node
}

/**
 * Build the agent activity tree.
 *
 * Roots are top-level Task/Agent/Workflow tool calls (in message order) plus
 * any `claude:task` lifecycle entries that never matched a tool_use id —
 * e.g. background workflow runs the SDK reports only via task_started.
 */
export function buildAgentTaskTree(
  messages: readonly MessageItem[],
  buckets: ReadonlyMap<string, MessageItem[]>,
  lifecycle: ReadonlyMap<string, TaskLifecycle> = new Map(),
): AgentTaskNode[] {
  const visited = new Set<string>()
  const roots: AgentTaskNode[] = []
  const matchedIds = new Set<string>()
  for (const item of messages) {
    if (!isAgentToolCall(item) || item.parentToolUseId) continue
    roots.push(nodeFromToolCall(item, buckets, lifecycle, visited))
    matchedIds.add(item.id)
  }
  for (const life of lifecycle.values()) {
    if (matchedIds.has(life.id) || visited.has(life.id)) continue
    roots.push(nodeFromLifecycle(life))
  }
  return roots
}

export function summarizeAgentTree(roots: readonly AgentTaskNode[]): AgentTreeSummary {
  const summary: AgentTreeSummary = { running: 0, completed: 0, error: 0, total: 0 }
  const walk = (nodes: readonly AgentTaskNode[]) => {
    for (const node of nodes) {
      summary.total += 1
      summary[node.status] += 1
      walk(node.children)
    }
  }
  walk(roots)
  return summary
}

/** Last non-empty line of a subagent's streaming text, for inline previews. */
export function lastStreamLine(text: string | undefined, maxLen = 90): string {
  if (!text) return ''
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line) return line.length > maxLen ? `…${line.slice(-maxLen)}` : line
  }
  return ''
}
