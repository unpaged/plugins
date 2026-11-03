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
import { atom, read, update } from 'claude-code'
import type { ArchitectureLight } from '../types'
import { isDocumentId } from '../monitors/listen-core.mjs'
import { boardUrlFor, mcpServer, mcpText, ruleOn, text } from './unpaged-api'
import type { Api, On } from './unpaged-api'

/** Where a repository names its architecture canvas, relative to the working folder. */
export const POINTER_PATH = '.unpaged/architecture.json'
/** The date note on the root canvas while the canvas is up to date: `**Checked:** YYYY-MM-DD`. */
export const CHECKED_PREFIX = '**Checked:**'
/** The date note while the canvas is behind: `**Behind since:** YYYY-MM-DD`. */
export const BEHIND_PREFIX = '**Behind since:**'
/** The small text beneath the date note: `compared at <commit> on YYYY-MM-DD`. */
export const COMMIT_PREFIX = 'compared at '
/** A canvas not compared for this long is red. */
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000
const BLINK_MS = 600
/** The prompt goes out once the hook that saw the pull request has answered. */
const SUBMIT_DELAY_MS = 50
/** The verdict the mod stores on this machine, one entry per canvas. */
const STORED = 'architecture:'
const storedVerdictFor = (documentId: string) => `${STORED}${documentId}`

