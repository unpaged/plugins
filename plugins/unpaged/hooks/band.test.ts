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

  test('one canvas: the line, its two hotkeys, and open resets the count', async ($, on) => {
    const w = world(on, { pages: [page(), page([frame('e1'), frame('e2')])] })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'unpaged', surface, component: 'AbovePrompt', props: bandProps() })
      expect((await ui.find({ type: 'Text', text: 'Listening' }))?.text).toBe('Listening')
      expect(await ui.find({ text: 'Plan canvas' })).toBeDefined()
      expect(await ui.find({ text: /no new comments/ })).toBeDefined()
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map(b => [b.key, b.props.hotkey])).toEqual([
        ['open', '1'],
        ['stop', '2'],
      ])
      await ui.unmount()
    }
    const ui = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
    await w.clock.advance(30_000)
    await w.clock.advance(50)
    expect(await ui.find({ text: /2 new/ })).toBeDefined()
    await ui.press({ key: 'open' })
    expect(w.calls.opened).toEqual([`https://unpaged.io/document/${DOCUMENT}/edit`])
    expect(w.calls.armed[0]).toEqual(expect.objectContaining({ unread: 0 }))
    expect(await ui.find({ text: /no new comments/ })).toBeDefined()
    await ui.unmount()
  })

  test('the stop hotkey revokes the key and the band goes quiet', async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    const ui = await $.ui.mount({ plugin: 'unpaged', surface: 'desktop', component: 'AbovePrompt', props: bandProps() })
    await ui.press({ key: 'stop' })
    expect(w.calls.mcp.at(-1)).toEqual({ tool: 'agent_listener_key_revoke', args: { keyId: 'key-1' } })
    expect(w.calls.armed).toEqual([])
    expect(await ui.find({ text: /Listening/ })).toBeUndefined()
    await ui.unmount()
  })

  test('while a reply turn runs the line says so', async ($, on) => {
    const w = world(on, { pages: [page(), page([frame('e1')])] })
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    await w.clock.advance(30_000)
    await w.clock.advance(50)
    expect(w.calls.submits).toHaveLength(1)
    const ui = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'AbovePrompt', props: bandProps({ isWorking: true }) })
    expect(await ui.find({ text: /replying on the canvas/ })).toBeDefined()
    await ui.unmount()
  })

  test('three canvases: one line, the pane lists each with its own buttons, stop all clears them', async ($, on) => {
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
        `open-${DOCUMENT}`, `stop-${DOCUMENT}`, `open-${SECOND}`, `stop-${SECOND}`, `open-${THIRD}`, `stop-${THIRD}`,
      ])
      expect(await pane.find({ text: 'Plan canvas' })).toBeDefined()
      await pane.unmount()
      await band.unmount()
    }
    const pane = await $.ui.mount({ plugin: 'unpaged', surface: 'terminal', component: 'Pane', props: paneProps(), requestId: PANE })
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
