// The world beneath the mod in its tests: files, processes, the network,
// the MCP server and the clock, answered by the test's own hooks so arming,
// polling, delivery, stopping and drawing run as in a session without a
// key, a canvas or a model.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const DOCUMENT = '11111111-1111-4111-8111-111111111111'
export const SECOND = '22222222-2222-4222-8222-222222222222'
export const THIRD = '33333333-3333-4333-8333-333333333333'
export const KEY = 'k'.repeat(43)
export const POLL_URL = 'https://mcp.unpaged.io/events/poll'
/** Where the plugin keeps a canvas's key in its store. */
export const storedKeyFor = (documentId: string) => `listener:${documentId}`
export const keyIdFor = (documentId: string) => (documentId === DOCUMENT ? 'key-1' : `key-${documentId.slice(0, 8)}`)
export const titleFor = (documentId: string) => (documentId === DOCUMENT ? 'Plan canvas' : `Canvas ${documentId.slice(0, 4)}`)

export const THREAD = '44444444-4444-4444-8444-444444444444'

export const frame = (id: string, textPreview = 'hello @agent', documentId = DOCUMENT, reason = 'mention') => ({
  type: 'agent-inbox-event', id, documentId, nodeId: 'node', threadId: THREAD, commentId: 'comment',
  reason, authorRole: 'owner', resolved: false, createdAt: '2026-09-21T00:00:00.000Z',
  documentTitle: titleFor(documentId), nodeTitle: 'root', authorName: 'Ilie', textPreview,
  boardUrl: `https://unpaged.io/document/${documentId}/edit`, anchorElementId: null,
})
export type Page = { status: number; body?: unknown; headers?: Record<string, string> }
export const page = (events: unknown[] = [], nextCursor: string | null = null): Page => ({ status: 200, body: { events, nextCursor } })

export type World = ReturnType<typeof world>

export function world(
  on: On,
  settings: {
    pages?: Page[]
    mintError?: boolean
    hangPolls?: boolean
    holdMint?: boolean
    hangRevoke?: boolean
    /** The revoke is refused, as a permission check or the server refuses it. */
    revokeRefused?: boolean
    /** How the server answers the "On it…" reply: posted (the default), refused, or never. */
    ack?: 'posted' | 'refused' | 'hang'
    /** The person's permission rules on comment_reply, as `$.tool.check` reads them: allowed (the default) or not. */
    replyRule?: 'allow' | 'ask' | 'deny'
    /** The rules on agent_listener_key_create: allowed (the default) lets the plugin mint on its own. */
    keyRule?: 'allow' | 'ask' | 'deny'
    /** The rules on agent_listener_key_revoke: allowed (the default) lets the plugin revoke on its own; otherwise a stop the agent makes, or a replaced key where it minted, is left to the agent. */
    revokeRule?: 'allow' | 'ask' | 'deny'
    /** No `hostname` program, as on some Linux images: `uname -n` answers instead. */
    noHostname?: boolean
  } = {},
) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  const files = new Map<string, string>()
  // The plugin's own store, as the engine keeps it between sessions.
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.has(e.key) ? JSON.parse(JSON.stringify(store.get(e.key))) : undefined }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const calls = {
    armed: [] as Array<Record<string, unknown>>,
    replying: [] as string[],
    armedOnce: [] as string[],
    process: [] as { argv: string[]; stdin?: string }[],
    mcp: [] as { tool: string; args: Record<string, unknown> }[],
    fetch: [] as { url: string; authorization?: string }[],
    submits: [] as string[],
    /** How many prompts had been submitted when each comment_reply reached the server. */
    submitsAtReply: [] as number[],
    toasts: [] as string[],
    /** The tools the plugin asked the permission rules about, by the name the rules use. */
    checks: [] as string[],
  }
  // The band's view of the armed set, as the plugin writes it.
  on('state.set', (_$, e, next) => {
    const write = e as unknown as { plugin?: string; key?: string; value?: unknown }
    if (write.plugin === 'unpaged' && write.key === 'armed') calls.armed = (write.value as Array<Record<string, unknown>>) ?? []
    if (write.plugin === 'unpaged' && write.key === 'replying') calls.replying = (write.value as string[]) ?? []
    if (write.plugin === 'unpaged' && write.key === 'armedOnce') calls.armedOnce = (write.value as string[]) ?? []
    return next(e)
  })
  on('turn.complete', () => ({ text: '', reason: 'answer' }) as never)
  // The engine's own drawing beneath the plugin: an empty box where the band would be.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return Box({ children: [] })
  })
  // The engine's end of a classic event the test raises.
  on('classic.SessionStart', () => ({}) as never)
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    calls.process.push({ argv, stdin: e.init?.stdin })
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'hostname') return settings.noHostname ? ok('', 127) : ok('testbox.local\n')
    if (argv[0] === 'uname' && argv[1] === '-n') return ok('linuxbox\n')
    return ok('', 127)
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'unpaged' } }))
  // The person's permission rules, as a query reads them: nothing runs.
  on('tool.check', (_$, e) => {
    calls.checks.push(e.tool)
    if (e.tool === 'mcp__unpaged__comment_reply') return { decision: settings.replyRule ?? 'allow' }
    if (e.tool === 'mcp__unpaged__agent_listener_key_create') return { decision: settings.keyRule ?? 'allow' }
    if (e.tool === 'mcp__unpaged__agent_listener_key_revoke') return { decision: settings.revokeRule ?? 'allow' }
    return { decision: 'ask' }
  })
  // A held mint answers when the test calls releaseMint(); a hung revoke never answers.
  let releaseMint: () => void = () => {}
  const minted = settings.holdMint ? new Promise<void>(resolve => (releaseMint = resolve)) : Promise.resolve()
  on('mcp.call', async (_$, e) => {
    calls.mcp.push({ tool: e.tool, args: e.args })
    if (e.tool === 'agent_listener_key_revoke' && settings.hangRevoke) return new Promise(() => {}) as never
    if (e.tool === 'agent_listener_key_create') {
      await minted
      if (settings.mintError) return { value: { content: [{ type: 'text', text: 'listener key cap reached' }], isError: true } }
      const documentId = String(e.args.documentId)
      const mint = { pollUrl: POLL_URL, key: KEY, documentId, keyId: keyIdFor(documentId), title: titleFor(documentId) }
      return { value: { content: [{ type: 'text', text: JSON.stringify(mint) }], isError: false } }
    }
    if (e.tool === 'agent_listener_key_revoke' && settings.revokeRefused) return { value: { content: [{ type: 'text', text: 'Error: refused' }], isError: true } }
    if (e.tool === 'agent_listener_key_revoke') return { value: { content: [{ type: 'text', text: '{"revoked":true}' }], isError: false } }
    if (e.tool === 'comment_reply') {
      calls.submitsAtReply.push(calls.submits.length)
      if (settings.ack === 'hang') return new Promise(() => {}) as never
      if (settings.ack === 'refused') return { value: { content: [{ type: 'text', text: 'Error: refused' }], isError: true } }
      return { value: { content: [{ type: 'text', text: '{"commentId":"reply-1"}' }], isError: false } }
    }
    return { value: { content: [], isError: true } }
  })
  let served = 0
  on('http.fetch', (_$, e) => {
    if (settings.hangPolls) {
      calls.fetch.push({ url: e.url, authorization: e.init?.headers?.Authorization })
      return new Promise(() => {}) as never
    }
    const pages = settings.pages ?? []
    const next = pages[Math.min(served, Math.max(pages.length - 1, 0))] ?? page()
    served += 1
    calls.fetch.push({ url: e.url, authorization: e.init?.headers?.Authorization })
    return { value: { status: next.status, ok: next.status === 200, headers: next.headers ?? {}, text: JSON.stringify(next.body ?? {}) } }
  })
  // A submitted prompt starts a turn only when the session is idle: the test
  // decides when, with startTurn(), as the engine would.
  const pendingSubmits: Array<() => void> = []
  on('prompt.submit', (_$, e) => {
    calls.submits.push(e.text)
    return new Promise<{ text: string }>(resolve => {
      pendingSubmits.push(() => resolve({ text: e.text }))
    }) as never
  })
  const startTurn = async () => {
    pendingSubmits.shift()?.()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  on('ui.toast', (_$, e) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, calls, files, store, startTurn, releaseMint: () => releaseMint() }
}