/** `gh pr create` anywhere in a command, in a pipeline or after `&&` too. */
const PR_COMMAND = /(^|[\s;&|(`])gh\s+pr\s+create\b/
/** A run that creates no pull request here: the browser does (`--web`), or nothing does (`--dry-run`). */
const PR_COMMAND_NOT = /\s--(web|dry-run)\b/
/** A GitHub connector's pull-request tool, by name: a server named after GitHub and a tool that creates a pull request. */
export const GITHUB_PR_TOOL = /^mcp__[A-Za-z0-9_-]*github[A-Za-z0-9_-]*__(create_pull_request|open_pull_request|pull_request_create|create_pr)$/i
/** A pull request's address, on GitHub or a GitHub Enterprise host. */
const PR_URL = /https?:\/\/[^\s"'<>)\]]+\/pull\/\d+/

const STATES = ['current', 'behind', 'lost'] as const
type VerdictState = (typeof STATES)[number]
const isVerdictState = (value: unknown): value is VerdictState => (STATES as readonly unknown[]).includes(value)

type Pointer = { documentId: string; title: string | null; url: string | null }

/** What the last comparison found, as the command reported it and the mod keeps it on this machine. */
type Verdict = {
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

const light = atom({ plugin: 'unpaged', key: 'architecture' } as const, null as ArchitectureLight | null)

// Module records: the pointer the working folder holds and the last verdict,
// and the comparison under way. The atom is the line's view of them.
let pointer: Pointer | null = null
let verdict: Verdict | null = null
let blink: { cancel: () => void } | null = null
/** The comparison under way: what the line showed before, and whether the turn that runs it has started. */
let comparing: { previous: ArchitectureLight; source: 'pull-request' | 'update'; started: boolean } | null = null

/** What the agent reads after a pull request: the comparison is the command's Compare section, run in its own turn. */
export const comparePrompt = (pullRequest: string | null) =>
  `The unpaged plugin sent a message: this session opened a pull request${pullRequest ? ` (${pullRequest})` : ''}, so the repository's architecture document is to be compared with the code now, as the plugin does after every pull request. Invoke the skill unpaged:architecture with the arguments "compare" and follow its Compare section to the end: it runs the comparison in a separate helper with a clean slate, marks the canvas, never rewrites a card, and ends by reporting with architecture_report, which settles the blinking line above the prompt.`
export const UPDATE_PROMPT =
  'The person pressed "update" on the architecture line above the prompt (the unpaged plugin). Update the repository\'s architecture document now: invoke the skill unpaged:architecture with the arguments "update" and follow its Update section to the end; it ends by reporting with architecture_report, which settles the line.'
export const CREATE_PROMPT =
  'The person pressed "create" on the architecture line above the prompt (the unpaged plugin). Create the repository\'s architecture document now: invoke the skill unpaged:architecture with no arguments and follow its Create section to the end.'

/** A `YYYY-MM-DD` value as given, else null. */
const day = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : null)

/** The day a `YYYY-MM-DD` note names, at midnight UTC, or null. */
function dayMs(iso: string | null) {
  if (!day(iso)) return null
  const ms = Date.parse(`${iso}T00:00:00Z`)
  return Number.isNaN(ms) ? null : ms
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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
    return { documentId: String(parsed.documentId), title: text(parsed.title) || null, url: text(parsed.url) || null }
  } catch {
    return null
  }
}

/** A path under the session's working folder, spelled out whole. */
async function inWorkingFolder($: Api, path: string) {
  const cwd = await $.session.cwd()
  return `${cwd.replace(/[\\/]+$/, '')}/${path}`
}

async function readPointer($: Api): Promise<Pointer | null> {
  try {
    const path = await inWorkingFolder($, POINTER_PATH)
    if (!(await $.fs.exists(path))) return null
    return parsePointer(await $.fs.read(path))
  } catch {
    return null
  }
}

/** Whether the working folder is a git repository (a `.git` folder, or a worktree's `.git` file). */
async function isRepository($: Api) {
  try {
    return await $.fs.exists(await inWorkingFolder($, '.git'))
  } catch {
    return false
  }
}

async function loadVerdict($: Api, documentId: string): Promise<Verdict | null> {
  const stored = (await $.store.get(storedVerdictFor(documentId))) as Partial<Verdict> | undefined
  if (!stored || stored.documentId !== documentId || !isVerdictState(stored.state)) return null
  return {
    documentId,
    state: stored.state,
    title: text(stored.title) || null,
    checkedAt: day(stored.checkedAt),
    commit: text(stored.commit) || null,
    behindSince: day(stored.behindSince),
    reportedAt: text(stored.reportedAt),
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
  let checkedAt: string | null = null
  let behindSince: string | null = null
  let commit: string | null = null
  for (const element of Array.isArray(root.elements) ? root.elements : []) {
    const content = text(element?.properties?.text).trim()
    if (content.startsWith(CHECKED_PREFIX)) {
      state = 'current'
      checkedAt = day(content.slice(CHECKED_PREFIX.length))
    } else if (content.startsWith(BEHIND_PREFIX)) {
      state = 'behind'
      behindSince = day(content.slice(BEHIND_PREFIX.length))
    } else if (content.startsWith(COMMIT_PREFIX)) {
      const [sha, , on] = content.slice(COMMIT_PREFIX.length).trim().split(/\s+/)
      commit = sha || null
      if (day(on)) checkedAt = day(on)
    }
  }
  if (!state) return null
  return { documentId, state, title: text(doc.title) || null, checkedAt, commit, behindSince, reportedAt }
}

/**
 * Reads the date note off the canvas, only where the person's rules already
 * let the plugin read a canvas on its own (a check that runs nothing and opens
 * no dialog): `lost` when the server says the canvas is gone, the note's
 * verdict when it has one, null when nothing can be said from here.
 */
async function probe($: Api, found: Pointer): Promise<Verdict | null> {
  const server = await mcpServer($)
  if ((await ruleOn($, server, 'document_get', { documentId: found.documentId })) !== 'allow') return null
  const reportedAt = new Date(await $.clock.now()).toISOString()
  try {
    const result = (await $.mcp.call(server, 'document_get', { documentId: found.documentId })) as {
      content?: Array<{ type?: string; text?: string }>
      isError?: boolean
      structuredContent?: unknown
    }
    const body = mcpText(result)
    if (result.isError) {
      return /not found|no such|does not exist|deleted|permission|forbidden|access/i.test(body)
        ? { documentId: found.documentId, state: 'lost', title: found.title, checkedAt: null, commit: null, behindSince: null, reportedAt }
        : null
    }
    return verdictFromDocument(found.documentId, result.structuredContent ?? body, reportedAt)
  } catch {
    return null
  }
}

function lightFrom(found: Pointer, known: Verdict | null): ArchitectureLight {
  return {
    documentId: found.documentId,
    title: known?.title || found.title || found.documentId,
    boardUrl: found.url || boardUrlFor(found.documentId),
    state: known ? known.state : 'unknown',
    checkedAt: dayMs(known?.checkedAt ?? null),
    commit: known?.commit ?? null,
    behindSince: dayMs(known?.behindSince ?? null),
    source: null,
    on: true,
  }
}

const NONE: ArchitectureLight = { documentId: null, title: null, boardUrl: null, state: 'none', checkedAt: null, commit: null, behindSince: null, source: null, on: true }

/**
 * Reads the pointer and the verdict stored on this machine again and draws
 * the line from them, at once; then, where the rules allow it, reads the date
 * note off the canvas and draws again from that. A comparison under way is
 * left as it is.
 */
async function refresh($: Api, { canvas = true } = {}) {
  pointer = await readPointer($)
  if (!pointer) {
    verdict = null
    const repository = await isRepository($)
    if (!comparing) await update($, light, () => (repository ? NONE : null))
    return
  }
  const found = pointer
  verdict = await loadVerdict($, found.documentId)
  if (!comparing) await update($, light, () => lightFrom(found, verdict))
  if (!canvas) return
  const probed = await probe($, found)
  if (!probed || pointer?.documentId !== found.documentId) return
  verdict = probed
  await $.store.set(storedVerdictFor(found.documentId), probed).catch(() => undefined)
  if (!comparing) await update($, light, () => lightFrom(found, probed))
}

function stopBlinking() {
  blink?.cancel()
  blink = null
}

/**
 * Starts a comparison: the line blinks yellow and, once the hook that saw the
 * pull request has answered, one prompt starts the turn that runs it. One at
 * a time; none without a pointer.
 */
async function startComparison($: Api, source: 'pull-request' | 'update', pullRequest: string | null) {
  if (comparing) return false
  if (!pointer) pointer = await readPointer($)
  if (!pointer) return false
  const current = (await read($, light)) ?? lightFrom(pointer, verdict)
  if (current.state === 'none') return false
  comparing = { previous: current, source, started: false }
  await update($, light, () => ({ ...current, state: 'comparing' as const, source, on: true }))
  stopBlinking()
  blink = $.clock.every(BLINK_MS, () => update($, light, l => (l && l.state === 'comparing' ? { ...l, on: !l.on } : l)))
  const prompt = source === 'pull-request' ? comparePrompt(pullRequest) : UPDATE_PROMPT
  $.clock.after(SUBMIT_DELAY_MS, () => {
    void $.prompt
      .submit({ text: prompt })
      .then(() => {
        if (comparing) comparing.started = true
      })
      .catch(() => giveUp($, 'its prompt could not be submitted'))
  })
  return true
}

/** The comparison under way reported nothing: the line shows what it showed before, and says why. */
async function giveUp($: Api, why: string) {
  const under = comparing
  if (!under) return
  comparing = null
  stopBlinking()
  await update($, light, () => under.previous)
  $.ui.toast(`The architecture comparison did not finish (${why}); the line shows the last known state.`, { timeoutMs: 10000 })
}

/** A verdict the command reported: kept on this machine, drawn, and said. */
async function settle($: Api, found: Pointer, reported: Verdict) {
  verdict = reported
  comparing = null
  stopBlinking()
  await $.store.set(storedVerdictFor(reported.documentId), reported).catch(() => undefined)
  await update($, light, () => lightFrom(found, reported))
}

function describe(l: ArchitectureLight, now: number) {
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

function dotColor(shown: ReturnType<typeof shownState>) {
  if (shown === 'current') return 'green'
  if (shown === 'behind' || shown === 'comparing') return 'yellow'
  if (shown === 'lost' || shown === 'stale') return 'red'
  return 'gray'
}

type Ui = ReturnType<Api['ui']['resolve']>

/** The architecture line, drawn with the surface's own elements; null while there is nothing to say. */
export async function architectureRow($: Api, ui: Ui) {
  const l = await read($, light)
  if (!l) return null
  const now = await $.clock.now()
  const { Box, Text, Button, Link } = ui
  const shown = shownState(l, now)
  const fixed = (child: ReturnType<typeof Text>) => Box({ flexShrink: 0, children: [child] })
  const button = (key: string, label: string, hotkey: string, onPress: () => void) => Button({ key, label, hotkey, plain: true, onPress })
  const link = () => {
    if (l.boardUrl) $.ui.toast(l.boardUrl, { timeoutMs: 10000 })
  }
  const create = () => void $.prompt.submit({ text: CREATE_PROMPT }).catch(() => undefined)
  const updateNow = () => void startComparison($, 'update', null).catch(() => undefined)
  const buttons =
    shown === 'none'
      ? [button('arch-create', 'create', '3', create)]
      : shown === 'lost'
        ? [button('arch-create', 'create', '3', create), button('arch-link', 'link', '4', link)]
        : shown === 'current' || shown === 'comparing'
          ? [button('arch-link', 'link', '3', link)]
          : [button('arch-update', 'update', '3', updateNow), button('arch-link', 'link', '4', link)]
  const title = l.title && l.boardUrl ? [Text({ wrap: 'truncate-end', children: [Link({ href: l.boardUrl, children: [l.title] })] })] : []
  return Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [
      fixed(Text({ color: dotColor(shown), children: [shown === 'comparing' && !l.on ? '○' : '●'] })),
      fixed(Text({ bold: true, children: ['Architecture'] })),
      ...title,
      fixed(Text({ dimColor: true, children: [`·  ${describe(l, now)}`] })),
      ...buttons,
    ],
  })
}

/** The pull request's address in a tool's answer, when it carries one. */
function pullRequestUrl(ran: { text?: unknown; result?: unknown }) {
  const haystack = [text(ran.text), typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? '')].join('\n')
  return haystack.match(PR_URL)?.[0] ?? null
}

