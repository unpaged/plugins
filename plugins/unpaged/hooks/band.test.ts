// Tests of the band above the prompt and the canvases pane, mounted through
// the engine on each surface the mod draws on.
import { describe, expect, test } from 'claude-code/testing'
import { DOCUMENT, SECOND, THIRD, bandProps, frame, page, paneProps, world } from './test-world'

const SURFACES = ['terminal', 'desktop'] as const
const PANE = 'unpaged-listening'

describe('band', () => {
  test('draws nothing of its own while nothing is armed', async ($, on) => {
    world(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'unpaged', surface, component: 'AbovePrompt', props: bandProps() })
      expect(await ui.find({ text: /Listening/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('one canvas: the line, its title linking to the canvas, link and stop hotkeys, and the count', async ($, on) => {
    const w = world(on, { pages: [page(), page([frame('e1'), frame('e2')])] })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'unpaged', surface, component: 'AbovePrompt', props: bandProps() })
      expect((await ui.find({ type: 'Text', text: 'Listening' }))?.text).toBe('Listening')
      const link = await ui.find({ type: 'Link' })
      expect(link?.text).toContain('Plan canvas')
      expect(link?.props.href).toBe(`https://unpaged.io/document/${DOCUMENT}/edit`)
      expect(await ui.find({ text: /no new comments/ })).toBeDefined()
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map(b => [b.key, b.props.hotkey])).toEqual([
        ['link', '1'],
        ['stop', '2'],
      ])
      await ui.unmount()
    }
    const ui = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
    await w.clock.advance(30_000)
    await w.clock.advance(50)
    expect(await ui.find({ text: /2 new/ })).toBeDefined()
    // Where the terminal draws no links and the band cuts the address, link shows it whole.
    await ui.press({ key: 'link' })
    expect(w.calls.toasts.at(-1)).toBe(`https://unpaged.io/document/${DOCUMENT}/edit`)
    await ui.unmount()
    // The link is Claude Code's to open: the only program the plugin started is hostname, for the key's label.
    expect(w.calls.process.map(c => c.argv)).toEqual([['hostname']])
  })

  test('the stop hotkey revokes the key and the band goes quiet', async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    const ui = await $.ui.mount({ plugin: 'unpaged', surface: 'desktop', component: 'AbovePrompt', props: bandProps() })
    await ui.press({ key: 'stop' })
    expect(w.calls.mcp.at(-1)).toEqual({ tool: 'agent_listener_key_revoke', args: { keyId: 'key-1' } })
    expect(w.calls.armed).toEqual([])
    expect(await ui.find({ text: /Listening/ })).toBeUndefined()
    expect(w.calls.toasts.filter(t => t.includes('still live'))).toEqual([])
    await ui.unmount()
  })

  test('a stop whose revoke is refused says the key is still live and to ask Claude, from the band, the pane and stop all', async ($, on) => {
    // No rule allows the revoke, and auto mode refuses the plugin's own: the band still tries it, since the default mode asks.
    const w = world(on, { revokeRule: 'ask', revokeRefused: true })
    const live = (keyId: string, title: string) => `Stopped listening to ${title}; its key is still live (keyId ${keyId}): ask Claude to stop listening to ${title}, or revoke it in Unpaged.`
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    const one = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
    await one.press({ key: 'stop' })
    expect(w.calls.armed).toEqual([])
    expect(w.calls.toasts).toEqual([live('key-1', 'Plan canvas')])
    await one.unmount()
    for (const documentId of [DOCUMENT, SECOND, THIRD]) {
      await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId } as never)
    }
    const pane = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'Pane', props: paneProps(), requestId: PANE })
    await pane.press({ key: `stop-${SECOND}` })
    expect(w.calls.toasts.at(-1)).toBe(live('key-22222222', 'Canvas 2222'))
    await pane.unmount()
    const band = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
    await band.press({ key: 'stop-all' })
    expect(w.calls.armed).toEqual([])
    expect(w.calls.toasts.slice(-2)).toEqual([live('key-1', 'Plan canvas'), live('key-33333333', 'Canvas 3333')])
    await band.unmount()
  })

  test('clearing a canvas whose key the server rejected revokes nothing and says nothing of a live key', async ($, on) => {
    const w = world(on, { pages: [page(), { status: 401 }], revokeRefused: true })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    await w.clock.advance(30_000)
    await w.clock.advance(50)
    expect(w.calls.armed[0]).toEqual(expect.objectContaining({ state: 'stopped', reason: 'http-401' }))
    const ui = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
    await ui.press({ key: 'stop' })
    expect(w.calls.armed).toEqual([])
    expect(w.calls.mcp.filter(c => c.tool === 'agent_listener_key_revoke')).toEqual([])
    expect(w.calls.toasts.filter(t => t.includes('still live'))).toEqual([])
    await ui.unmount()
  })

  test('while a reply turn runs the line says so', async ($, on) => {
    const w = world(on, { pages: [page(), page([frame('e1')])] })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    await w.clock.advance(30_000)
    await w.clock.advance(50)
    expect(w.calls.submits).toHaveLength(1)
    const queued = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'AbovePrompt', props: bandProps({ isWorking: true }) })
    expect(await queued.find({ text: /replying on the canvas/ })).toBeUndefined()
    await queued.unmount()
    await w.startTurn()
    const ui = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'AbovePrompt', props: bandProps({ isWorking: true }) })
    expect(await ui.find({ text: /replying on the canvas/ })).toBeDefined()
    await ui.unmount()
  })

  test('three canvases: one line, the pane lists each with its link, link and stop buttons, stop all clears them', async ($, on) => {
    const w = world(on)
    for (const documentId of [DOCUMENT, SECOND, THIRD]) {
      await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId } as never)
    }
    expect(w.calls.armed).toHaveLength(3)
    for (const surface of SURFACES) {
      const band = await $.ui.mount({ plugin: 'unpaged', surface, component: 'AbovePrompt', props: bandProps() })
      expect(await band.find({ text: 'on 3 canvases' })).toBeDefined()
      expect((await band.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['canvases', 'stop-all'])
      const pane = await $.ui.mount({ plugin: 'unpaged', surface, component: 'Pane', props: paneProps(), requestId: PANE })
      expect((await pane.findAll({ type: 'Button' })).map(b => b.key)).toEqual([
        `link-${DOCUMENT}`, `stop-${DOCUMENT}`, `link-${SECOND}`, `stop-${SECOND}`, `link-${THIRD}`, `stop-${THIRD}`,
      ])
      const links = await pane.findAll({ type: 'Link' })
      expect(links.map(l => l.props.href)).toEqual([DOCUMENT, SECOND, THIRD].map(id => `https://unpaged.io/document/${id}/edit`))
      expect(links.map((l, i) => l.text?.includes(['Plan canvas', 'Canvas 2222', 'Canvas 3333'][i]))).toEqual([true, true, true])
      await pane.unmount()
      await band.unmount()
    }
    const pane = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'Pane', props: paneProps(), requestId: PANE })
    await pane.press({ key: `link-${THIRD}` })
    expect(w.calls.toasts.at(-1)).toBe(`https://unpaged.io/document/${THIRD}/edit`)
    await pane.press({ key: `stop-${SECOND}` })
    expect(w.calls.armed.map(c => c.documentId)).toEqual([DOCUMENT, THIRD])
    await pane.unmount()
    const band = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
    expect(await band.find({ text: 'on 2 canvases' })).toBeDefined()
    await band.press({ key: 'stop-all' })
    expect(w.calls.armed).toEqual([])
    expect(w.calls.mcp.filter(c => c.tool === 'agent_listener_key_revoke')).toHaveLength(3)
    await band.unmount()
  })

  test('a reply turn clears the count of the canvas it answered, not one whose comment arrived meanwhile', async ($, on) => {
    // Polls are served in call order across both loops: A then B each cycle.
    const w = world(on, { pages: [page(), page(), page([frame('a1', 'on A', DOCUMENT)]), page(), page(), page([frame('b1', 'on B', SECOND)]), page(), page()] })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: SECOND } as never)
    const counts = () => Object.fromEntries(w.calls.armed.map(c => [c.documentId, c.unread]))
    await w.clock.advance(30_000)
    await w.clock.advance(50)
    expect(counts()).toEqual({ [DOCUMENT]: 1, [SECOND]: 0 })
    expect(w.calls.submits).toHaveLength(1)
    await w.startTurn()
    expect(w.calls.replying).toEqual([DOCUMENT])
    // While A's reply turn runs, a comment lands on B: its prompt queues behind the turn.
    await w.clock.advance(30_000)
    await w.clock.advance(50)
    expect(counts()).toEqual({ [DOCUMENT]: 1, [SECOND]: 1 })
    expect(w.calls.submits).toHaveLength(2)
    expect(w.calls.replying).toEqual([DOCUMENT])
    await $.turn.complete({} as never)
    expect(counts()).toEqual({ [DOCUMENT]: 0, [SECOND]: 1 })
    expect(w.calls.replying).toEqual([])
    // B's turn starts next and clears B when it completes.
    await w.startTurn()
    expect(w.calls.replying).toEqual([SECOND])
    await $.turn.complete({} as never)
    expect(counts()).toEqual({ [DOCUMENT]: 0, [SECOND]: 0 })
  })

  test('/clear keeps listening and rebuilds the band state', async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    const writes = w.calls.armed.length ? 1 : 0
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(w.calls.armed).toEqual([expect.objectContaining({ documentId: DOCUMENT, state: 'connected' })])
    expect(writes).toBe(1)
    await w.clock.advance(30_000)
    expect(w.calls.fetch).toHaveLength(2)
    const ui = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
    expect(await ui.find({ text: 'Plan canvas' })).toBeDefined()
    await ui.unmount()
  })
})
