// Effort modes the app tracks as session state. 'xhigh' is kept here so
// persisted sessions and the picker keep validating, but it is a LEGACY level:
// the Claude Code CLI (>= 2.1.175) no longer accepts `--effort xhigh` — its
// levels are low/medium/high/max. See runtimeEffortForMode for the translation.
export const CLAUDE_RUNTIME_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

// The effort values the current Claude Code CLI accepts on `--effort`.
export const CLAUDE_CLI_EFFORTS = new Set(['low', 'medium', 'high', 'max'])

// Legacy → current CLI level. 'xhigh' was folded into 'max'; passing the
// removed value makes the CLI exit with an arg-validation error.
const RUNTIME_EFFORT_ALIASES = { xhigh: 'max' }

export function normalizeClaudeEffortMode(effort, ultracode = false) {
  if (ultracode === true || effort === 'ultracode') return 'ultracode'
  return CLAUDE_RUNTIME_EFFORTS.has(effort) ? effort : null
}

// runtimeEffortForMode: translate a tracked effort mode into the value passed
// to the Claude Code CLI's `--effort` flag. 'ultracode' runs at the CLI's top
// effort level; legacy values (e.g. 'xhigh') are aliased to a supported level
// so we never spawn the CLI with an argument it rejects.
export function runtimeEffortForMode(mode) {
  const raw = mode === 'ultracode' ? 'max' : mode
  return RUNTIME_EFFORT_ALIASES[raw] || raw
}

export function isUltracodeMode(mode) {
  return mode === 'ultracode'
}

// Anthropic gates some effort levels (e.g. 'max') behind API/console billing.
// A Claude.ai subscription (OAuth) account gets this exact CLI rejection when
// the persisted/default effort exceeds what its plan allows — parse it so the
// caller can downgrade the session instead of repeating the same failure on
// every subsequent send.
const EFFORT_REJECTION_RE = /Effort level "([a-z]+)" is not available for Claude\.ai subscribers\./i

export function parseEffortRejection(text) {
  const str = String(text || '')
  const match = str.match(EFFORT_REJECTION_RE)
  if (!match) return null
  const rejected = match[1].toLowerCase()
  const allowed = [...str.matchAll(/"([a-z]+)"/gi)]
    .map(m => m[1].toLowerCase())
    .filter(v => v !== rejected && CLAUDE_CLI_EFFORTS.has(v))
  return { rejected, allowed: allowed.length > 0 ? allowed : ['low', 'medium', 'high'] }
}

export function fallbackEffortFrom(allowed) {
  if (Array.isArray(allowed) && allowed.includes('high')) return 'high'
  return (Array.isArray(allowed) && allowed[allowed.length - 1]) || 'high'
}