/** Starts the comparison a pull request calls for, once the pointer names a canvas; the tool's answer goes back as it came. */
async function afterPullRequest($: Api, ran: { deny?: unknown; isError?: unknown; text?: unknown; result?: unknown }) {
  if (ran.deny !== undefined || ran.isError === true) return
  const url = pullRequestUrl(ran)
  if (!url) return
  // A pointer committed since the session started (a teammate's, pulled meanwhile) is found now.
  if (!pointer) await refresh($, { canvas: false })
  if (!pointer) return
  await startComparison($, 'pull-request', url)
}

// The hooks the engine lets a plugin register once (session.start, the
// classic SessionStart, turn.complete, session.end) are register.ts's: it
// calls these from them. The matched tool.call hooks below are this file's.

/** At session start, before the session goes on: the tool the command reports with. */
export async function registerArchitectureTool($: Api) {
  try {
    await $.tool.register({
      name: 'architecture_report',
      description:
        "Report the verdict of a comparison between the repository's architecture canvas and its code, at the end of /unpaged:architecture (create, compare or update): the line above the prompt settles on it. state is current (every claim holds), behind (some do not; behindSince is the day it fell behind) or lost (the canvas is deleted or unreachable); checkedAt is the day of the comparison and commit the commit it was made at, both as written on the canvas's date note. The documentId must be the one .unpaged/architecture.json names.",
      inputSchema: {
        type: 'object',
        properties: {
          documentId: { type: 'string' },
          state: { type: 'string', enum: [...STATES] },
          checkedAt: { type: 'string', description: 'YYYY-MM-DD' },
          commit: { type: 'string' },
          behindSince: { type: 'string', description: 'YYYY-MM-DD' },
          title: { type: 'string' },
        },
        required: ['documentId', 'state'],
      },
    })
  } catch (err) {
    $.ui.log(`architecture_report registration failed: ${String(err)}`, { to: 'debug' })
  }
}

