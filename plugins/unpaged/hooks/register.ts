// The Unpaged listener mod: a session listens to a canvas's @agent comments
// from inside Claude Code. Arming mints the listener key, the poll loop runs
// in this module on the host's fetch, each new comment shows as a toast and
// starts one reply turn through a submitted prompt. An @agent comment gets an
// "On it…" reply on its thread before that turn starts, where the person's
// permission rules let the plugin post it. No model step is needed to listen,
// and the key never enters the model's context: it is kept in the plugin's
// own store (Claude Code's file for this plugin), sent in a request header,
// and never logged or shown. Nothing here runs Node: the key files and the
// key script under monitors/ belong to the Monitor that older clients run.
//
// The mod grants itself no permission: its own calls of the Unpaged tools (the
// key mint and revoke, "On it…") and the model's calls of its three tools go
// through the person's own permission rules, as any tool call does. A mint
// or revoke the plugin starts has no request of the person's behind it, so
// auto mode gives it no verdict and refuses it unless a rule allows it. Where
// no rule does, the agent mints in its own turn, where auto mode sees what
// the person asked, and the mod listens with that key and answers in its
// place; a stop the agent makes leaves the revoke to the agent the same way,
// and the mod forgets the key once the agent has revoked it.
//
// A canvas the session creates or changes through the Unpaged tools is armed
// on its own, the moment the call succeeds, once per canvas per session,
// where the rules let the plugin mint; elsewhere the agent is told, once per
// canvas, to offer listening when it hands the canvas back. A stop, a
// takeover by another session or a refused mint stays as it is until
// someone arms that canvas by hand. A canvas deleted through those tools
// stops being listened to.
//
// The loop itself is monitors/listen-loop.mjs, shared with the Monitor
// script that older clients keep using; this file is its host.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { ArchitectureLight, ArmedCanvas } from '../types'
import {
  ACK_TEXT,
  PROTOCOL_PREAMBLE,
  extractMint,
  isDocumentId,
  listenerConfigFromMint,
  parseListenerConfig,
  sameListenerConfig,
} from '../monitors/listen-core.mjs'
import { runListener } from '../monitors/listen-loop.mjs'
import { MAX_POLL_BYTES, byteLength, failure, isTerminalStatus, parseEnvelope, pollCadence, pollRequest } from '../monitors/poll-core.mjs'
import {
  BLINK_MS,
  CREATE_PROMPT,
  GITHUB_PR_TOOL,
  NONE,
  POINTER_PATH,
  PR_COMMAND,
  PR_COMMAND_NOT,
  STATES,
  SUBMIT_DELAY_MS,
  UPDATE_PROMPT,
  boardUrlFor,
  comparePrompt,
  day,
  isCommit,
  describeLight,
  lightColor,
  isVerdictState,
  lightFrom,
  parsePointer,
  pullRequestUrl,
  shownState,
  storedVerdictFor,
  text,
  verdictFromDocument,
} from './architecture-core'
import type { Pointer, Verdict } from './architecture-core'

type On = Parameters<Register>[0]
type Hook = Extract<Parameters<On>[number], (...args: never[]) => unknown>
type Api = Parameters<Hook>[0]

type ListenerConfig = {
  pollUrl: string
  key: string
  documentId: string
  keyId: string | null
  title: string
  cwd: string | null
  createdAt: string | null
}

type Loop = {
  config: ListenerConfig
  controller: AbortController
  done: Promise<unknown>
  pending: string[]
  pendingEvents: number
  /** The "On it…" replies the next flush waits for, each answering the line the agent reads about it. */
  acks: Array<Promise<string | null>>
  /** Threads those replies go to: two @agent comments in one thread on one poll get one "On it…". */
  ackThreads: Set<string>
  flush: { cancel: () => void } | null
  settled: Promise<string>
}

const MCP_SERVER = 'unpaged'
const PANE = 'unpaged-listening'
const FIRST_POLL_WAIT_MS = 8000
const FLUSH_DELAY_MS = 50
/** How long a turn waits for its "On it…" replies before it starts without them. */
const ACK_WAIT_MS = 5000
/** Event ids already answered with "On it…", kept so a reload's replayed poll does not answer them twice. */
const ACKED_LIMIT = 200
/** session.end reasons that end listening; `clear` and `resume` keep it. */
const ENDING_REASONS = new Set(['logout', 'prompt_input_exit', 'other'])

/** The Unpaged MCP server's tools, by the name the model calls them: `mcp__plugin_unpaged_unpaged__…` installed with this plugin, `mcp__unpaged__…` added by hand. */
const unpagedTool = (names: readonly string[]) => new RegExp(`^mcp__(plugin_unpaged_)?unpaged[A-Za-z0-9-]*__(${names.join('|')})$`)
/** The tools that make a canvas: the new document is their answer. */
const CREATES = ['document_create', 'template_clone'] as const
/** The tools that change what is on a canvas: the canvas is their `documentId`. */
const EDITS = [
  'element_create',
  'element_update',
  'element_delete',
  'checklist_toggle_item',
  'table_append_row',
  'table_update_cell',
  'batch_create_elements',
  'batch_update_elements',
  'batch_delete_elements',
  'batch_reorder_elements',
  'node_create',
  'node_create_with_elements',
  'node_create_with_id',
  'node_update',
  'node_delete',
] as const

const armed = atom({ plugin: 'unpaged', key: 'armed' } as const, [] as ArmedCanvas[])
const replying = atom({ plugin: 'unpaged', key: 'replying' } as const, [] as string[])
const armedOnce = atom({ plugin: 'unpaged', key: 'armedOnce' } as const, [] as string[])
const acked = atom({ plugin: 'unpaged', key: 'acked' } as const, [] as string[])

// Module records: the truth for what this module runs. The atoms are the
// band's view of them, rewritten on every change; after a hot reload the
// atoms are what is left, and the loops are started again from them.
const canvases = new Map<string, ArmedCanvas>()
const loops = new Map<string, Loop>()
/** Arms in flight, so two calls for one canvas mint one key, not two. */
const arming = new Map<string, Promise<ArmResult>>()
/** Every canvas this session has armed, by hand or on its own; only a canvas not in it is armed on its own. */
const armedBefore = new Set<string>()
/** Event ids answered with "On it…", oldest first. */
const ackedEvents = new Set<string>()
/** Canvases whose mint the rules do not leave to the plugin: the agent was told once to offer listening (nothing, where the rules deny the mint). */
const offered = new Set<string>()
/** Keys the agent minted in its own turn, by canvas: the arm that follows keeps that key instead of minting another. */
const agentMints = new Map<string, unknown>()
/** Titles listen_arm was given for a canvas whose key it left to the agent, for the band once the agent mints. */
const titlesAsked = new Map<string, string>()
/**
 * Keys a stop or an arm could not revoke (refused or failed) or left to the
 * agent, by canvas: the next stop of that canvas in this module's life
 * revokes them with its own, and the agent's own revoke of one forgets it.
 * Past a reload or the session, `/unpaged:listen revoke` finds them on the
 * server by this machine's label, and Unpaged lists them too. The newer key
 * already shuts a replaced one out of polling.
 */
const unrevoked = new Map<string, string[]>()