/**
 * The Unpaged MCP server beneath the plugin, answering the model's tool calls
 * as core does: the tool's record (its content blocks) and, as `text`, the
 * JSON the model reads. Returns the tools it was called with, in order.
 */
export function unpagedServer(on: On, settings: { refuse?: string[]; cloneText?: string; mintFor?: string; inputs?: Array<Record<string, unknown>> } = {}) {
  const called: string[] = []
  on('tool.call', { tool: /^mcp__(plugin_unpaged_unpaged|unpaged)__(?!listen_)/ }, (_$, e) => {
    const tool = String(e.tool)
    const name = tool.slice(tool.lastIndexOf('__') + 2)
    const args = e as unknown as Record<string, unknown>
    called.push(name)
    settings.inputs?.push(args)
    const answer = (value: unknown, text = JSON.stringify(value, null, 2)) =>
      ({ result: [{ type: 'text', text: JSON.stringify(value) }], text }) as never
    if (settings.refuse?.includes(name)) return { isError: true, result: 'Error: refused', text: 'Error: refused' } as never
    if (name === 'document_create') return answer({ id: SECOND, title: args.title, rootNodeId: 'root-2', url: `https://unpaged.io/document/${SECOND}/edit` })
    if (name === 'template_clone') return answer({ id: THIRD, title: args.title ?? 'From the gallery', nodes: [{ id: 'root-3', elements: [] }] }, settings.cloneText)
    if (name === 'agent_listener_key_create') return answer({ pollUrl: POLL_URL, key: KEY, documentId: settings.mintFor ?? args.documentId, keyId: 'key-by-hand', title: 'By hand' })
    return answer({ ok: true })
  })
  return called
}

/** Lets work a hook left running unawaited (an arm a tool call started) go on until `done` holds. */
export async function until(done: () => boolean, turns = 200) {
  for (let turn = 0; turn < turns && !done(); turn++) await new Promise(resolve => setTimeout(resolve, 0))
}

/** The props a surface hands the band. */
export const bandProps = (changes: Partial<{ hasSurvey: boolean; isWorking: boolean }> = {}) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
  ...changes,
})

/** The props a surface hands a pane. */
export const paneProps = (title = 'Listening') => ({
  title,
  isFocused: true,
  bodyColumns: 100,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
})
