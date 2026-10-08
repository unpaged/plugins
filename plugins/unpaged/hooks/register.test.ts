// Tests of the listener mod's arming, delivery and stopping, run against the
// engine with the world beneath the mod answered by the test's own hooks.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import { DOCUMENT, KEY, POLL_URL, SECOND, THIRD, THREAD, frame, keyFileFor, page, statusFileFor, unpagedServer, until, world } from './test-world'
import type { World } from './test-world'

const KEY_FILE = keyFileFor(DOCUMENT)
const STATUS_FILE = statusFileFor(DOCUMENT)

describe('listen_arm', () => {
  test('mints a key, stores it through the key helper, polls with it in a header, and answers after the first poll', async ($, on) => {
    const w = world(on)
    const answer = await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    const text = JSON.stringify(answer)
    expect(text).toContain('Listening on Plan canvas')
    expect(text).toContain('connected')
    expect(text).not.toContain(KEY)
    expect(w.calls.mcp.map(c => c.tool)).toEqual(['agent_listener_key_create'])
    const store = w.calls.process.find(c => c.argv[2] === 'store')
    expect(store?.stdin).toContain(KEY)
    expect(w.calls.process.every(c => !c.argv.join(' ').includes(KEY))).toBe(true)
    expect(w.calls.fetch).toEqual([{ url: POLL_URL, authorization: `Bearer ${KEY}` }])
    expect(w.calls.process.some(c => c.argv[2] === 'status' && c.argv[3] === DOCUMENT && (c.stdin ?? '').includes('"state":"connected"'))).toBe(true)
    expect(JSON.parse(w.files.get(STATUS_FILE) ?? '{}')).toEqual(expect.objectContaining({ transport: 'mod-v1', state: 'connected', documentId: DOCUMENT, sessionId: 'session-1' }))
    expect(w.calls.armed).toEqual([expect.objectContaining({ documentId: DOCUMENT, keyId: 'key-1', title: 'Plan canvas', state: 'connected', unread: 0 })])
    expect(w.calls.submits).toEqual([])
  })

  test('a refused mint arms nothing', async ($, on) => {
    const w = world(on, { mintError: true })
    const answer = await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    expect(JSON.stringify(answer)).toContain('Push is not armed')
    expect(w.calls.fetch).toEqual([])
    expect(w.files.has(KEY_FILE)).toBe(false)
    expect(w.calls.armed).toEqual([])
  })

  test('two arms of one canvas at once mint one key', async ($, on) => {
    const w = world(on)
    const [first, second] = await Promise.all([
      $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never),
      $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never),
    ])
    expect(w.calls.mcp.filter(c => c.tool === 'agent_listener_key_create')).toHaveLength(1)
    expect(w.calls.fetch).toHaveLength(1)
    expect([first, second].map(a => JSON.stringify(a)).filter(t => t.includes('Already listening'))).toHaveLength(1)
  })

  test('a second arm of the same canvas does not mint again', async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    const again = await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    expect(JSON.stringify(again)).toContain('Already listening')
    expect(w.calls.mcp.filter(c => c.tool === 'agent_listener_key_create')).toHaveLength(1)
  })

  test('re-arming replaces a key file from an earlier session and revokes that key', async ($, on) => {
    const w = world(on)
    w.files.set(KEY_FILE, JSON.stringify({ pollUrl: POLL_URL, key: KEY, documentId: DOCUMENT, keyId: 'key-old', title: 'Plan canvas' }))
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    const tools = w.calls.mcp.map(c => `${c.tool}:${c.args.keyId ?? ''}`)
    expect(tools).toEqual(['agent_listener_key_create:', 'agent_listener_key_revoke:key-old'])
    expect(w.calls.armed[0]).toEqual(expect.objectContaining({ keyId: 'key-1' }))
  })
})

