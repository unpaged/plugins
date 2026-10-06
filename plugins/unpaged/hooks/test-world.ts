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
export const keyFileFor = (documentId: string) => `/home/t/.claude/unpaged/listeners/${documentId}.json`
export const statusFileFor = (documentId: string) => `/home/t/.claude/unpaged/monitors/${documentId}.json`
export const keyIdFor = (documentId: string) => (documentId === DOCUMENT ? 'key-1' : `key-${documentId.slice(0, 8)}`)
export const titleFor = (documentId: string) => (documentId === DOCUMENT ? 'Plan canvas' : `Canvas ${documentId.slice(0, 4)}`)

export const frame = (id: string, textPreview = 'hello @agent', documentId = DOCUMENT) => ({
  type: 'agent-inbox-event', id, documentId, nodeId: 'node', threadId: 'thread', commentId: 'comment',
  reason: 'mention', authorRole: 'owner', resolved: false, createdAt: '2026-09-21T00:00:00.000Z',
  documentTitle: titleFor(documentId), nodeTitle: 'root', authorName: 'Ilie', textPreview,
  boardUrl: `https://unpaged.io/document/${documentId}/edit`, anchorElementId: null,
})
export type Page = { status: number; body?: unknown }
export const page = (events: unknown[] = [], nextCursor: string | null = null): Page => ({ status: 200, body: { events, nextCursor } })

export type World = ReturnType<typeof world>

export function world(on: On, settings: { pages?: Page[]; mintError?: boolean; openExit?: number; hangPolls?: boolean } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/t' })
  const files = new Map<string, string>()
  const calls = {
    armed: [] as Array<Record<string, unknown>>,
    replying: [] as string[],
    process: [] as { argv: string[]; stdin?: string }[],
    mcp: [] as { tool: string; args: Record<string, unknown> }[],
    fetch: [] as { url: string; authorization?: string }[],
    submits: [] as string[],
    toasts: [] as string[],
    opened: [] as string[],
  }
  // The band's view of the armed set, as the plugin writes it.
  on('state.set', (_$, e, next) => {
    const write = e as unknown as { plugin?: string; key?: string; value?: unknown }
    if (write.plugin === 'unpaged' && write.key === 'armed') calls.armed = (write.value as Array<Record<string, unknown>>) ?? []
    if (write.plugin === 'unpaged' && write.key === 'replying') calls.replying = (write.value as string[]) ?? []
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
    if (argv[0] === 'open' || argv[0] === 'xdg-open') {
      const exit = settings.openExit ?? 0
      if (exit === 0) calls.opened.push(argv[1] ?? '')
      return ok('', exit)
    }
    const verb = argv[2]
    const id = argv[3] ?? ''
    if (verb === 'check') return ok(`${files.has(keyFileFor(id)) ? `armed ${keyIdFor(id)}` : 'missing'}\nhost testbox\n`)
    if (verb === 'store') {
      files.set(keyFileFor(id), e.init?.stdin ?? '')
      return ok(`stored ${keyIdFor(id)}\n`)
    }
    if (verb === 'retire') {
      // The script's rule: the file goes only if it still holds the key being retired.
      const stored = files.get(keyFileFor(id))
      if (!stored) return ok('absent\n')
      const current = JSON.parse(stored) as { key?: string; keyId?: string }
      const given = e.init?.stdin ? (JSON.parse(e.init.stdin) as { key?: string }) : null
      const keyId = argv[4]
      if (!given && !keyId) return ok('unmatched\n')
      const same = given ? given.key === current.key : current.keyId === keyId
      if (!same) return ok('kept-newer\n')
      files.delete(keyFileFor(id))
      return ok('removed\n')
    }
    if (verb === 'status') {
      files.set(statusFileFor(id), JSON.stringify({ ...(JSON.parse(e.init?.stdin ?? '{}') as object), pid: 0, transport: 'mod-v1' }))
      return ok('written\n')
    }
    if (verb === 'forget') {
      files.delete(keyFileFor(id))
      return ok('forgotten 1\n')
    }
    if (verb === 'list') {
      const rows = [...files.keys()]
        .filter(p => p.includes('/listeners/'))
        .map(p => p.slice(p.lastIndexOf('/') + 1, -5))
        .map(doc => `${doc}\tthis-folder\t2026-10-02\t${titleFor(doc)}\t${keyIdFor(doc)}`)
      return ok(rows.length ? `${rows.join('\n')}\n` : 'none\n')
    }
    return ok('')
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'unpaged' } }))
  on('mcp.call', (_$, e) => {
    calls.mcp.push({ tool: e.tool, args: e.args })
    if (e.tool === 'agent_listener_key_create') {
      if (settings.mintError) return { value: { content: [{ type: 'text', text: 'listener key cap reached' }], isError: true } }
      const documentId = String(e.args.documentId)
      const mint = { pollUrl: POLL_URL, key: KEY, documentId, keyId: keyIdFor(documentId), title: titleFor(documentId) }
      return { value: { content: [{ type: 'text', text: JSON.stringify(mint) }], isError: false } }
    }
    if (e.tool === 'agent_listener_key_revoke') return { value: { content: [{ type: 'text', text: '{"revoked":true}' }], isError: false } }
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
    return { value: { status: next.status, ok: next.status === 200, headers: {}, text: JSON.stringify(next.body ?? {}) } }
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
  return { clock, calls, files, startTurn }
}

/**
 * The Unpaged MCP server beneath the plugin, answering the model's tool calls
 * as core does: the tool's record (its content blocks) and, as `text`, the
 * JSON the model reads. Returns the tools it was called with, in order.
 */
export function unpagedServer(on: On, settings: { refuse?: string[]; cloneText?: string } = {}) {
  const called: string[] = []
  on('tool.call', { tool: /^mcp__(plugin_unpaged_unpaged|unpaged)__(?!listen_)/ }, (_$, e) => {
    const tool = String(e.tool)
    const name = tool.slice(tool.lastIndexOf('__') + 2)
    const args = e as unknown as Record<string, unknown>
    called.push(name)
    const answer = (value: unknown, text = JSON.stringify(value, null, 2)) =>
      ({ result: [{ type: 'text', text: JSON.stringify(value) }], text }) as never
    if (settings.refuse?.includes(name)) return { isError: true, result: 'Error: refused', text: 'Error: refused' } as never
    if (name === 'document_create') return answer({ id: SECOND, title: args.title, rootNodeId: 'root-2', url: `https://unpaged.io/document/${SECOND}/edit` })
    if (name === 'template_clone') return answer({ id: THIRD, title: args.title ?? 'From the gallery', nodes: [{ id: 'root-3', elements: [] }] }, settings.cloneText)
    if (name === 'agent_listener_key_create') return answer({ pollUrl: POLL_URL, key: KEY, documentId: args.documentId, keyId: 'key-by-hand', title: 'By hand' })
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