function rememberUnrevoked(documentId: string, keyId: string) {
  const ids = unrevoked.get(documentId) ?? []
  if (!ids.includes(keyId)) unrevoked.set(documentId, [...ids, keyId])
}

function forgetUnrevoked(documentId: string, keyId: string) {
  const ids = (unrevoked.get(documentId) ?? []).filter(id => id !== keyId)
  if (ids.length > 0) unrevoked.set(documentId, ids)
  else unrevoked.delete(documentId)
}

/** `leftToAgent`: the key this arm replaced, left for the agent to revoke in the turn it minted in. */
type ArmResult = { already: boolean; canvas: ArmedCanvas | undefined; first?: string; leftToAgent?: string }

/**
 * A canvas's key in the plugin's store, one entry per canvas. Claude Code
 * keeps that store in a file of the plugin's own under its configuration
 * directory (mode 600), shared by this machine's sessions and kept between
 * them, so an arm can revoke the key an earlier session stored.
 */
const STORED_KEY = 'listener:'
const storedKeyFor = (documentId: string) => `${STORED_KEY}${documentId}`

async function loadConfig($: Api, documentId: string): Promise<ListenerConfig | null> {
  if (!isDocumentId(documentId)) return null
  const stored = await $.store.get(storedKeyFor(documentId))
  if (stored === undefined) return null
  const config = parseListenerConfig(JSON.stringify(stored)) as ListenerConfig | null
  return config && config.documentId === documentId ? config : null
}

/**
 * Forgets a canvas's stored key only if it is still the one `matches`
 * names: another session may have stored a newer key for the canvas. The
 * store has no compare-and-delete, so a newer key stored between the read
 * and the delete is lost to that session's reload and next arm; its
 * listener goes on polling from memory.
 */
async function retireStored($: Api, documentId: string, matches: (stored: ListenerConfig) => boolean) {
  const stored = await loadConfig($, documentId)
  if (!stored) return 'absent'
  if (!matches(stored)) return 'kept-newer'
  await $.store.delete(storedKeyFor(documentId))
  return 'removed'
}

let hostName: string | null = null

/** The host up to its first dot, from a run that exited 0, else null. */
const shortHost = (ran: { exitCode: number; stdout: string } | null) => (ran?.exitCode === 0 ? ran.stdout.trim().split('.')[0] : '') || null

/**
 * The label a key is minted with, `claude-code on <host>`: `/unpaged:listen
 * revoke all` knows this machine's keys by it. The host is what `hostname`
 * prints (macOS, Windows and most Linux), else `uname -n` (some Linux images
 * ship no `hostname`), up to its first dot: the name Node's `os.hostname()`
 * gives the Monitor path's key script. Each command is written whole at its
 * call, so the plugin directory reads what runs off the source.
 */
async function keyLabel($: Api) {
  if (!hostName) hostName = shortHost(await $.process.run(['hostname'], { timeoutMs: 5000 }).catch(() => null))
  if (!hostName) hostName = shortHost(await $.process.run(['uname', '-n'], { timeoutMs: 5000 }).catch(() => null))
  return `claude-code on ${hostName ?? 'this machine'}`
}

async function mcpServer($: Api) {
  try {
    const connected = (await $.mcp.connect(MCP_SERVER)) as { isConnected?: boolean; server?: string }
    if (connected.isConnected && connected.server) return connected.server
  } catch {
    // fall through to the manifest name
  }
  return MCP_SERVER
}

