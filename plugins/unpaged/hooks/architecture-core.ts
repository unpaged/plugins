// The architecture line, its pure part: what the pointer file, the date note
// and a verdict mean, how the line reads in each state, and the prompts the
// plugin submits. Nothing here touches $: register.ts holds the hooks and the
// module's state, since the engine follows $ inside one file only.
//
// The architecture light: one line above the prompt that says whether the
// repository's architecture document on Unpaged still describes the code.
//
// A repository names its architecture canvas in a small pointer file,
// .unpaged/architecture.json, which /unpaged:architecture writes when it
// draws the canvas. From then on, the moment the session opens a pull request
// (the `gh pr create` command, or a GitHub connector's pull-request tool, once
// its answer carries the pull request's address), the mod submits one prompt
// that has the session compare the canvas with the code in a separate helper
// and mark the canvas; the line blinks yellow meanwhile and settles when the
// command reports the verdict through the mod's architecture_report tool.
// "update" does the same for the whole canvas, rewriting what no longer holds.
//
// The light is green while the canvas is up to date, yellow when it is behind
// (with update), red when the canvas is gone or was not compared for three
// months, and a grey invitation while a git repository has no pointer file.
// At session start the state comes from the canvas's own date note, where the
// person's permission rules let the mod read the canvas on its own, else from
// the verdict the mod stored on this machine, else it is unknown until the
// next comparison. The mod edits nothing on the canvas and spawns no agent:
// the command does both, in the agent's turn, under the person's own
// permission rules, as the listener's comment replies do.

import { isDocumentId } from '../monitors/listen-core.mjs'
import type { ArchitectureLight } from '../types'

export const boardUrlFor = (documentId: string) => `https://unpaged.io/document/${documentId}/edit`
export const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** Where a repository names its architecture canvas, relative to the working folder. */
export const POINTER_PATH = '.unpaged/architecture.json'
/** The date note on the root canvas while the canvas is up to date: `**Checked:** YYYY-MM-DD`. */
export const CHECKED_PREFIX = '**Checked:**'
/** The date note while the canvas is behind: `**Behind since:** YYYY-MM-DD`. */
export const BEHIND_PREFIX = '**Behind since:**'
/** The small text beneath the date note: `compared at <commit> (base <merge base>) on YYYY-MM-DD`; the first word is the commit, the day comes last. */
export const COMMIT_PREFIX = 'compared at '
/** A canvas not compared for this long is red. */
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000
export const BLINK_MS = 600
/** The prompt goes out once the hook that saw the pull request has answered. */
export const SUBMIT_DELAY_MS = 50
/** The verdict the mod stores on this machine, one entry per canvas. */
export const STORED = 'architecture:'
export const storedVerdictFor = (documentId: string) => `${STORED}${documentId}`