/** Once the session has started: the line from the pointer file and the last verdict, and the canvas's date note after it, where it may be read. */
export async function startArchitecture($: Api) {
  await refresh($).catch(() => undefined)
}

/** /clear and /resume reset the atoms but not this module: draw the line again. */
export async function redrawArchitecture($: Api) {
  if (comparing) await update($, light, () => comparing!.previous).catch(() => undefined)
  else await refresh($).catch(() => undefined)
}

/** The turn that ran the comparison is over without a report: say so, and show what the line showed before. A subagent's turn is not that turn. */
export async function architectureTurnComplete($: Api, e: { agentId?: string }) {
  if (e.agentId === undefined && comparing?.started) await giveUp($, 'the turn ended without architecture_report').catch(() => undefined)
}

export function stopArchitecture() {
  stopBlinking()
}

export const registerArchitecture = (on: On) => {
  on('tool.call', { tool: 'mcp__unpaged__architecture_report' }, async ($, e) => {
    const input = e as unknown as { documentId?: unknown; state?: unknown; checkedAt?: unknown; commit?: unknown; behindSince?: unknown; title?: unknown }
    const documentId = text(input.documentId)
    if (!isDocumentId(documentId)) return { result: 'architecture_report: documentId must be the canvas id the pointer file names.' }
    if (!isVerdictState(input.state)) return { result: 'architecture_report: state must be current, behind or lost.' }
    // The pointer may have just been written (create) or changed: read it again.
    pointer = await readPointer($)
    if (!pointer || pointer.documentId !== documentId) {
      return { result: `architecture_report: ${POINTER_PATH} does not name canvas ${documentId}; write the pointer file first, then report again.` }
    }
    const checkedAt = day(input.checkedAt)
    const reported: Verdict = {
      documentId,
      state: input.state,
      title: text(input.title) || pointer.title,
      checkedAt,
      commit: text(input.commit).trim() || null,
      behindSince: input.state === 'behind' ? (day(input.behindSince) ?? checkedAt) : null,
      reportedAt: new Date(await $.clock.now()).toISOString(),
    }
    await settle($, pointer, reported)
    const l = lightFrom(pointer, reported)
    return { result: `Reported. The line above the prompt now shows the architecture document as: ${describe(l, await $.clock.now())}.` }
  })

  // A pull request the session opens from the terminal: `gh pr create`, once
  // its answer carries the pull request's address. The command runs as it
  // would; the comparison starts in a turn of its own after this one.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const command = text((e as unknown as { command?: unknown }).command)
    if (!PR_COMMAND.test(command) || PR_COMMAND_NOT.test(command)) return ran
    await afterPullRequest($, ran).catch(() => undefined)
    return ran
  })

  // A pull request the session opens through a GitHub connector's tool.
  on('tool.call', { tool: GITHUB_PR_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    await afterPullRequest($, ran).catch(() => undefined)
    return ran
  })
}