/** An MCP tool as the person's permission rules name it: `mcp__plugin_unpaged_unpaged__comment_reply` installed with this plugin. */
const ruleName = (server: string, tool: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`

/**
 * Whether the person's own permission rules already let `tool` run: asked
 * without running it, so no dialog opens and no classifier is asked. The
 * mod's own calls of MCP tools go through those rules either way.
 */
async function isAllowed($: Api, server: string, tool: string, input: Record<string, unknown>) {
  return (await ruleOn($, server, tool, input)) === 'allow'
}

/** The rules' answer for `tool`, asked the same way: `allow`, `deny`, or `ask` for anything else (no rule, or no answer). */
async function ruleOn($: Api, server: string, tool: string, input: Record<string, unknown>): Promise<'allow' | 'deny' | 'ask'> {
  try {
    const decision = (await $.tool.check({ tool: ruleName(server, tool), input })).decision
    return decision === 'allow' || decision === 'deny' ? decision : 'ask'
  } catch {
    return 'ask'
  }
}

function mcpText(result: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown }) {
  const block = result.content?.find(b => b.type === 'text' && typeof b.text === 'string')
  return block?.text ?? (result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent))
}

/**
 * The person's permission rules on a canvas's key mint, asked without minting,
 * so no dialog opens and no classifier runs: `allow` lets the plugin mint on
 * its own, `deny` lets nobody mint, and `ask` leaves the mint to the agent.
 */
async function mintRule($: Api, documentId: string) {
  return ruleOn($, await mcpServer($), 'agent_listener_key_create', { documentId, label: await keyLabel($) })
}

/** The rules on a key's revoke, asked as the mint's are: `allow` lets the plugin revoke on its own, `deny` lets nobody, `ask` leaves it to the agent. */
async function revokeRule($: Api, keyId: string) {
  return ruleOn($, await mcpServer($), 'agent_listener_key_revoke', { keyId })
}

/** Mints a fresh key for the canvas, or takes the one the agent just minted, and keeps it in the plugin's store. */
async function mint($: Api, documentId: string): Promise<ListenerConfig> {
  const given = agentMints.get(documentId)
  if (given !== undefined) {
    agentMints.delete(documentId)
    return storeMint($, documentId, given)
  }
  const server = await mcpServer($)
  const result = (await $.mcp.call(server, 'agent_listener_key_create', {
    documentId,
    label: await keyLabel($),
  })) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean; structuredContent?: unknown }
  const body = mcpText(result)
  if (result.isError) throw new Error(`the server refused to mint a listener key: ${body.slice(0, 200)}`)
  const found = extractMint(result.structuredContent ?? body)
  if (!found) throw new Error('the mint result carried no listener key')
  return storeMint($, documentId, found)
}

/** Keeps a mint in the plugin's store, under the canvas it was asked for and only that one. */
async function storeMint($: Api, documentId: string, found: unknown): Promise<ListenerConfig> {
  const config = listenerConfigFromMint(found, { cwd: await $.session.cwd(), createdAt: new Date().toISOString() }) as ListenerConfig | null
  if (!config) throw new Error('the mint result is not a valid listener config (it must name an Unpaged HTTPS polling endpoint)')
  if (config.documentId !== documentId) throw new Error(`the mint is for canvas ${config.documentId}, not ${documentId}`)
  await $.store.set(storedKeyFor(documentId), config)
  return config
}

async function revoke($: Api, keyId: string | null) {
  if (!keyId) return false
  try {
    const server = await mcpServer($)
    const result = (await $.mcp.call(server, 'agent_listener_key_revoke', { keyId })) as { isError?: boolean }
    return !result.isError
  } catch {
    return false
  }
}

async function sync($: Api) {
  const list = [...canvases.values()].sort((a, b) => a.armedAt - b.armedAt)
  await update($, armed, () => list)
  await update($, armedOnce, () => [...armedBefore])
  await update($, acked, () => [...ackedEvents])
}

function record(documentId: string, changes: Partial<ArmedCanvas>) {
  const current = canvases.get(documentId)
  if (!current) return
  canvases.set(documentId, { ...current, ...changes })
}

/** The host's fetch as the loop's poll: one request, the body read whole, raced against a deadline. */
function pollWith($: Api) {
  return async (
    binding: ListenerConfig,
    settings: { signal?: AbortSignal; cursor: string | null; timeoutMs: number },
  ): Promise<
    | { events: Array<Record<string, unknown>>; nextCursor: string | null; cadence: { intervalMs?: number; idleIntervalMs?: number } }
    | { terminal: number }
  > => {
    const { url, headers } = pollRequest(binding, settings.cursor)
    let rejectLate: (error: Error) => void = () => {}
    const timedOut = new Promise<never>((_resolve, reject) => {
      rejectLate = reject
    })
    const deadline = $.clock.after(settings.timeoutMs, () => rejectLate(failure('poll_timeout')))
    try {
      // The host reads the body whole before answering and follows redirects on
      // its own (its fetch exposes neither a redirect mode nor the final URL), so
      // the ceiling is checked on the text's UTF-8 bytes once it is here, and a
      // redirected body is caught by the envelope validation rather than refused
      // up front as poll.mjs does.
      const response = await Promise.race([$.http.fetch(url, { headers }), timedOut])
      if (settings.signal?.aborted) throw failure('poll_aborted')
      if (isTerminalStatus(response.status)) return { terminal: response.status }
      if (response.status !== 200) throw failure('poll_http_error')
      if (byteLength(response.text) > MAX_POLL_BYTES) throw failure('poll_body_limit')
      // The host hands the headers over with lower-cased names.
      return { ...parseEnvelope(response.text, binding.documentId), cadence: pollCadence(name => response.headers?.[name]) }
    } finally {
      deadline.cancel()
    }
  }
}

function sleepWith($: Api) {
  return (ms: number, signal?: AbortSignal) =>
    new Promise<void>(resolve => {
      if (signal?.aborted) return resolve()
      const timer = $.clock.after(ms, () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      })
      const onAbort = () => {
        timer.cancel()
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
}

function isEventLine(line: string) {
  try {
    const parsed = JSON.parse(line) as { type?: unknown }
    return Boolean(parsed) && parsed.type === 'agent-inbox-event'
  } catch {
    return false
  }
}

/**
 * Replies "On it…" on the thread of an @agent comment, once per event: a
 * reload's first poll replays the last two minutes, and an id already
 * answered is not answered again. Only where the person's own permission
 * rules already allow `comment_reply`: otherwise the agent posts it in its
 * turn, under those rules, and the plugin raises no dialog of its own.
 * Resolves to the line the agent reads about it, within ACK_WAIT_MS; a reply
 * still on its way by then is not posted twice.
 */
function acknowledge($: Api, documentId: string, event: Record<string, unknown>): Promise<string | null> {
  const id = text(event.id)
  const threadId = text(event.threadId)
  if (event.reason !== 'mention' || !id || !isDocumentId(threadId)) return Promise.resolve(null)
  const posted = `The unpaged plugin already replied "${ACK_TEXT}" on thread ${threadId}; do not post another, and it is not your answer.`
  const reply = (async () => {
    try {
      if (ackedEvents.has(id)) return posted
      ackedEvents.add(id)
      if (ackedEvents.size > ACKED_LIMIT) ackedEvents.delete(ackedEvents.values().next().value as string)
      await update($, acked, () => [...ackedEvents])
      const server = await mcpServer($)
      const args = { documentId, threadId, text: ACK_TEXT }
      if (!(await isAllowed($, server, 'comment_reply', args))) {
        return `The unpaged plugin leaves "${ACK_TEXT}" on thread ${threadId} to you (your permission rules do not let it reply on its own); post it there yourself first.`
      }
      const result = (await $.mcp.call(server, 'comment_reply', args)) as { isError?: boolean }
      if (!result.isError) return posted
    } catch {
      // the agent posts it instead
    }
    return `The unpaged plugin could not reply "${ACK_TEXT}" on thread ${threadId}; post it there yourself first.`
  })()
  return new Promise(resolve => {
    const late = $.clock.after(ACK_WAIT_MS, () =>
      resolve(`The unpaged plugin is replying "${ACK_TEXT}" on thread ${threadId}; do not post another, and it is not your answer.`),
    )
    void reply.then(note => {
      late.cancel()
      resolve(note)
    })
  })
}

/** One submitted prompt per poll: the preamble once, then every new line. The toast is per event. */
function sayWith($: Api, documentId: string) {
  return async (line: string) => {
    const loop = loops.get(documentId)
    const canvas = canvases.get(documentId)
    if (!loop || !canvas) return
    if (line !== PROTOCOL_PREAMBLE) {
      let event: Record<string, unknown> | null = null
      try {
        event = JSON.parse(line)
      } catch {
        event = null
      }
      if (event && event.type === 'agent-inbox-event') {
        record(documentId, { unread: canvas.unread + 1, lastEventAt: await $.clock.now() })
        await sync($)
        const who = text(event.authorName) || 'someone'
        $.ui.toast(`${who} @agent on ${canvas.title || documentId}: ${text(event.textPreview).slice(0, 120)}`, { timeoutMs: 8000 })
        const thread = text(event.threadId)
        if (event.reason === 'mention' && !loop.ackThreads.has(thread)) {
          loop.ackThreads.add(thread)
          loop.acks.push(acknowledge($, documentId, event))
        }
      } else {
        $.ui.toast(line.slice(0, 160), { timeoutMs: 8000 })
      }
    }
    loop.pending.push(line)
    if (line !== PROTOCOL_PREAMBLE) loop.pendingEvents += isEventLine(line) ? 1 : 0
    loop.flush?.cancel()
    loop.flush = $.clock.after(FLUSH_DELAY_MS, () => {
      const lines = loop.pending.splice(0)
      const acks = loop.acks.splice(0)
      loop.ackThreads.clear()
      const events = loop.pendingEvents
      loop.pendingEvents = 0
      loop.flush = null
      if (lines.length === 0) return
      // The "On it…" replies go out before the turn starts, so they come first on the canvas.
      const submit = (notes: Array<string | null>) => $.prompt.submit({ text: [...lines, ...notes.filter(Boolean)].join('\n') })
      // The submit resolves when its turn starts; from then until turn.complete
      // the canvas counts as covered, and only when the turn was handed a comment.
      void (acks.length === 0 ? submit([]) : Promise.all(acks).then(submit))
        .then(() => (events > 0 ? update($, replying, list => (list.includes(documentId) ? list : [...list, documentId])) : undefined))
        .catch(() => undefined)
    })
  }
}

/** Starts the loop for a stored key. The caller has already recorded the canvas. */
async function startLoop($: Api, config: ListenerConfig) {
  const { documentId } = config
  const controller = new AbortController()
  let settle: (state: string) => void = () => {}
  const settled = new Promise<string>(resolve => {
    settle = resolve
  })
  const loop: Loop = { config, controller, done: Promise.resolve(), pending: [], pendingEvents: 0, acks: [], ackThreads: new Set(), flush: null, settled }
  loops.set(documentId, loop)
  const reportStatus = async (state: string, reason: string | null | undefined) => {
    const known = state === 'connecting' || state === 'connected' || state === 'reconnecting' || state === 'stopped' ? state : 'reconnecting'
    record(documentId, { state: known, reason: reason ?? null })
    await sync($)
    if (state !== 'connecting') settle(state)
  }
  loop.done = runListener(config, {
    poll: pollWith($),
    sleep: sleepWith($),
    say: sayWith($, documentId),
    now: () => Date.now(),
    reportStatus,
    retireKey: () => retireStored($, documentId, stored => sameListenerConfig(stored, config)),
    signal: controller.signal,
  })
    .catch(() => ({ reason: 'failed' }))
    .then(async (result: { reason?: string }) => {
      if (loops.get(documentId) === loop) loops.delete(documentId)
      record(documentId, { state: 'stopped', reason: result?.reason ?? 'stopped' })
      // The band's view is advisory, and the module may be gone by now (a reload, a test's end).
      await sync($).catch(() => undefined)
      settle('stopped')
      return result
    })
  return loop
}

function arm($: Api, documentId: string, title: string | null): Promise<ArmResult> {
  if (!isDocumentId(documentId)) return Promise.reject(new Error('not a document id'))
  if (loops.has(documentId)) return Promise.resolve({ already: true, canvas: canvases.get(documentId) })
  const inFlight = arming.get(documentId)
  if (inFlight) return inFlight.then(result => ({ ...result, already: true }))
  const run = armNow($, documentId, title).finally(() => arming.delete(documentId))
  arming.set(documentId, run)
  return run
}

async function armNow($: Api, documentId: string, title: string | null): Promise<ArmResult> {
  armedBefore.add(documentId)
  await update($, armedOnce, () => [...armedBefore])
  const previous = await loadConfig($, documentId)
  const byAgent = agentMints.has(documentId)
  const config = await mint($, documentId)
  const name = title || config.title || previous?.title || documentId
  // The key this one replaces: the new key already shuts it out of polling, so
  // the arm does not wait on it; a revoke refused or failed is said, and kept
  // for the canvas's next stop. Where the agent made the mint and the rules do
  // not let the plugin revoke on its own (auto mode would refuse it), the
  // agent revokes it in the same turn, and the revoke hook forgets it.
  const replaced = previous?.keyId && previous.keyId !== config.keyId ? previous.keyId : null
  let leftToAgent: string | undefined
  if (replaced && byAgent && (await revokeRule($, replaced)) !== 'allow') {
    rememberUnrevoked(documentId, replaced)
    leftToAgent = replaced
  } else if (replaced) {
    void revoke($, replaced).then(isRevoked => {
      if (isRevoked) return forgetUnrevoked(documentId, replaced)
      rememberUnrevoked(documentId, replaced)
      $.ui.toast(`Listening on ${name} with a new key; the key it replaced (${replaced}) is still live, though shut out of polling: ask Claude to revoke listener key ${replaced}, or revoke it in Unpaged. Listening goes on.`, { timeoutMs: 10000 })
    }).catch(() => undefined)
  }
  canvases.set(documentId, {
    documentId,
    keyId: config.keyId,
    title: name,
    boardUrl: boardUrlFor(documentId),
    armedAt: await $.clock.now(),
    state: 'connecting',
    reason: null,
    unread: 0,
    lastEventAt: null,
  })
  await sync($)
  const loop = await startLoop($, { ...config, title: name })
  // Say what is true: wait a bounded moment for the first poll before answering.
  const first = await Promise.race([loop.settled, new Promise<string>(resolve => $.clock.after(FIRST_POLL_WAIT_MS, () => resolve('pending')))])
  return { already: false, canvas: canvases.get(documentId), first, leftToAgent }
}

/**
 * Stops listening to a canvas and revokes its key, with the older keys this
 * session could not revoke. With `leaveToAgent`, for a stop the agent makes in
 * its turn, a key whose revoke the rules do not leave to the plugin is not
 * tried: it is kept as unrevoked, in `toAgent` where the agent may revoke it
 * (auto mode would refuse the plugin's own) and in `denied` where nobody may.
 */
async function stop($: Api, documentId: string, { leaveToAgent = false } = {}) {
  const loop = loops.get(documentId)
  const canvas = canvases.get(documentId)
  if (loop) {
    loop.controller.abort()
    await loop.done
  }
  // A key the server answered 401 is revoked or invalid already, and the loop
  // retired its file: there is nothing to revoke and no permission to ask for.
  // The older keys this session could not revoke are not covered by that 401.
  const rejected = !loop && canvas?.reason === 'http-401'
  const current = rejected ? null : (loop?.config.keyId ?? canvas?.keyId ?? null)
  const keyIds = [...new Set([current, ...(unrevoked.get(documentId) ?? [])])].filter((id): id is string => Boolean(id))
  unrevoked.delete(documentId)
  const toAgent: string[] = []
  const denied: string[] = []
  for (const keyId of keyIds) {
    const rule = leaveToAgent ? await revokeRule($, keyId) : 'allow'
    if (rule !== 'allow') {
      rememberUnrevoked(documentId, keyId)
      if (rule === 'deny') denied.push(keyId)
      else toAgent.push(keyId)
      continue
    }
    if (!(await revoke($, keyId))) {
      rememberUnrevoked(documentId, keyId)
      continue
    }
    // The stored key goes only if it is still the one just revoked: another
    // session may have re-armed the canvas and stored a newer key for it.
    const config = loop && keyId === loop.config.keyId ? loop.config : null
    await retireStored($, documentId, stored => (config ? sameListenerConfig(stored, config) : stored.keyId === keyId))
  }
  canvases.delete(documentId)
  await sync($)
  const left = unrevoked.get(documentId) ?? []
  return { title: canvas?.title ?? documentId, revoked: keyIds.length > 0 && left.length === 0, keyId: left[0] ?? keyIds[0] ?? null, left, toAgent, denied }
}

/**
 * Forgets a key the agent revoked in its own turn (as `/unpaged:listen revoke`
 * has it do where auto mode refuses the plugin's revoke): on every canvas that
 * kept it unrevoked, and in the store, on whichever canvas still holds it, so
 * no later arm or status takes it for live.
 */
async function forgetRevoked($: Api, keyId: string) {
  if (!keyId) return
  for (const [documentId, ids] of [...unrevoked]) if (ids.includes(keyId)) forgetUnrevoked(documentId, keyId)
  for (const name of await $.store.keys()) {
    if (name.startsWith(STORED_KEY)) await retireStored($, name.slice(STORED_KEY.length), stored => stored.keyId === keyId)
  }
}

/** What a stop with no turn of the agent's says of a key it could not revoke: asking Claude to stop listening has the agent revoke it. */
function stillLive(result: { title: string; left: string[] }) {
  return `its key is still live (keyId ${result.left.join(', ')}): ask Claude to stop listening to ${result.title}, or revoke it in Unpaged.`
}

/**
 * A stop no answer reports (a press, a delete): when the revoke was refused
 * or failed, a toast says the key is still live, as `/unpaged-listen stop`
 * says it in its answer.
 */
async function stopAndSay($: Api, documentId: string) {
  const result = await stop($, documentId)
  if (!result.revoked && result.keyId) {
    $.ui.toast(`Stopped listening to ${result.title}; ${stillLive(result)}`, { timeoutMs: 10000 })
  }
  return result
}

/** The new document a create tool answered with: in the JSON the model reads, or in the tool's own record. */
function createdDocument(value: unknown): { id: string; title: string } | null {
  if (typeof value === 'string') {
    try {
      return createdDocument(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const found = createdDocument((block as { text?: unknown } | null)?.text)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (Array.isArray(record.content)) return createdDocument(record.content)
  return isDocumentId(record.id) ? { id: String(record.id), title: text(record.title) } : null
}

/** What the agent reads, once per canvas, where the rules keep the plugin from minting the canvas's key on its own. */
function offerLine(documentId: string, title: string | null) {
  const name = title ? `"${title}"` : 'this whiteboard'
  return `The unpaged plugin can bring @agent comments on ${name} into this session while you work, but the person's permission rules do not let it create the listener key on its own. When you hand the whiteboard back, offer that in one short question. Only if they say yes, call agent_listener_key_create with documentId ${documentId}: the plugin keeps the key out of this conversation and starts listening.`
}