/** `gh pr create` anywhere in a command, in a pipeline or after `&&` too. */
export const PR_COMMAND = /(^|[\s;&|(`])gh\s+pr\s+create\b/
/** A GitHub connector's pull-request tool, by name: a server named after GitHub and a tool that creates a pull request. */
export const GITHUB_PR_TOOL = /^mcp__[A-Za-z0-9_-]*github[A-Za-z0-9_-]*__(create_pull_request|open_pull_request|pull_request_create|create_pr)$/i
/** A pull request's address, on GitHub or a GitHub Enterprise host. */
export const PR_URL = /https?:\/\/[^\s"'<>)\]]+\/pull\/\d+/

export const STATES = ['current', 'behind', 'lost'] as const
export type VerdictState = (typeof STATES)[number]
export const isVerdictState = (value: unknown): value is VerdictState => (STATES as readonly unknown[]).includes(value)

/** What the pointer file says: the canvas id, checked, and a title for the line. Its address is never taken from the file: the line links by the id. */
export type Pointer = { documentId: string; title: string | null }

/** A git commit as the notes and the report name it: 7 to 40 lowercase hex characters, nothing else reaches a command. */
export const isCommit = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{7,40}$/.test(value)

/** What the last comparison found, as the command reported it and the mod keeps it on this machine. */
export type Verdict = {
  documentId: string
  state: VerdictState
  title: string | null
  /** YYYY-MM-DD, the day of the last comparison. */
  checkedAt: string | null
  commit: string | null
  /** YYYY-MM-DD, the day the canvas fell behind. */
  behindSince: string | null
  reportedAt: string
}

/** What the agent reads after a pull request: the comparison is the command's Compare section, run in its own turn. */
export const comparePrompt = (pullRequest: string | null) =>
  `The unpaged plugin sent a message: this session opened a pull request${pullRequest ? ` (${pullRequest})` : ''}, so the repository's architecture document is to be compared with the code now, as the plugin does after every pull request. Invoke the skill unpaged:architecture with the arguments "compare" and follow its Compare section to the end: it runs the comparison in a separate helper with a clean slate, marks the canvas, never rewrites a card, and ends by reporting with architecture_report, which settles the blinking line above the prompt.`
export const UPDATE_PROMPT =
  'The person pressed "update" on the architecture line above the prompt (the unpaged plugin). Update the repository\'s architecture document now: invoke the skill unpaged:architecture with the arguments "update" and follow its Update section to the end; it ends by reporting with architecture_report, which settles the line.'
export const CREATE_PROMPT =
  'The person pressed "create" on the architecture line above the prompt (the unpaged plugin). Create the repository\'s architecture document now: invoke the skill unpaged:architecture with no arguments and follow its Create section to the end.'

/** A `YYYY-MM-DD` value as given, else null. */
export const day = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : null)

/** The day a `YYYY-MM-DD` note names, at midnight UTC, or null. */
export function dayMs(iso: string | null) {
  if (!day(iso)) return null
  const ms = Date.parse(`${iso}T00:00:00Z`)
  return Number.isNaN(ms) ? null : ms
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `3 Nov`, with the year when it is not this year. */
export function dayLabel(ms: number, now: number) {
  const d = new Date(ms)
  const label = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  return d.getUTCFullYear() === new Date(now).getUTCFullYear() ? label : `${label} ${d.getUTCFullYear()}`
}

export function parsePointer(raw: string): Pointer | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object' || !isDocumentId(parsed.documentId)) return null
    return { documentId: String(parsed.documentId), title: text(parsed.title) || null }
  } catch {
    return null
  }
}

/**
 * The date note and the commit note on a canvas's root, from a document_get
 * answer: the verdict the last comparison left on the canvas, or null when the
 * root carries no date note (a canvas the command did not draw).
 */
export function verdictFromDocument(documentId: string, value: unknown, reportedAt: string): Verdict | null {
  let doc: { title?: unknown; rootNodeId?: unknown; nodes?: unknown }
  try {
    doc = (typeof value === 'string' ? JSON.parse(value) : value) as typeof doc
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object') return null
  type Node = { id?: unknown; parentId?: unknown; elements?: Array<{ properties?: { text?: unknown } }> }
  const nodes = (Array.isArray(doc.nodes) ? doc.nodes : []) as Node[]
  const root = nodes.find(n => n.id === doc.rootNodeId) ?? nodes.find(n => !n.parentId) ?? nodes[0]
  if (!root) return null
  let state: VerdictState | null = null
  let noteDay: string | null = null
  let commitDay: string | null = null
  let behindSince: string | null = null
  let commit: string | null = null
  for (const element of Array.isArray(root.elements) ? root.elements : []) {
    const content = text(element?.properties?.text).trim()
    if (content.startsWith(CHECKED_PREFIX)) {
      state = 'current'
      noteDay = day(content.slice(CHECKED_PREFIX.length))
    } else if (content.startsWith(BEHIND_PREFIX)) {
      state = 'behind'
      behindSince = day(content.slice(BEHIND_PREFIX.length))
    } else if (content.startsWith(COMMIT_PREFIX)) {
      // `compared at <commit> on <day>`: the commit only in its shape, the day only at the end.
      const rest = content.slice(COMMIT_PREFIX.length).trim()
      const sha = rest.split(/\s+/)[0]
      commit = isCommit(sha) ? sha : null
      commitDay = day(rest.match(/\bon\s+(\d{4}-\d{2}-\d{2})\s*$/)?.[1])
    }
  }
  if (!state) return null
  // The commit note's day is the last comparison's, whatever the order of the notes; a canvas behind has no other.
  return { documentId, state, title: text(doc.title) || null, checkedAt: commitDay ?? noteDay, commit, behindSince, reportedAt }
}

export function lightFrom(found: Pointer, known: Verdict | null): ArchitectureLight {
  return {
    documentId: found.documentId,
    title: known?.title || found.title || found.documentId,
    boardUrl: boardUrlFor(found.documentId),
    state: known ? known.state : 'unknown',
    checkedAt: dayMs(known?.checkedAt ?? null),
    commit: known?.commit ?? null,
    behindSince: dayMs(known?.behindSince ?? null),
    source: null,
    on: true,
  }
}

export const NONE: ArchitectureLight = { documentId: null, title: null, boardUrl: null, state: 'none', checkedAt: null, commit: null, behindSince: null, source: null, on: true }

export function describeLight(l: ArchitectureLight, now: number) {
  const shown = shownState(l, now)
  if (shown === 'none') return 'no architecture document yet'
  if (shown === 'unknown') return 'not compared from this machine yet'
  if (shown === 'comparing') return l.source === 'update' ? 'updating the canvas' : 'comparing with the pull request'
  if (shown === 'lost') return 'canvas deleted or unreachable'
  if (shown === 'stale') return `not compared since ${l.checkedAt === null ? 'an unknown day' : dayLabel(l.checkedAt, now)}`
  if (shown === 'behind') return `behind since ${l.behindSince === null ? 'an unknown day' : dayLabel(l.behindSince, now)}`
  return `up to date${l.checkedAt === null ? '' : `  ·  checked ${dayLabel(l.checkedAt, now)}`}`
}

/** The state the line draws: `stale` (red) for a canvas not compared for three months, else the state as it is. */
export function shownState(l: ArchitectureLight, now: number) {
  const stale = (l.state === 'current' || l.state === 'behind') && l.checkedAt !== null && now - l.checkedAt > STALE_AFTER_MS
  return stale ? 'stale' : l.state
}

export function lightColor(shown: ReturnType<typeof shownState>) {
  if (shown === 'current') return 'green'
  if (shown === 'behind' || shown === 'comparing') return 'yellow'
  if (shown === 'lost' || shown === 'stale') return 'red'
  return 'gray'
}

/** The pull request's address in a tool's answer, when it carries one. */
export function pullRequestUrl(ran: { text?: unknown; result?: unknown }) {
  const haystack = [text(ran.text), typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? '')].join('\n')
  return haystack.match(PR_URL)?.[0] ?? null
}
