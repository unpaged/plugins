// Tests of the listener mod's arming, delivery and stopping, run against the
// engine with the world beneath the mod answered by the test's own hooks.
import { describe, expect, mock, test } from 'claude-code/testing'
import { DOCUMENT, KEY, POLL_URL, frame, keyFileFor, page, statusFileFor, world } from './test-world'

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
    expect(JSON.parse(w.files.get(STATUS_FILE) ?? '{}')).toEqual(expect.objectContaining({ transport: 'mod-v1', state: 'connected', documentId: DOCUMENT }))
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
    expect(lines.slice(1).map(l => JSON.parse(l).id)).toEqual(['e1', 'e2'])
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
    expect(w.calls.process.some(c => c.argv[2] === 'retire' && c.argv[3] === DOCUMENT && c.argv[4] === 'key-1')).toBe(true)
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

describe('stop', () => {
  test('stops the loop, revokes the key by its id and forgets the file', async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT } as never)
    const answer = await $.tool.call({ tool: 'mcp__unpaged__listen_stop', documentId: DOCUMENT } as never)
    expect(JSON.stringify(answer)).toContain('key revoked')
    expect(w.calls.mcp.at(-1)).toEqual({ tool: 'agent_listener_key_revoke', args: { keyId: 'key-1' } })
    expect(w.calls.process.some(c => c.argv[2] === 'forget')).toBe(true)
    expect(w.calls.armed).toEqual([])
    await w.clock.advance(60_000)
    expect(w.calls.fetch).toHaveLength(1)
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