/** What listen_arm answers where the rules deny the mint to everyone. */
const MINT_DENIED = "Push is not armed: the person's permission rules deny agent_listener_key_create, so no listener key can be created for this canvas, by the plugin or by you. Do not call it; say that listening needs that rule lifted."

/** What listen_arm answers where the rules keep the plugin from minting: the agent mints in its turn. */
function mintYourselfLine(documentId: string) {
  return `Not listening yet: the person's permission rules do not let the plugin create this canvas's listener key on its own. Call agent_listener_key_create with documentId ${documentId} now; the plugin takes the key from its answer and starts listening, and the key never reaches you.`
}

/** What listen_stop adds where the rules keep the plugin from revoking: the agent revokes in its turn. */
function revokeYourselfLine(keyIds: string[]) {
  return ` Its listener key is still live: the person's permission rules do not let the plugin revoke it on its own. Revoke it now with agent_listener_key_revoke and keyId ${keyIds.join(', then keyId ')}; the plugin forgets it once it is revoked.`
}

/** What listen_stop adds where the rules deny the revoke to everyone. */
function revokeDeniedLine(keyIds: string[]) {
  return ` Its listener key is still live (keyId ${keyIds.join(', ')}): the person's permission rules deny agent_listener_key_revoke, so neither the plugin nor you can revoke it. Do not call it; say that it can be revoked in Unpaged, or once that rule is lifted.`
}