describe('delivery', () => {
  test('each poll with new events is one toast per event and one submitted prompt, the preamble first', async ($, on) => {
    const w = world(on, { pages: [page(), page([frame('e1'), frame('e2', 'second')], 'c2'), page([frame('e2')])] })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    expect(w.calls.fetch).toHaveLength(1)
    await w.clock.advance(30_000)
    expect(w.calls.fetch).toHaveLength(2)
    expect(w.calls.toasts).toEqual(['Ilie @agent on Plan canvas: hello @agent', 'Ilie @agent on Plan canvas: second'])
    await w.clock.advance(50)
    expect(w.calls.submits).toHaveLength(1)
    const lines = w.calls.submits[0].split('\n')
    expect(lines[0]).toContain('Unpaged @agent event')
    expect(lines.slice(1, 3).map(l => JSON.parse(l).id)).toEqual(['e1', 'e2'])
    // Both comments are in one thread: one "On it…" answers them, and one line says so.
    expect(w.calls.mcp.filter(c => c.tool === 'comment_reply')).toHaveLength(1)
    expect(lines.slice(3)).toEqual([expect.stringContaining('already replied "On it…"')])
    expect(w.calls.submits[0]).not.toContain(KEY)
    expect(w.calls.armed[0]).toEqual(expect.objectContaining({ unread: 2 }))
    // The replay of e2 on the next page is not delivered again.
    await w.clock.advance(30_000)
    expect(w.calls.fetch).toHaveLength(3)
    await w.clock.advance(50)
    expect(w.calls.submits).toHaveLength(1)
  })

  test('HTTP 401 retires the key by its id, stops the loop and tells the model push is off', async ($, on) => {
    const w = world(on, { pages: [page(), { status: 401 }] })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    await w.clock.advance(30_000)
    await w.clock.advance(50)
    const retire = w.calls.process.find(c => c.argv[2] === 'retire' && c.argv[3] === DOCUMENT)
    expect(retire?.stdin).toContain(KEY)
    expect(retire?.argv).toHaveLength(4)
    expect(w.files.has(KEY_FILE)).toBe(false)
    expect(w.calls.submits).toHaveLength(1)
    expect(w.calls.submits[0]).toContain('revoked')
    expect(w.calls.armed[0]).toEqual(expect.objectContaining({ state: 'stopped', reason: 'http-401' }))
    await w.clock.advance(60_000)
    expect(w.calls.fetch).toHaveLength(2)
  })

  test('a poll that never answers is given up at the deadline and retried', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    mock.env(on, { HOME: '/home/t' })
    const files = new Map<string, string>()
    on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
    on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
    on('fs.write', (_$, e) => {
      files.set(e.path, e.text)
      return { value: undefined }
    })
    on('session.cwd', () => ({ value: '/repo' }))
    on('session.id', () => ({ value: 'session-1' }))
    on('process.run', (_$, e) => {
      const verb = e.argv[2]
      if (verb === 'store') files.set(KEY_FILE, e.init?.stdin ?? '')
      const stdout = verb === 'check' ? 'missing\nhost testbox\n' : verb === 'store' ? 'stored key-1\n' : ''
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('mcp.connect', () => ({ value: { isConnected: true, server: 'unpaged' } }))
    on('mcp.call', () => ({
      value: { content: [{ type: 'text', text: JSON.stringify({ pollUrl: POLL_URL, key: KEY, documentId: DOCUMENT, keyId: 'key-1', title: 'Plan canvas' }) }], isError: false },
    }))
    on('ui.toast', () => ({ value: undefined }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    let fetches = 0
    on('http.fetch', () => {
      fetches += 1
      return new Promise(() => {}) as never
    })
    const started = $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    await clock.advance(8_000)
    expect(JSON.stringify(await started)).toContain('first poll pending')
    expect(fetches).toBe(1)
    await clock.advance(7_000)
    await clock.advance(30_000)
    expect(fetches).toBe(2)
  })
})

describe('"On it…"', () => {
  const replies = (w: World) => w.calls.mcp.filter(c => c.tool === 'comment_reply')
  const deliver = async (w: World, submits = 1) => {
    await w.clock.advance(30_000)
    await w.clock.advance(50)
    await until(() => w.calls.submits.length >= submits)
  }

  test('an @agent comment gets "On it…" on its thread before the turn starts, and the turn is told so', async ($, on) => {
    const w = world(on, { pages: [page(), page([frame('e1')])] })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    await deliver(w)
    expect(replies(w)).toEqual([{ tool: 'comment_reply', args: { documentId: DOCUMENT, threadId: THREAD, text: 'On it…' } }])
    expect(w.calls.submitsAtReply).toEqual([0])
    const lines = w.calls.submits[0].split('\n')
    expect(JSON.parse(lines[1]).id).toBe('e1')
    expect(lines.at(-1)).toBe(`The unpaged plugin already replied "On it…" on thread ${THREAD}; do not post another, and it is not your answer.`)
  })

  test('a reply in a thread the agent took part in gets no "On it…"', async ($, on) => {
    const w = world(on, { pages: [page(), page([frame('r1', 'thanks', DOCUMENT, 'reply')])] })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    await deliver(w)
    expect(replies(w)).toEqual([])
    expect(w.calls.submits[0].split('\n')).toHaveLength(2)
  })

  test('an event replayed to a new listener is not answered twice', async ($, on) => {
    const w = world(on, { pages: [page(), page([frame('e1')]), page(), page([frame('e1')])] })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    await deliver(w)
    await $.tool.call({ tool: 'mcp__unpaged__listen_stop', documentId: DOCUMENT } as never)
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    await deliver(w, 2)
    expect(replies(w)).toHaveLength(1)
    expect(w.calls.submits[1]).toContain(`already replied "On it…" on thread ${THREAD}`)
  })

  test('a refused reply tells the agent to post it', async ($, on) => {
    const w = world(on, { pages: [page(), page([frame('e1')])], ack: 'refused' })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    await deliver(w)
    expect(replies(w)).toHaveLength(1)
    expect(w.calls.submits[0].split('\n').at(-1)).toBe(`The unpaged plugin could not reply "On it…" on thread ${THREAD}; post it there yourself first.`)
  })

  test('a reply that does not answer holds the turn five seconds, then the turn starts without posting another', async ($, on) => {
    const w = world(on, { pages: [page(), page([frame('e1')])], ack: 'hang' })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    await w.clock.advance(30_000)
    await w.clock.advance(50)
    await until(() => false, 20)
    expect(w.calls.submits).toEqual([])
    await w.clock.advance(5_000)
    await until(() => w.calls.submits.length > 0)
    expect(w.calls.submits[0].split('\n').at(-1)).toBe(`The unpaged plugin is replying "On it…" on thread ${THREAD}; do not post another, and it is not your answer.`)
  })
})

describe('stop', () => {
  test('stops the loop, revokes the key by its id and forgets the file', async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    const answer = await $.tool.call({ tool: 'mcp__unpaged__listen_stop', documentId: DOCUMENT } as never)
    expect(JSON.stringify(answer)).toContain('key revoked')
    expect(w.calls.mcp.at(-1)).toEqual({ tool: 'agent_listener_key_revoke', args: { keyId: 'key-1' } })
    const retire = w.calls.process.find(c => c.argv[2] === 'retire')
    expect(retire?.argv.slice(3)).toEqual([DOCUMENT])
    expect(retire?.stdin).toContain(KEY)
    expect(w.files.has(KEY_FILE)).toBe(false)
    expect(w.calls.armed).toEqual([])
    await w.clock.advance(60_000)
    expect(w.calls.fetch).toHaveLength(1)
  })

  test('stop leaves a key file that another session replaced meanwhile', async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    // Another session re-armed the canvas: the file now holds a newer key.
    const newer = JSON.stringify({ pollUrl: POLL_URL, key: 'n'.repeat(43), documentId: DOCUMENT, keyId: 'key-newer', title: 'Plan canvas' })
    w.files.set(KEY_FILE, newer)
    const answer = await $.tool.call({ tool: 'mcp__unpaged__listen_stop', documentId: DOCUMENT } as never)
    expect(JSON.stringify(answer)).toContain('key revoked')
    expect(w.calls.mcp.at(-1)).toEqual({ tool: 'agent_listener_key_revoke', args: { keyId: 'key-1' } })
    expect(w.calls.process.some(c => c.argv[2] === 'forget')).toBe(false)
    expect(w.files.get(KEY_FILE)).toBe(newer)
  })

  test('status names what this session listens to and the stored keys', async ($, on) => {
    world(on)
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    const answer = JSON.stringify(await $.tool.call({ tool: 'mcp__unpaged__listen_status' } as never))
    expect(answer).toContain('Plan canvas')
    expect(answer).toContain('connected')
    expect(answer).toContain('key-1')
    expect(answer).not.toContain(KEY)
  })
})

describe('arming on its own', () => {
  const UNPAGED = 'mcp__plugin_unpaged_unpaged__'
  const mints = (w: ReturnType<typeof world>) => w.calls.mcp.filter(c => c.tool === 'agent_listener_key_create')
  const edit = ($: Engine, documentId = DOCUMENT) =>
    $.tool.call({ tool: `${UNPAGED}batch_create_elements`, documentId, nodeId: 'root', elements: [] } as never)
  /** Gives work a hook left running a moment to show itself, for a check that nothing happened. */
  const quiet = () => until(() => false, 20)

  test('a canvas made with document_create is armed once the call answers, without waiting for its first poll', async ($, on) => {
    const w = world(on, { hangPolls: true })
    unpagedServer(on)
    const answer = await $.tool.call({ tool: `${UNPAGED}document_create`, title: 'Owl detective' } as never)
    expect(JSON.stringify(answer)).toContain(SECOND)
    await until(() => w.calls.fetch.length > 0)
    expect(mints(w).map(c => c.args.documentId)).toEqual([SECOND])
    expect(w.calls.fetch).toEqual([{ url: POLL_URL, authorization: `Bearer ${KEY}` }])
    expect(w.calls.armed).toEqual([expect.objectContaining({ documentId: SECOND, title: 'Owl detective', state: 'connecting' })])
    expect(w.calls.process.every(c => !c.argv.join(' ').includes(KEY))).toBe(true)
  })

  test('a canvas made with template_clone is armed, read from the tool record when the model reads a file pointer', async ($, on) => {
    const w = world(on)
    unpagedServer(on, { cloneText: 'Output too large (120KB). Full output saved to: /tmp/clone.txt' })
    await $.tool.call({ tool: `${UNPAGED}template_clone`, templateId: 'tpl-1' } as never)
    await until(() => w.calls.armed[0]?.state === 'connected')
    expect(w.calls.armed).toEqual([expect.objectContaining({ documentId: THIRD, title: 'From the gallery', state: 'connected' })])
  })

  test('a change to an existing canvas arms it once, under the title the mint names', async ($, on) => {
    const w = world(on)
    unpagedServer(on)
    await edit($)
    await until(() => w.calls.armed[0]?.state === 'connected')
    await $.tool.call({ tool: `${UNPAGED}element_update`, documentId: DOCUMENT, nodeId: 'root', elementId: 'e1', updates: {} } as never)
    await quiet()
    expect(mints(w)).toHaveLength(1)
    expect(w.calls.armed).toEqual([expect.objectContaining({ documentId: DOCUMENT, title: 'Plan canvas', state: 'connected' })])
  })

  test('the connector name of the server arms too', async ($, on) => {
    const w = world(on)
    unpagedServer(on)
    await $.tool.call({ tool: 'mcp__unpaged__document_create', title: 'Owl detective' } as never)
    await until(() => w.calls.armed.length > 0)
    expect(mints(w).map(c => c.args.documentId)).toEqual([SECOND])
  })

  test('a refused call, a read, and a change to the document record arm nothing', async ($, on) => {
    const w = world(on)
    const called = unpagedServer(on, { refuse: ['document_create'] })
    await $.tool.call({ tool: `${UNPAGED}document_create`, title: 'Refused' } as never)
    await $.tool.call({ tool: `${UNPAGED}document_get`, documentId: DOCUMENT } as never)
    await $.tool.call({ tool: `${UNPAGED}node_picture`, documentId: DOCUMENT, nodeId: 'root' } as never)
    await $.tool.call({ tool: `${UNPAGED}document_update`, documentId: DOCUMENT, folder: 'Owls' } as never)
    await quiet()
    expect(called).toEqual(['document_create', 'document_get', 'node_picture', 'document_update'])
    expect(mints(w)).toEqual([])
    expect(w.calls.armed).toEqual([])
  })

  test('a canvas stopped by hand stays stopped through later changes, and listen_arm still arms it', async ($, on) => {
    const w = world(on)
    unpagedServer(on)
    await edit($)
    await until(() => w.calls.armed[0]?.state === 'connected')
    await $.tool.call({ tool: 'mcp__unpaged__listen_stop', documentId: DOCUMENT } as never)
    await edit($)
    await quiet()
    expect(mints(w)).toHaveLength(1)
    expect(w.calls.armed).toEqual([])
    const again = await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    expect(JSON.stringify(again)).toContain('Listening on')
    expect(mints(w)).toHaveLength(2)
  })

  test('the record of armed canvases is written again after /clear, so a stopped canvas stays stopped', async ($, on) => {
    const w = world(on)
    unpagedServer(on)
    await edit($)
    await until(() => w.calls.armed[0]?.state === 'connected')
    await $.tool.call({ tool: 'mcp__unpaged__listen_stop', documentId: DOCUMENT } as never)
    w.calls.armedOnce = []
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(w.calls.armedOnce).toEqual([DOCUMENT])
    await edit($)
    await quiet()
    expect(mints(w)).toHaveLength(1)
  })

  test('a canvas another session took over is not taken back by the next change', async ($, on) => {
    const w = world(on, { pages: [page(), { status: 409 }] })
    unpagedServer(on)
    await edit($)
    await until(() => w.calls.armed[0]?.state === 'connected')
    await w.clock.advance(30_000)
    await until(() => w.calls.armed[0]?.state === 'stopped')
    await edit($)
    await quiet()
    expect(mints(w)).toHaveLength(1)
    expect(w.calls.armed).toEqual([expect.objectContaining({ documentId: DOCUMENT, state: 'stopped' })])
  })

  test('a refused mint is one toast, and the next change does not mint again', async ($, on) => {
    const w = world(on, { mintError: true })
    unpagedServer(on)
    await edit($)
    await until(() => w.calls.toasts.length > 0)
    await edit($)
    await quiet()
    expect(mints(w)).toHaveLength(1)
    expect(w.calls.toasts).toEqual([expect.stringContaining(`Not listening to ${DOCUMENT}`)])
    expect(w.calls.armed).toEqual([])
  })

  test('deleting a canvas the session listens to stops listening and revokes its key', async ($, on) => {
    const w = world(on)
    unpagedServer(on)
    await $.tool.call({ tool: `${UNPAGED}document_create`, title: 'Scratch' } as never)
    await until(() => w.calls.armed[0]?.state === 'connected')
    await $.tool.call({ tool: `${UNPAGED}document_delete`, documentId: SECOND } as never)
    await until(() => w.calls.armed.length === 0)
    expect(w.calls.armed).toEqual([])
    expect(w.calls.mcp.at(-1)).toEqual({ tool: 'agent_listener_key_revoke', args: { keyId: 'key-22222222' } })
  })

  test('a delete answers without waiting for the revoke of its key', async ($, on) => {
    const w = world(on, { hangRevoke: true })
    unpagedServer(on)
    await $.tool.call({ tool: `${UNPAGED}document_create`, title: 'Scratch' } as never)
    await until(() => w.calls.armed[0]?.state === 'connected')
    const answer = await $.tool.call({ tool: `${UNPAGED}document_delete`, documentId: SECOND } as never)
    expect(JSON.stringify(answer)).toContain('ok')
    await until(() => w.calls.mcp.some(c => c.tool === 'agent_listener_key_revoke'))
    expect(w.calls.mcp.at(-1)).toEqual({ tool: 'agent_listener_key_revoke', args: { keyId: 'key-22222222' } })
  })

  test('a canvas deleted while its key is being minted is stopped once the mint lands', async ($, on) => {
    const w = world(on, { holdMint: true })
    unpagedServer(on)
    await $.tool.call({ tool: `${UNPAGED}document_create`, title: 'Scratch' } as never)
    await until(() => mints(w).length === 1)
    await $.tool.call({ tool: `${UNPAGED}document_delete`, documentId: SECOND } as never)
    w.releaseMint()
    await until(() => w.calls.mcp.some(c => c.tool === 'agent_listener_key_revoke') && w.calls.armed.length === 0)
    expect(w.calls.mcp.at(-1)).toEqual({ tool: 'agent_listener_key_revoke', args: { keyId: 'key-22222222' } })
    expect(w.calls.armed).toEqual([])
  })

  test('a key minted by hand for a canvas the session listens to is answered by the plugin, not the server', async ($, on) => {
    const w = world(on)
    const called = unpagedServer(on)
    await edit($)
    await until(() => w.calls.armed[0]?.state === 'connected')
    const answer = await $.tool.call({ tool: `${UNPAGED}agent_listener_key_create`, documentId: DOCUMENT } as never)
    expect(JSON.stringify(answer)).toContain('Not minted: this session already listens to Plan canvas')
    expect(called).toEqual(['batch_create_elements'])
    expect(mints(w)).toHaveLength(1)
    expect(w.calls.process.filter(c => c.argv[2] === 'store')).toHaveLength(1)
  })

  test('a key minted by hand for a canvas the session does not listen to goes to the server', async ($, on) => {
    world(on)
    const called = unpagedServer(on)
    await $.tool.call({ tool: `${UNPAGED}agent_listener_key_create`, documentId: SECOND } as never)
    expect(called).toEqual(['agent_listener_key_create'])
  })

  // Another plugin minting by hand: its call reaches the mod's hooks under its
  // own name, as the model's does under the engine's. The mod's own mint is a
  // tool call under the mod's name in a session; here the world answers it as
  // `mcp.call`, so it never reaches the guard. An inline plugin loads on its
  // own, so it spells the tool name out.
  const handMinter: Plugin = {
    name: 'hand-minter',
    register: on => {
      on('command.run', { command: 'hand-mint' }, async ($, e) => ({
        text: JSON.stringify(await $.tool.call({ tool: 'mcp__plugin_unpaged_unpaged__agent_listener_key_create', documentId: e.args } as never)),
      }))
    },
  }

  test('/unpaged-listen arm mints its key, and a key another plugin mints meanwhile is answered by the plugin', { plugins: [handMinter] }, async ($, on) => {
    const w = world(on, { holdMint: true })
    const called = unpagedServer(on)
    const arming = $.command.run({ command: 'unpaged-listen', args: `arm ${DOCUMENT}` } as never)
    await until(() => mints(w).length === 1)
    const byHand = await $.command.run({ command: 'hand-mint', args: DOCUMENT } as never)
    expect(byHand.text).toContain(`Not minted: this session already listens to ${DOCUMENT}`)
    w.releaseMint()
    expect((await arming).text).toContain('Listening on Plan canvas')
    expect(called).toEqual([])
    expect(mints(w)).toHaveLength(1)
  })
})
