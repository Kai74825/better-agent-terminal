import * as assert from 'node:assert/strict'
import {
  isClaudeMessage,
  isMessageItem,
  isToolCall,
  normalizeMessageItem,
  normalizeMessageItems,
} from '../renderer/src/types/claude-agent.ts'

const invalidArchiveItems: unknown[] = [
  null,
  undefined,
  'legacy string payload',
  42,
  false,
  [],
  { role: 'assistant' },
]

for (const item of invalidArchiveItems) {
  assert.equal(isToolCall(item), false)
  assert.equal(isClaudeMessage(item), false)
  assert.equal(isMessageItem(item), false)
}

const message = {
  id: 'm1',
  sessionId: 's1',
  role: 'assistant',
  content: 'hello',
  timestamp: 1,
}
assert.equal(isClaudeMessage(message), true)
assert.equal(isMessageItem(message), true)

const toolCall = {
  id: 't1',
  sessionId: 's1',
  toolName: 'Task',
  input: {},
  status: 'running',
  timestamp: 1,
}
assert.equal(isToolCall(toolCall), true)
assert.equal(isMessageItem(toolCall), true)

const missingInputToolCall = {
  id: 'legacy-tool',
  sessionId: 's1',
  toolName: 'Bash',
  status: 'completed',
  result: 'done',
  timestamp: 1,
}
const normalizedToolCall = normalizeMessageItem(missingInputToolCall)
assert.ok(normalizedToolCall && isToolCall(normalizedToolCall))
assert.deepEqual(normalizedToolCall.input, {})
assert.equal(normalizedToolCall.result, 'done', 'normalization should preserve the usable tool row')

assert.deepEqual(
  normalizeMessageItems([null, missingInputToolCall, message]),
  [{ ...missingInputToolCall, input: {} }, message],
  'history normalization should discard invalid rows and repair missing tool input',
)
assert.deepEqual(normalizeMessageItems(null), [])

console.log('claude message guards regression: passed')
