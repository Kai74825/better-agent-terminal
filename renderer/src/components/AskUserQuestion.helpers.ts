export interface AskUserOption {
  label: string
  description: string
  // Self-contained HTML preview fragment for this option, rendered in a
  // sandboxed iframe. The SDK emits this on `preview` (we request
  // previewFormat:'html' in the sidecar); `markdown` is accepted as a legacy alias.
  preview?: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: AskUserOption[]
  multiSelect: boolean
}

export interface PendingAskUser {
  toolUseId: string
  questions: AskUserQuestion[]
}

function normalizeAskUserOption(value: unknown, index: number): AskUserOption | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const label = typeof record.label === 'string' && record.label.trim()
    ? record.label.trim()
    : `Option ${index + 1}`
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  // Prefer the SDK's `preview` field; fall back to the legacy `markdown` alias.
  const preview = (typeof record.preview === 'string' && record.preview.trim())
    ? record.preview
    : (typeof record.markdown === 'string' && record.markdown.trim() ? record.markdown : undefined)
  return { label, description, preview }
}

function normalizeAskUserQuestion(value: unknown, index: number): AskUserQuestion | null {
  if (typeof value === 'string' && value.trim()) {
    return {
      header: `Question ${index + 1}`,
      question: value.trim(),
      options: [],
      multiSelect: false,
    }
  }
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  const header = typeof record.header === 'string' && record.header.trim()
    ? record.header.trim()
    : `Question ${index + 1}`
  const question = typeof record.question === 'string' && record.question.trim()
    ? record.question.trim()
    : 'The agent requested input, but this question payload was incomplete.'
  const rawOptions = Array.isArray(record.options) ? record.options : []
  const options = rawOptions
    .map((option, optionIndex) => normalizeAskUserOption(option, optionIndex))
    .filter((option): option is AskUserOption => !!option)

  return {
    header,
    question,
    options,
    multiSelect: record.multiSelect === true,
  }
}

export function normalizePendingAskUser(data: unknown): PendingAskUser {
  const record = (data && typeof data === 'object') ? data as Record<string, unknown> : {}
  const rawQuestions = Array.isArray(record.questions) ? record.questions : []
  const questions = rawQuestions
    .map((question, index) => normalizeAskUserQuestion(question, index))
    .filter((question): question is AskUserQuestion => !!question)

  return {
    toolUseId: typeof record.toolUseId === 'string' ? record.toolUseId : '',
    questions: questions.length > 0 ? questions : [{
      header: 'Question',
      question: 'The agent requested input, but no valid questions were provided.',
      options: [],
      multiSelect: false,
    }],
  }
}

export function summarizeAskUserInput(input: Record<string, unknown>): string | null {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : []
  const questions = rawQuestions
    .map((question, index) => normalizeAskUserQuestion(question, index))
    .filter((question): question is AskUserQuestion => !!question)
  if (questions.length === 0) return null
  const names = questions.map(question => question.header || question.question).filter(Boolean)
  if (names.length === 1) return `1 question: ${names[0]}`
  return `${names.length} questions: ${names.slice(0, 2).join(', ')}`
}