/**
 * Listens with a key the agent minted in its own turn and answers in the
 * mint's place, so the key never reaches the conversation. A key that turns
 * out not to be needed (the canvas was armed meanwhile) or that could not be
 * listened with is revoked by the canvas's next stop.
 */
async function listenWithAgentMint($: Api, documentId: string, found: unknown) {
  const keyId = text((found as { keyId?: unknown } | null)?.keyId) || null
  agentMints.set(documentId, found)
  try {
    const result = await arm($, documentId, titlesAsked.get(documentId) ?? null)
    titlesAsked.delete(documentId)
    if (result.already) {
      agentMints.delete(documentId)
      if (keyId && keyId !== result.canvas?.keyId) rememberUnrevoked(documentId, keyId)
      return { result: `Already listening: ${describe(result.canvas)}. The unpaged plugin keeps the key out of this conversation; new @agent comments arrive as a message from it. Never repeat key material.` }
    }
    const earlier = result.leftToAgent
      ? ` This canvas's earlier key (keyId ${result.leftToAgent}) is still live, though shut out of polling: revoke it now with agent_listener_key_revoke and keyId ${result.leftToAgent}; the plugin forgets it once it is revoked.`
      : ''
    return { result: `Listening on ${describe(result.canvas, result.first)}. The unpaged plugin keeps the key out of this conversation; new @agent comments arrive as a message from it. Never repeat key material.${earlier}` }
  } catch (err) {
    agentMints.delete(documentId)
    if (keyId) rememberUnrevoked(documentId, keyId)
    return {
      result: `The listener key was created but listening did not start: ${String((err as Error)?.message ?? err)}. The key stays out of this conversation; /unpaged:listen revoke ${documentId} revokes it${keyId ? ` (keyId ${keyId})` : ''}.`,
    }
  }
}

/** Arms a canvas the session just made or changed, unless this session has armed it before. */
function armOnItsOwn($: Api, documentId: string, title: string | null) {
  if (!isDocumentId(documentId) || armedBefore.has(documentId) || arming.has(documentId) || loops.has(documentId)) return
  arm($, documentId, title).catch((err: unknown) => {
    $.ui.toast(`Not listening to ${title || documentId}: ${String((err as Error)?.message ?? err)}`, { timeoutMs: 8000 })
  })
}

const timeLabel = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The canvas's address whole, as a toast: a terminal that draws no links cuts it on the band. */
function showLink($: Api, canvas: ArmedCanvas) {
  $.ui.toast(canvas.boardUrl, { timeoutMs: 10000 })
}

async function stopAll($: Api) {
  for (const documentId of [...canvases.keys()]) await stopAndSay($, documentId)
}

function statusLabel(canvas: ArmedCanvas, isWorking: boolean, isReplying: boolean) {
  if (canvas.state === 'stopped') return `push off${canvas.reason ? ` (${canvas.reason})` : ''}`
  if (canvas.state === 'connecting') return 'connecting'
  if (canvas.state === 'reconnecting') return 'reconnecting'
  const fresh = canvas.unread > 0 ? `${canvas.unread} new` : 'no new comments'
  if (isWorking && isReplying) return `${fresh}  ·  replying on the canvas`
  return canvas.unread > 0 ? fresh : `${fresh}  ·  armed ${timeLabel(canvas.armedAt)}`
}

function dotColor(canvas: ArmedCanvas) {
  if (canvas.state === 'stopped') return 'red'
  if (canvas.state !== 'connected') return 'gray'
  return canvas.unread > 0 ? 'yellow' : 'green'
}

function describe(canvas: ArmedCanvas | undefined, first?: string) {
  if (!canvas) return 'nothing armed'
  const state = first === 'pending' ? 'armed, first poll pending' : canvas.state
  const unread = canvas.unread ? `, ${canvas.unread} new` : ''
  return `${canvas.title} (${canvas.documentId}): ${state}${canvas.reason ? ` (${canvas.reason})` : ''}${unread}`
}

async function statusText($: Api) {
  const lines = [...canvases.values()].map(c => describe(c))
  const stored: string[] = []
  const cwd = await $.session.cwd()
  for (const name of await $.store.keys()) {
    if (!name.startsWith(STORED_KEY)) continue
    const config = await loadConfig($, name.slice(STORED_KEY.length))
    // Which folder armed it, as the Monitor path's lister says: `/unpaged:listen` offers this folder's first.
    const folder = config?.cwd === cwd ? 'this folder' : 'other folder'
    if (config) stored.push(`${config.title || config.documentId} (${config.documentId}): ${folder}, key ${config.keyId ?? 'with no id'}, stored ${config.createdAt ?? 'at an unknown time'}`)
  }
  const left = [...unrevoked].map(([documentId, ids]) => `${canvases.get(documentId)?.title || documentId} (${documentId}): keyId ${ids.join(', ')}`)
  return [
    lines.length ? `Listening in this session:\n${lines.join('\n')}` : 'Nothing is armed in this session.',
    `Keys the plugin stores on this machine:\n${stored.join('\n') || 'none'}`,
    `Keys this session could not revoke:\n${left.join('\n') || 'none'}`,
    `This machine's key label: ${await keyLabel($)}`,
  ].join('\n\n')
}

