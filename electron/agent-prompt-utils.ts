const INTERRUPTED_WRAPPER_RE = /^\[使用者先前的訊息（已中斷）: "([\s\S]+)"\]\n\n([\s\S]*)$/

/**
 * When a turn is interrupted we prepend the aborted prompt as context. If the
 * aborted prompt was itself already wrapped from an earlier interruption, naive
 * re-wrapping accumulates nested `[使用者先前的訊息（已中斷）: "..."]` layers.
 * Strip any leading wrapper and return just the user's latest intent — older
 * layers are redundant noise.
 */
export function unwrapInterruptedPrompt(text: string): string {
  const m = text.match(INTERRUPTED_WRAPPER_RE)
  return m ? m[2] : text
}

export function wrapInterruptedPrompt(abortedPrompt: string, newPrompt: string): string {
  const base = unwrapInterruptedPrompt(abortedPrompt)
  if (!base || base === newPrompt) return newPrompt
  return `[使用者先前的訊息（已中斷）: "${base}"]\n\n${newPrompt}`
}
