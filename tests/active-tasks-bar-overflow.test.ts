// GH #128: the active-tasks bar compressed its pills instead of scrolling.
//
// This is a CSS-only invariant with no runtime surface to assert against, and
// its failure mode is silent: the bar looks fine until six or so agents run at
// once, then every pill collapses to its non-shrinkable children and the Stop
// buttons overlap into an unreadable row. Nothing throws, no test goes red, and
// `overflow-x: auto` sits there looking like it handles the case. So the rules
// are read out of the stylesheet directly and the invariant pinned by hand.

import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const cssPath = join(__dirname, '..', 'renderer', 'src', 'styles', 'claude-agent.css')
// Comments are stripped before parsing for two reasons: they precede selectors
// and would otherwise be captured as part of them, and the rules below are
// documented with comments that quote the very declarations this file asserts
// are absent — a prose mention of `min-width: 0` must not read as one.
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Body of the rule whose selector list is exactly `selector`. Exact match, so
 *  `.claude-active-task-item` never picks up `.claude-active-task-item:hover`
 *  or the descendant rules that share its prefix. */
function ruleBody(selector: string): string {
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (sel.trim() === selector) return body
  }
  throw new Error(`rule not found in claude-agent.css: ${selector}`)
}

/** Resolved flex-shrink for a rule body, via longhand or the flex shorthand.
 *  Defaults to 1 — the CSS initial value — when neither is present, which is
 *  the state that caused the bug. */
function flexShrink(body: string): number {
  const longhand = body.match(/(?:^|;)\s*flex-shrink\s*:\s*([\d.]+)/)
  if (longhand) return Number(longhand[1])
  const shorthand = body.match(/(?:^|;)\s*flex\s*:\s*([^;]+)/)
  if (!shorthand) return 1
  const parts = shorthand[1].trim().split(/\s+/)
  // `flex: <grow> <shrink> <basis>` — shrink is the second numeric token.
  if (parts.length >= 2 && /^[\d.]+$/.test(parts[1])) return Number(parts[1])
  return 1
}

// The container is what scrolls.
{
  const bar = ruleBody('.claude-active-tasks')
  assert.match(bar, /overflow-x:\s*auto/, '.claude-active-tasks must scroll horizontally')
}

// The pills are what must not shrink. This is the actual regression: a
// shrinkable flex item means the content width never exceeds the container,
// so the scrollbar above can never appear no matter how many pills there are.
{
  const item = ruleBody('.claude-active-task-item')
  assert.equal(
    flexShrink(item), 0,
    '.claude-active-task-item must not be shrinkable — a shrinking pill keeps the '
    + "container's content within its width, so overflow-x never triggers (GH #128)",
  )
  assert.doesNotMatch(
    item, /(?:^|;)\s*min-width\s*:\s*0/,
    '.claude-active-task-item must not set min-width:0 — that is what let the pill '
    + 'collapse past its own children in the first place',
  )
  // A single long pill must still be capped, or one task with a verbose
  // description pushes everything else out of view.
  assert.match(item, /max-width:\s*\d+px/, '.claude-active-task-item must keep a max-width')
}

// Inside the pill, the label is the part that gives way to honour max-width.
{
  const label = ruleBody('.claude-active-task-label')
  assert.ok(flexShrink(label) > 0, '.claude-active-task-label must stay shrinkable')
  assert.match(label, /text-overflow:\s*ellipsis/, 'a shrunk label must ellipsize, not clip')
}

// Once the bar scrolls, the tree controls have to stay reachable: "expand" is
// the escape hatch from a bar too crowded to read, and it is pointless if it
// scrolls off the right edge exactly when it becomes necessary.
{
  const controls = ruleBody('.claude-agent-tree-bar .claude-agent-tree-controls')
  assert.match(controls, /position:\s*sticky/, 'tree controls must be pinned while the bar scrolls')
  assert.match(controls, /right:\s*0/, 'tree controls must stick to the right edge')
  assert.match(
    controls, /background:/,
    'sticky controls need their own background or pills show through underneath',
  )
}

// One stylesheet, two bars. The Claude tree bar and the Codex panel both render
// .claude-active-task-item, so this fix covers both — assert that stays true,
// because a divergence here would silently leave one of them broken.
{
  const surfaces = ['AgentActivityTree.tsx', 'CodexAgentPanel.tsx']
  for (const file of surfaces) {
    const src = readFileSync(join(__dirname, '..', 'renderer', 'src', 'components', file), 'utf8')
    assert.match(
      src, /className="[^"]*claude-active-task-item/,
      `${file} should still render .claude-active-task-item`,
    )
  }
}

console.log('active tasks bar overflow: passed')