async function restoreAfterReload($: Api) {
  for (const documentId of await read($, armedOnce)) armedBefore.add(documentId)
  for (const id of await read($, acked)) ackedEvents.add(id)
  const kept = await read($, armed)
  for (const canvas of kept) {
    armedBefore.add(canvas.documentId)
    if (canvas.state === 'stopped' || loops.has(canvas.documentId)) continue
    const config = await loadConfig($, canvas.documentId)
    if (!config) continue
    canvases.set(canvas.documentId, { ...canvas, state: 'connecting', reason: null })
    await startLoop($, { ...config, title: canvas.title })
  }
  await sync($)
}

// ---------------------------------------------------------------------------
// The architecture line: its state and its hooks' work (its pure part is architecture-core.ts).

const light = atom({ plugin: 'unpaged', key: 'architecture' } as const, null as ArchitectureLight | null)

// Module records: the pointer the working folder holds and the last verdict,
// and the comparison under way. The atom is the line's view of them.
let pointer: Pointer | null = null
let verdict: Verdict | null = null
let blink: { cancel: () => void } | null = null
/**
 * The comparison under way: what the line showed before, whether the turn
 * that runs it has started, and the agents the session already had when it
 * did, so a helper that turn starts is told from an earlier background agent.
 */
let comparing: { previous: ArchitectureLight; source: 'pull-request' | 'update'; started: boolean; earlier: Set<string> } | null = null

/**
 * The repository's top level: the nearest folder at or above the session's
 * working folder that holds `.git` (a folder, or a worktree's file), spelled
 * out whole; null outside a repository. A session started in a subfolder of
 * a monorepo finds the pointer file at the top, where the command writes it.
 */
async function repositoryRoot($: Api): Promise<string | null> {
  let folder = (await $.session.cwd()).replace(/[\\/]+$/, '')
  for (let depth = 0; depth < 64; depth++) {
    try {
      if (await $.fs.exists(`${folder}/.git`)) return folder
    } catch {
      return null
    }
    const up = folder.replace(/[\\/][^\\/]*$/, '')
    if (up === folder || up === '') return null
    folder = up
  }
  return null
}

async function readPointer($: Api): Promise<Pointer | null> {
  try {
    const root = await repositoryRoot($)
    if (!root) return null
    const path = `${root}/${POINTER_PATH}`
    if (!(await $.fs.exists(path))) return null
    return parsePointer(await $.fs.read(path))
  } catch {
    return null
  }
}

/** Whether the working folder is in a git repository. */
async function isRepository($: Api) {
  return (await repositoryRoot($)) !== null
}

async function loadVerdict($: Api, documentId: string): Promise<Verdict | null> {
  const stored = (await $.store.get(storedVerdictFor(documentId))) as Partial<Verdict> | undefined
  if (!stored || stored.documentId !== documentId || !isVerdictState(stored.state)) return null
  return {
    documentId,
    state: stored.state,
    title: text(stored.title) || null,
    checkedAt: day(stored.checkedAt),
    commit: isCommit(stored.commit) ? stored.commit : null,
    behindSince: day(stored.behindSince),
    reportedAt: text(stored.reportedAt),
  }
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

/** The dot blinks while a comparison runs: the line reads the phase. */
function startBlinking($: Api) {
  stopBlinking()
  blink = $.clock.every(BLINK_MS, () => update($, light, l => (l && l.state === 'comparing' ? { ...l, on: !l.on } : l)))
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
  comparing = { previous: current, source, started: false, earlier: new Set() }
  await update($, light, () => ({ ...current, state: 'comparing' as const, source, on: true }))
  startBlinking($)
  const prompt = source === 'pull-request' ? comparePrompt(pullRequest) : UPDATE_PROMPT
  $.clock.after(SUBMIT_DELAY_MS, () => {
    const submitted = $.prompt.submit({ text: prompt })
    void submitted.then(async () => {
      const under = comparing
      if (!under) return
      // The agents the session had as the turn starts: any running later, outside this set, is the turn's helper.
      under.earlier = new Set((await agentIds($)).map(agent => agent.id))
      under.started = true
    }).catch(() => giveUp($, 'its prompt could not be submitted'))
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
async function settleVerdict($: Api, found: Pointer, reported: Verdict) {
  verdict = reported
  comparing = null
  stopBlinking()
  await $.store.set(storedVerdictFor(reported.documentId), reported).catch(() => undefined)
  await update($, light, () => lightFrom(found, reported))
}

type Ui = ReturnType<Api['ui']['resolve']>

/** The architecture line, drawn with the surface's own elements; null while there is nothing to say. */
async function architectureRow($: Api, ui: Ui) {
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
      fixed(Text({ color: lightColor(shown), children: [shown === 'comparing' && !l.on ? '○' : '●'] })),
      fixed(Text({ bold: true, children: ['Architecture'] })),
      ...title,
      fixed(Text({ dimColor: true, children: [`·  ${describeLight(l, now)}`] })),
      ...buttons,
    ],
  })
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
async function registerArchitectureTool($: Api) {
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
async function startArchitecture($: Api) {
  await refresh($).catch(() => undefined)
}

/**
 * /clear and /resume reset the atoms but not this module: draw the line again.
 * A comparison under way is drawn as such, blinking, and goes on; one whose
 * turn had not started when the session was cleared is given up, since its
 * queued prompt may be gone with the conversation, and the line says so.
 */
async function redrawArchitecture($: Api, source: string) {
  const under = comparing
  if (!under) return refresh($).catch(() => undefined)
  if (source === 'clear' && !under.started) return giveUp($, 'the conversation was cleared before its turn started').catch(() => undefined)
  await update($, light, () => ({ ...under.previous, state: 'comparing' as const, source: under.source, on: true })).catch(() => undefined)
  startBlinking($)
}

/**
 * The turn that ran the comparison is over without a report: say so, and
 * show what the line showed before. A subagent's turn is not that turn, and
 * while a helper the turn started is still running (the Agent tool runs
 * subagents in the background by default) the comparison goes on: the
 * helper's answer starts another turn, which reports.
 */
async function architectureTurnComplete($: Api, e: { agentId?: string }) {
  if (e.agentId !== undefined || !comparing?.started) return
  if (await helperRunning($)) return
  await giveUp($, 'the turn ended without architecture_report').catch(() => undefined)
}

/** The session's agents, or none where the list cannot be read. */
async function agentIds($: Api) {
  try {
    return await $.agent.list()
  } catch {
    return []
  }
}

/** Whether a subagent the comparison's own turn started is still running: one outside the set the session had when that turn began. */
async function helperRunning($: Api) {
  const under = comparing
  if (!under) return false
  return (await agentIds($)).some(agent => agent.status === 'running' && agent.teammateId === undefined && !under.earlier.has(agent.id))
}

function stopArchitecture() {
  stopBlinking()
}

export const register: Register = on => {
  // The architecture line's own hooks: its report tool and the pull-request tools.
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
      commit: isCommit(text(input.commit).trim()) ? text(input.commit).trim() : null,
      behindSince: input.state === 'behind' ? (day(input.behindSince) ?? checkedAt) : null,
      reportedAt: new Date(await $.clock.now()).toISOString(),
    }
    await settleVerdict($, pointer, reported)
    const l = lightFrom(pointer, reported)
    return { result: `Reported. The line above the prompt now shows the architecture document as: ${describeLight(l, await $.clock.now())}.` }
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

  on('session.start', async ($, e, next) => {
    await registerArchitectureTool($)
    try {
      await $.tool.register({
        name: 'listen_arm',
        description:
          'Listen to an Unpaged canvas for @agent comments in this session: mints the listener key where the permission rules let the plugin (otherwise its answer asks you to call agent_listener_key_create, and the plugin takes the key from that), keeps it, and polls from inside Claude Code. New comments arrive as a message from the unpaged plugin. Pass the documentId (and the title for the band).',
        inputSchema: {
          type: 'object',
          properties: { documentId: { type: 'string' }, title: { type: 'string' } },
          required: ['documentId'],
        },
      })
      await $.tool.register({
        name: 'listen_stop',
        description:
          'Stop listening to an Unpaged canvas in this session and revoke its listener key: revoked by the plugin where the permission rules let it (otherwise its answer asks you to call agent_listener_key_revoke with the keyId, and the plugin forgets the key once you have).',
        inputSchema: { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'] },
      })
      await $.tool.register({
        name: 'listen_status',
        description: 'Which Unpaged canvases this session listens to, and which listener keys this machine stores.',
        inputSchema: { type: 'object' },
      })
    } catch (err) {
      $.ui.log(`tool registration failed: ${String(err)}`, { to: 'debug' })
    }
    try {
      await $.command.register({
        name: 'unpaged-listen',
        description: 'Listen to an Unpaged canvas for @agent comments (no model turn)',
        argumentHint: 'status | arm <documentId> | stop <documentId|all>',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`command registration failed: ${String(err)}`, { to: 'debug' })
    }
    const started = await next(e)
    void restoreAfterReload($).catch(() => undefined)
    // The line from the pointer file and this machine's record; the canvas is
    // read after the session is up, where the rules allow it.
    void startArchitecture($)
    return started
  })

  // /clear and /resume reset the atoms but not this module: rebuild the view.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await sync($)
    await redrawArchitecture($, String(e.source))
    return next(e)
  })

  on('command.run', { command: 'unpaged-listen' }, async ($, e) => {
    const [verb = 'status', target = ''] = e.args.trim().split(/\s+/)
    try {
      if (verb === 'status') return { text: await statusText($) }
      if (verb === 'arm') {
        try {
          const result = await arm($, target, null)
          return { text: result.already ? `Already listening: ${describe(result.canvas)}` : `Listening on ${describe(result.canvas, result.first)}` }
        } catch (err) {
          // A mint this command starts has no request of the person's behind it
          // in auto mode; one the agent makes in its turn does.
          const hint = isDocumentId(target) && (await mintRule($, target)) === 'ask' ? ' — ask Claude to listen to this canvas instead: it creates the key in its own turn, where auto mode sees that you asked' : ''
          return { text: `unpaged-listen arm: ${String((err as Error).message ?? err)}${hint}` }
        }
      }
      if (verb === 'stop') {
        const targets = target === 'all' ? [...canvases.keys()] : [target]
        const lines: string[] = []
        for (const id of targets) {
          const result = await stop($, id)
          lines.push(`${result.title}: stopped${result.revoked ? ', key revoked' : result.keyId ? `; ${stillLive(result)}` : ''}`)
        }
        return { text: lines.join('\n') || 'nothing to stop' }
      }
      return { text: 'usage: /unpaged-listen status | arm <documentId> | stop <documentId|all>' }
    } catch (err) {
      return { text: `unpaged-listen ${verb}: ${String((err as Error).message ?? err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__unpaged__listen_arm' }, async ($, e) => {
    const input = e as unknown as { documentId?: string; title?: string }
    const documentId = text(input.documentId)
    try {
      const rule = isDocumentId(documentId) && !loops.has(documentId) && !arming.has(documentId) ? await mintRule($, documentId) : 'allow'
      if (rule === 'deny') return { result: MINT_DENIED }
      if (rule === 'ask') {
        if (text(input.title)) titlesAsked.set(documentId, text(input.title))
        return { result: mintYourselfLine(documentId) }
      }
      const result = await arm($, documentId, text(input.title) || null)
      const line = result.already ? `Already listening: ${describe(result.canvas)}` : `Listening on ${describe(result.canvas, result.first)}`
      return {
        result: `${line}\nNew @agent comments arrive as a message from the unpaged plugin; reply on the canvas with the comment tools and leave threads open. Never repeat key material.`,
      }
    } catch (err) {
      return { result: `Push is not armed: ${String((err as Error).message ?? err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__unpaged__listen_stop' }, async ($, e) => {
    const input = e as unknown as { documentId?: string }
    try {
      const result = await stop($, text(input.documentId), { leaveToAgent: true })
      // The keys the plugin tried and could not revoke; the others it did not try.
      const failed = result.left.filter(id => !result.toAgent.includes(id) && !result.denied.includes(id))
      const key = result.revoked
        ? ', key revoked'
        : failed.length > 0
          ? `, key not revoked (the permission check or the server refused, or the server was unreachable): keyId ${failed.join(', ')}`
          : result.keyId
            ? ''
            : ', no key left to revoke here (none was minted for it since the plugin last loaded, or the server already rejected it)'
      const asks = `${result.toAgent.length > 0 ? revokeYourselfLine(result.toAgent) : ''}${result.denied.length > 0 ? revokeDeniedLine(result.denied) : ''}`
      return { result: `${result.title}: stopped${key}${asks ? `.${asks}` : ''}` }
    } catch (err) {
      return { result: `listen_stop failed: ${String((err as Error).message ?? err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__unpaged__listen_status' }, async $ => ({ result: await statusText($) }))

  // A canvas made or changed through the Unpaged tools is armed on its own once
  // the call succeeds, where the rules let the plugin mint its key. The call's
  // answer goes back as it came, without waiting for the arm: arming waits up
  // to FIRST_POLL_WAIT_MS for the first poll. Where the rules do not, the
  // answer carries one line for the agent, once per canvas: offer listening.
  on('tool.call', { tool: unpagedTool([...CREATES, ...EDITS]) }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const input = e as unknown as Record<string, unknown>
    let documentId = text(input.documentId)
    let title: string | null = null
    if (CREATES.some(name => e.tool.endsWith(`__${name}`))) {
      const answer = ran as { text?: unknown; result?: unknown }
      const created = createdDocument(answer.text) ?? createdDocument(answer.result)
      if (!created) return ran
      documentId = created.id
      title = created.title || text(input.title) || null
    }
    if (!isDocumentId(documentId) || armedBefore.has(documentId) || offered.has(documentId) || arming.has(documentId) || loops.has(documentId)) return ran
    const rule = await mintRule($, documentId)
    if (rule === 'allow') {
      armOnItsOwn($, documentId, title)
      return ran
    }
    // Asked once per canvas either way; a rule that denies the mint gets no offer.
    offered.add(documentId)
    return rule === 'deny' ? ran : { ...ran, context: [...(ran.context ?? []), offerLine(documentId, title)] }
  })

  // A deleted canvas is not listened to any longer: the server would go on
  // answering its polls until the session ends. The stop runs beside the
  // delete's answer, since its revoke can wait on a permission decision.
  on('tool.call', { tool: unpagedTool(['document_delete']) }, async ($, e, next) => {
    const ran = await next(e)
    const documentId = text((e as unknown as Record<string, unknown>).documentId)
    if (ran.deny === undefined && ran.isError !== true && (canvases.has(documentId) || arming.has(documentId))) {
      // Mid-mint, wait for the canvas to be recorded; once it is, stop it at once.
      const recorded = canvases.has(documentId) ? undefined : arming.get(documentId)?.catch(() => undefined)
      void Promise.resolve(recorded)
        .then(() => (canvases.has(documentId) ? stopAndSay($, documentId) : undefined))
        .catch(() => undefined)
    }
    return ran
  })

  // A key the agent or another plugin mints by hand. For a canvas this session
  // listens to it would take the canvas over and stop that listener (the
  // newest key wins): the mod answers. For any other canvas it goes to the
  // server under this machine's label, and the mod listens with it and
  // answers in its place, so the key never reaches the conversation. The
  // mod's own mint is a tool call these hooks see too, raised under this
  // plugin's name; it goes on to the server.
  on('tool.call', { tool: unpagedTool(['agent_listener_key_create']) }, async ($, e, next) => {
    if (next.origin.plugin === $.plugin.name) return next(e)
    const input = e as unknown as Record<string, unknown>
    const documentId = text(input.documentId)
    if (loops.has(documentId) || arming.has(documentId)) {
      const title = canvases.get(documentId)?.title || documentId
      return {
        deny: `Not minted: this session already listens to ${title} through the unpaged plugin, and a newer key would stop that listener. New @agent comments on it arrive as a message from the unpaged plugin; nothing to do.`,
      }
    }
    if (!isDocumentId(documentId)) return next(e)
    // The label is always this machine's, whatever the agent chose: `/unpaged:listen revoke all` knows this machine's keys by it.
    const ran = await next({ ...e, label: await keyLabel($) } as typeof e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const answer = ran as { text?: unknown; result?: unknown }
    const found = extractMint(answer.text) ?? extractMint(answer.result)
    return found ? listenWithAgentMint($, documentId, found) : ran
  })

  // A key the agent revokes itself: once the server has revoked it, the mod
  // forgets it as its own stop would. The call and its answer go on unchanged.
  // The mod's own revokes are tool calls these hooks see too, raised under
  // this plugin's name; the stop or arm that made them forgets the key itself.
  on('tool.call', { tool: unpagedTool(['agent_listener_key_revoke']) }, async ($, e, next) => {
    if (next.origin.plugin === $.plugin.name) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    // A store that fails here leaves a stale entry the next arm revokes again; the revoke itself succeeded.
    await forgetRevoked($, text((e as unknown as Record<string, unknown>).keyId)).catch(() => undefined)
    return ran
  })

  // The reply turn is over: the comments it answered are no longer new, on the
  // canvases it covered. A comparison turn over without a report is put back.
  on('turn.complete', async ($, e, next) => {
    const covered = await read($, replying)
    if (covered.length > 0) {
      for (const documentId of covered) record(documentId, { unread: 0 })
      await update($, replying, () => [])
      await sync($)
    }
    await architectureTurnComplete($, e)
    return next(e)
  })

  // The band above the prompt: one line while this session listens, and one
  // for the repository's architecture document while there is something to say.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, armed)
    const ui = $.ui.resolve(e)
    const architecture = await architectureRow($, ui)
    if (list.length === 0 && !architecture) return next(e)
    const theirs = await next(e)
    const covered = await read($, replying)
    const { Box, Text, Button, Link } = ui
    const unread = list.reduce((n, c) => n + c.unread, 0)
    const button = (key: string, label: string, hotkey: string, onPress: () => void) =>
      Button({ key, label, hotkey, plain: true, onPress })
    const fixed = (child: ReturnType<typeof Text>) => Box({ flexShrink: 0, children: [child] })
    // The title is the canvas's link, which Claude Code itself opens: the
    // plugin starts no program for it. A terminal that draws no links writes
    // the address after the title, so only the title gives way to the width
    // (the rest never wraps), and `1: link` shows the address whole.
    const ours =
      list.length === 0
        ? null
        : list.length === 1
        ? Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              fixed(Text({ color: dotColor(list[0]), children: ['●'] })),
              fixed(Text({ bold: true, children: ['Listening'] })),
              Text({ wrap: 'truncate-end', children: [Link({ href: list[0].boardUrl, children: [list[0].title] })] }),
              fixed(Text({ dimColor: true, children: [`·  ${statusLabel(list[0], e.props.isWorking, covered.includes(list[0].documentId))}`] })),
              button('link', 'link', '1', () => showLink($, list[0])),
              button('stop', 'stop', '2', () => void stopAndSay($, list[0].documentId)),
            ],
          })
        : Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Text({ color: unread > 0 ? 'yellow' : list.some(c => c.state === 'connected') ? 'green' : 'gray', children: ['●'] }),
              Text({ bold: true, children: ['Listening'] }),
              Text({ children: [`on ${list.length} canvases`] }),
              Text({ dimColor: true, children: [`·  ${unread > 0 ? `${unread} new` : 'no new comments'}${e.props.isWorking && covered.length > 0 ? '  ·  replying on the canvas' : ''}`] }),
              button('canvases', 'canvases', '1', () => void $.ui.open({ id: PANE, title: 'Listening', focus: true, closeOnEscape: true })),
              button('stop-all', 'stop all', '2', () => void stopAll($)),
            ],
          })
    const children = [typeof theirs === 'object' && theirs !== null ? theirs : null, ours, architecture].filter(row => row !== null)
    return Box({ flexDirection: 'column', children })
  })

  // The pane past one canvas: each title its canvas's link, each with its own link and stop.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, armed)
    const covered = await read($, replying)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    if (list.length === 0) return Box({ children: [Text({ dimColor: true, children: ['Nothing is armed in this session.'] })] })
    const fixed = (child: ReturnType<typeof Text>) => Box({ flexShrink: 0, children: [child] })
    return Box({
      flexDirection: 'column',
      children: list.map(canvas =>
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            fixed(Text({ color: dotColor(canvas), children: ['●'] })),
            Text({ wrap: 'truncate-end', children: [Link({ href: canvas.boardUrl, children: [canvas.title] })] }),
            fixed(Text({ dimColor: true, children: [statusLabel(canvas, false, covered.includes(canvas.documentId))] })),
            Button({ key: `link-${canvas.documentId}`, label: 'link', onPress: () => showLink($, canvas) }),
            Button({
              key: `stop-${canvas.documentId}`,
              label: 'stop',
              onPress: () => {
                void stopAndSay($, canvas.documentId).then(() => (canvases.size === 0 ? $.ui.close({ id: PANE }) : undefined))
              },
            }),
          ],
        }),
      ),
    })
  })

  on('session.end', async ($, e, next) => {
    if (ENDING_REASONS.has(e.reason)) {
      for (const loop of loops.values()) loop.controller.abort()
      // /clear and /resume end no comparison: its turn goes on, and the redraw keeps it blinking.
      stopArchitecture()
    }
    return next(e)
  })
}
