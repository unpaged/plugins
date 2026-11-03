// Tests of the architecture line above the prompt: what it shows in each
// state, how a pull request starts the comparison, and how the command's
// report settles it, run against the engine with the world beneath the mod
// answered by the test's own hooks.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { DOCUMENT, bandProps, until, world } from './test-world'
import type { World } from './test-world'

const ARCH = '55555555-5555-4555-8555-555555555555'
/** The pointer file and the git folder, under the session's working folder `/repo`. */
const POINTER = '/repo/.unpaged/architecture.json'
const GIT = '/repo/.git'
const PR_URL = 'https://github.com/acme/shop-api/pull/7'
const REPORT = 'mcp__unpaged__architecture_report'
/** 2026-11-10 12:00 UTC: the clock the tests run at. */
const NOW = Date.parse('2026-11-10T12:00:00Z')

const pointerFor = (documentId = ARCH) => JSON.stringify({ documentId, url: `https://unpaged.io/document/${documentId}/edit`, title: 'shop-api' })
const canvas = (note: string, commitNote = 'compared at abc1234 on 2026-11-03') => ({
  id: ARCH,
  title: 'shop-api',
  rootNodeId: 'root',
  nodes: [
    { id: 'root', elements: [{ properties: { text: '# shop-api' } }, { properties: { text: note } }, { properties: { text: commitNote } }] },
    { id: 'child', parentId: 'root', elements: [] },
  ],
})
const verdict = (changes: Record<string, unknown> = {}) => ({
  documentId: ARCH,
  state: 'current',
  title: 'shop-api',
  checkedAt: '2026-11-03',
  commit: 'abc1234',
  behindSince: null,
  reportedAt: '2026-11-03T10:00:00.000Z',
  ...changes,
})

/**
 * The repository beneath the mod: a git folder, its pointer file, and the
 * tools that open a pull request, answered as the terminal and a GitHub
 * connector would.
 */
function repo(on: On, w: World, settings: { git?: boolean; pointer?: boolean; answer?: string; error?: boolean } = {}) {
  if (settings.git !== false) w.files.set(GIT, 'gitdir: /repo/.git')
  if (settings.pointer !== false) w.files.set(POINTER, pointerFor())
  const answer = settings.answer ?? `Creating pull request for feature into main in acme/shop-api\n\n${PR_URL}\n`
  on('tool.call', { tool: 'Bash' }, () =>
    settings.error
      ? ({ isError: true, result: 'Error: gh failed', text: 'Error: gh failed' } as never)
      : ({ result: { stdout: answer, stderr: '' }, text: answer } as never),
  )
  on('tool.call', { tool: /^mcp__plugin_engineering_github__/ }, () => {
    const body = JSON.stringify({ number: 7, html_url: PR_URL })
    return { result: [{ type: 'text', text: body }], text: body } as never
  })
}

/** Starts the session and waits for the line to be drawn: the pointer, the stored verdict and, where allowed, the canvas are read after the start answers. */
async function start($: Engine, w: World, drawn: (l: Record<string, unknown> | null) => boolean = l => l !== null) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await until(() => drawn(w.calls.architecture))
}
/** A turn's end on the main loop, as the engine raises it. */
const turnOver = ($: Engine) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)

async function line($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'unpaged', surface, component: 'AbovePrompt', props: bandProps() })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
  const buttons = (await ui.findAll({ type: 'Button' })).map(b => [b.key, b.props.hotkey])
  const link = await ui.find({ type: 'Link' })
  return { ui, texts, buttons, link }
}

describe('architecture line', () => {
  test('draws nothing outside a git repository', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w, { git: false, pointer: false })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await until(() => w.calls.checks.length > 0, 20)
    expect(w.calls.architecture).toBeNull()
    const { ui, texts } = await line($)
    expect(texts.join(' ')).not.toContain('Architecture')
    await ui.unmount()
  })

  test('a repository with no pointer file: the grey invitation, and create submits the prompt', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w, { pointer: false })
    await start($, w)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'none', documentId: null }))
    for (const surface of ['terminal', 'desktop'] as const) {
      const { ui, texts, buttons, link } = await line($, surface)
      expect(texts).toContain('Architecture')
      expect(texts.some(t => t.includes('no architecture document yet'))).toBe(true)
      expect(buttons).toEqual([['arch-create', 'c']])
      expect(link).toBeUndefined()
      await ui.unmount()
    }
    const { ui } = await line($)
    await ui.press({ key: 'arch-create' })
    expect(w.calls.submits).toHaveLength(1)
    expect(w.calls.submits[0]).toContain('invoke the skill unpaged:architecture with no arguments')
    await ui.unmount()
    // Nothing of the canvas was read: no rule allows it, and there is no canvas.
    expect(w.calls.mcp).toEqual([])
  })

  test('a pointer with no verdict known on this machine: grey, with update and link', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    await start($, w)
    await until(() => w.calls.checks.includes('mcp__unpaged__document_get'))
    expect(w.calls.mcp).toEqual([])
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'unknown', documentId: ARCH, title: 'shop-api' }))
    const { ui, texts, buttons, link } = await line($)
    expect(texts.some(t => t.includes('not compared from this machine yet'))).toBe(true)
    expect(buttons).toEqual([
      ['arch-update', 'u'],
      ['arch-link', 'l'],
    ])
    expect(link?.props.href).toBe(`https://unpaged.io/document/${ARCH}/edit`)
    expect(link?.text).toContain('shop-api')
    await ui.press({ key: 'arch-link' })
    expect(w.calls.toasts.at(-1)).toBe(`https://unpaged.io/document/${ARCH}/edit`)
    await ui.unmount()
  })

  test('session start reads the date note off the canvas where the rules allow document_get: green, checked on its day', async ($, on) => {
    const w = world(on, { now: NOW, docRule: 'allow', document: canvas('**Checked:** 2026-11-03') })
    repo(on, w)
    await start($, w, l => l?.state === 'current')
    expect(w.calls.mcp).toEqual([{ tool: 'document_get', args: { documentId: ARCH } }])
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: 'abc1234', checkedAt: Date.parse('2026-11-03T00:00:00Z') }))
    expect(w.store.get(`architecture:${ARCH}`)).toEqual(expect.objectContaining({ state: 'current', checkedAt: '2026-11-03', commit: 'abc1234' }))
    const { ui, texts, buttons } = await line($)
    expect(texts.some(t => t.includes('up to date') && t.includes('checked 3 Nov'))).toBe(true)
    expect(buttons).toEqual([['arch-link', 'l']])
    await ui.unmount()
  })

  test('a behind note on the canvas is yellow, since its day, with update', async ($, on) => {
    const w = world(on, { now: NOW, docRule: 'allow', document: canvas('**Behind since:** 2026-11-05', 'compared at def5678 on 2026-11-08') })
    repo(on, w)
    await start($, w, l => l?.state === 'behind')
    expect(w.calls.architecture).toEqual(
      expect.objectContaining({ state: 'behind', commit: 'def5678', behindSince: Date.parse('2026-11-05T00:00:00Z'), checkedAt: Date.parse('2026-11-08T00:00:00Z') }),
    )
    const { ui, texts, buttons } = await line($)
    expect(texts.some(t => t.includes('behind since 5 Nov'))).toBe(true)
    expect(buttons).toEqual([
      ['arch-update', 'u'],
      ['arch-link', 'l'],
    ])
    await ui.unmount()
  })

  test('a canvas the server says is gone is red, with create', async ($, on) => {
    const w = world(on, { now: NOW, docRule: 'allow', documentMissing: true })
    repo(on, w)
    await start($, w, l => l?.state === 'lost')
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'lost' }))
    const { ui, texts, buttons } = await line($)
    expect(texts.some(t => t.includes('canvas deleted or unreachable'))).toBe(true)
    expect(buttons).toEqual([
      ['arch-create', 'c'],
      ['arch-link', 'l'],
    ])
    await ui.unmount()
  })

  test('where the canvas is not read, the verdict stored on this machine draws the line', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict({ state: 'behind', behindSince: '2025-12-24', checkedAt: '2026-11-03' }))
    await start($, w)
    expect(w.calls.mcp).toEqual([])
    const { ui, texts } = await line($)
    expect(texts.some(t => t.includes('behind since 24 Dec 2025'))).toBe(true)
    await ui.unmount()
  })

  test('three months without a comparison is red, with update', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict({ checkedAt: '2026-08-01', commit: 'aaa1111' }))
    await start($, w)
    const { ui, texts, buttons } = await line($)
    expect(texts.some(t => t.includes('not compared since 1 Aug'))).toBe(true)
    expect(buttons).toEqual([
      ['arch-update', 'u'],
      ['arch-link', 'l'],
    ])
    await ui.unmount()
  })

  test('the plugin grants itself no permission: architecture_report is left to the rules', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    expect(await $.tool.check({ tool: REPORT, input: { documentId: ARCH, state: 'current' } })).toEqual({ decision: 'ask' })
    expect(w.calls.checks).toContain(REPORT)
  })
})

describe('the comparison after a pull request', () => {
  test('gh pr create in the terminal: the line blinks yellow, one prompt starts the comparison, the report settles it', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    const ran = await $.tool.call({ tool: 'Bash', command: 'git push -u origin feature && gh pr create --title "Feature" --body "Adds it"' } as never)
    expect(JSON.stringify(ran)).toContain(PR_URL)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing', source: 'pull-request', on: true }))
    await w.clock.advance(50)
    expect(w.calls.submits).toHaveLength(1)
    expect(w.calls.submits[0]).toContain(PR_URL)
    expect(w.calls.submits[0]).toContain('Invoke the skill unpaged:architecture with the arguments "compare"')
    // The dot blinks while the comparison runs.
    await w.clock.advance(600)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing', on: false }))
    await w.clock.advance(600)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing', on: true }))
    const { ui, texts, buttons } = await line($)
    expect(texts.some(t => t.includes('comparing with the pull request'))).toBe(true)
    expect(buttons).toEqual([['arch-link', 'l']])
    await ui.unmount()
    await w.startTurn()
    const answer = await $.tool.call({ tool: REPORT, documentId: ARCH, state: 'behind', checkedAt: '2026-11-10', commit: 'bbb2222', title: 'shop-api' } as never)
    expect(JSON.stringify(answer)).toContain('behind since 10 Nov')
    expect(w.calls.architecture).toEqual(
      expect.objectContaining({ state: 'behind', commit: 'bbb2222', behindSince: Date.parse('2026-11-10T00:00:00Z'), checkedAt: Date.parse('2026-11-10T00:00:00Z') }),
    )
    expect(w.store.get(`architecture:${ARCH}`)).toEqual(expect.objectContaining({ state: 'behind', behindSince: '2026-11-10', commit: 'bbb2222' }))
    // The blink is over: the dot stays.
    const settled = w.calls.architecture
    await w.clock.advance(1200)
    expect(w.calls.architecture).toEqual(settled)
    // The turn's end restores nothing: the report settled it.
    await turnOver($)
    expect(w.calls.architecture).toEqual(settled)
    expect(w.calls.toasts.filter(t => t.includes('did not finish'))).toEqual([])
  })

  test("a GitHub connector's pull-request tool starts it too", async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    await $.tool.call({ tool: 'mcp__plugin_engineering_github__create_pull_request', owner: 'acme', repo: 'shop-api', title: 'Feature' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing', source: 'pull-request' }))
    await w.clock.advance(50)
    expect(w.calls.submits).toHaveLength(1)
    expect(w.calls.submits[0]).toContain(PR_URL)
  })

  test('a pull-request command that creates nothing here starts nothing: --web, --dry-run, a failure, or no address in its answer', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w, { answer: 'Opening github.com in your browser.\n' })
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    for (const command of ['gh pr create --web', 'gh pr create --dry-run --title x', 'gh pr create --title x', 'gh pr list', 'echo gh pr create']) {
      await $.tool.call({ tool: 'Bash', command } as never)
    }
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current' }))
    await w.clock.advance(100)
    expect(w.calls.submits).toEqual([])
  })

  test('a failed pull-request command starts nothing', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w, { error: true })
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' } as never)
    await w.clock.advance(100)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current' }))
    expect(w.calls.submits).toEqual([])
  })

  test('with no pointer file a pull request starts nothing', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w, { pointer: false })
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' } as never)
    await w.clock.advance(100)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'none' }))
    expect(w.calls.submits).toEqual([])
  })

  test('a pull request command followed by a browser view, or one whose title names a flag, still starts the comparison', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title "Add a --dry-run flag to deploy" --fill && gh pr view --web' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing', source: 'pull-request' }))
  })

  test('a pointer written after the session started is found when the pull request opens', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w, { pointer: false })
    await start($, w)
    w.files.set(POINTER, pointerFor())
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing', documentId: ARCH }))
  })

  test('a turn that ends without a report puts the line back and says so', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' } as never)
    await w.clock.advance(50)
    // The turn that ran the command ends first: the comparison's turn has not started.
    await turnOver($)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing' }))
    await w.startTurn()
    await turnOver($)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: 'abc1234' }))
    expect(w.calls.toasts.at(-1)).toContain('did not finish')
    // A second pull request starts a new comparison.
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title y' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing' }))
  })

  test('a second pull request while one comparison runs starts no other', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' } as never)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title y' } as never)
    await w.clock.advance(100)
    expect(w.calls.submits).toHaveLength(1)
  })

  test('update from the line re-checks the whole canvas: blinking, one prompt, the report turns it green', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict({ state: 'behind', behindSince: '2026-11-05' }))
    await start($, w)
    const { ui } = await line($)
    await ui.press({ key: 'arch-update' })
    await ui.unmount()
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing', source: 'update' }))
    const { ui: blinking, texts } = await line($)
    expect(texts.some(t => t.includes('updating the canvas'))).toBe(true)
    await blinking.unmount()
    await w.clock.advance(50)
    expect(w.calls.submits).toHaveLength(1)
    expect(w.calls.submits[0]).toContain('invoke the skill unpaged:architecture with the arguments "update"')
    await w.startTurn()
    await $.tool.call({ tool: REPORT, documentId: ARCH, state: 'current', checkedAt: '2026-11-10', commit: 'ccc3333' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: 'ccc3333', behindSince: null }))
  })

  test('the report refuses a canvas the pointer file does not name', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    await start($, w)
    const answer = await $.tool.call({ tool: REPORT, documentId: DOCUMENT, state: 'current', checkedAt: '2026-11-10' } as never)
    expect(JSON.stringify(answer)).toContain('does not name canvas')
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'unknown' }))
    const bad = await $.tool.call({ tool: REPORT, documentId: ARCH, state: 'maybe' } as never)
    expect(JSON.stringify(bad)).toContain('state must be')
  })

  test('the report after create draws the line from the pointer just written', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w, { pointer: false })
    await start($, w)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'none' }))
    w.files.set(POINTER, pointerFor())
    await $.tool.call({ tool: REPORT, documentId: ARCH, state: 'current', checkedAt: '2026-11-10', commit: 'ddd4444' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', documentId: ARCH, title: 'shop-api', commit: 'ddd4444' }))
    const { ui, texts } = await line($)
    expect(texts.some(t => t.includes('checked 10 Nov'))).toBe(true)
    await ui.unmount()
  })

  test('the listening line and the architecture line show together, each with its own keys', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict({ state: 'behind', behindSince: '2026-11-05' }))
    await start($, w)
    await $.tool.call({ tool: 'mcp__unpaged__listen_arm', documentId: DOCUMENT, title: 'Plan canvas' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const { ui, texts, buttons } = await line($, surface)
      expect(texts).toContain('Listening')
      expect(texts).toContain('Architecture')
      expect(buttons).toEqual([
        ['link', '1'],
        ['stop', '2'],
        ['arch-update', 'u'],
        ['arch-link', 'l'],
      ])
      await ui.unmount()
    }
  })

  test('/clear keeps the line', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: 'abc1234' }))
  })
})

describe('what the review asked for', () => {
  test('the line links to the canvas by its id, whatever address the pointer file carries', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w, { pointer: false })
    w.files.set(POINTER, JSON.stringify({ documentId: ARCH, url: 'https://evil.example/look-alike', title: 'shop-api' }))
    await start($, w)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ documentId: ARCH, boardUrl: `https://unpaged.io/document/${ARCH}/edit` }))
    const { ui, link } = await line($)
    expect(link?.props.href).toBe(`https://unpaged.io/document/${ARCH}/edit`)
    await ui.press({ key: 'arch-link' })
    expect(w.calls.toasts.at(-1)).toBe(`https://unpaged.io/document/${ARCH}/edit`)
    await ui.unmount()
  })

  test('a session started below the repository top finds the pointer there, and the invitation without one', async ($, on) => {
    const w = world(on, { now: NOW, cwd: '/repo/packages/api' })
    repo(on, w)
    await start($, w)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'unknown', documentId: ARCH }))
    expect(w.calls.fs).toContain('/repo/packages/api/.git')
    expect(w.calls.fs).toContain('/repo/.git')
    expect(w.calls.fs).toContain(POINTER)
  })

  test('a session started below the repository top shows the invitation when there is no pointer', async ($, on) => {
    const w = world(on, { now: NOW, cwd: '/repo/packages/api' })
    repo(on, w, { pointer: false })
    await start($, w)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'none' }))
  })

  test("the commit note's day is the last comparison's whatever the order of the notes, and a commit of the wrong shape is dropped", async ($, on) => {
    const document = {
      id: ARCH,
      title: 'shop-api',
      rootNodeId: 'root',
      nodes: [{ id: 'root', elements: [{ properties: { text: 'compared at nope; rm -rf on 2026-11-08' } }, { properties: { text: '**Checked:** 2026-11-03' } }] }],
    }
    const w = world(on, { now: NOW, docRule: 'allow', document })
    repo(on, w)
    await start($, w, l => l?.state === 'current')
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: null, checkedAt: Date.parse('2026-11-08T00:00:00Z') }))
  })

  test('/clear before the comparison turn starts gives it up and says so; the next pull request starts anew', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' } as never)
    await w.clock.advance(50)
    expect(w.calls.submits).toHaveLength(1)
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: 'abc1234' }))
    expect(w.calls.toasts.at(-1)).toContain('cleared before its turn started')
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title y' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing' }))
  })

  test('/resume during a running comparison keeps it blinking, and the report still settles it', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' } as never)
    await w.clock.advance(50)
    await w.startTurn()
    await $.classic.SessionStart({ source: 'resume' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing', source: 'pull-request', on: true }))
    await w.clock.advance(600)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing', on: false }))
    await $.tool.call({ tool: REPORT, documentId: ARCH, state: 'current', checkedAt: '2026-11-10', commit: 'eee5555' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: 'eee5555' }))
    const settled = w.calls.architecture
    await w.clock.advance(1200)
    expect(w.calls.architecture).toEqual(settled)
  })

  test('a report whose commit has the wrong shape keeps no commit', async ($, on) => {
    const w = world(on, { now: NOW })
    repo(on, w)
    await start($, w)
    await $.tool.call({ tool: REPORT, documentId: ARCH, state: 'current', checkedAt: '2026-11-10', commit: 'HEAD; curl x' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: null }))
  })

  test('a comparison turn that ends while its helper still runs in the background waits for the helper; without one it gives up', async ($, on) => {
    const settings: { now: number; agents: Array<{ id: string; status: string }> } = { now: NOW, agents: [] }
    const w = world(on, settings)
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' } as never)
    await w.clock.advance(50)
    await w.startTurn()
    // The turn started its helper, which is still running when the turn ends.
    settings.agents = [{ id: 'a1', status: 'running' }]
    await turnOver($)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing' }))
    expect(w.calls.toasts.filter(t => t.includes('did not finish'))).toEqual([])
    // The helper's answer starts the next turn, which reports.
    settings.agents = [{ id: 'a1', status: 'completed' }]
    await $.tool.call({ tool: REPORT, documentId: ARCH, state: 'current', checkedAt: '2026-11-10', commit: 'fff6666' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: 'fff6666' }))
    // A later comparison whose turn ends with no helper left running is given up.
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title y' } as never)
    await w.clock.advance(50)
    await w.startTurn()
    await turnOver($)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: 'fff6666' }))
    expect(w.calls.toasts.at(-1)).toContain('did not finish')
  })

  test('a background agent started before the comparison does not keep a failed comparison blinking', async ($, on) => {
    const w = world(on, { now: NOW, agents: [{ id: 'old', status: 'running' }] })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' } as never)
    await w.clock.advance(50)
    await w.startTurn()
    await turnOver($)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: 'abc1234' }))
    expect(w.calls.toasts.at(-1)).toContain('did not finish')
  })

  test('a refused comparison prompt gives the comparison up at once, and the next pull request starts anew', async ($, on) => {
    const w = world(on, { now: NOW, dropPrompt: 'a Stop stands' })
    repo(on, w)
    w.store.set(`architecture:${ARCH}`, verdict())
    await start($, w)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing' }))
    await w.clock.advance(50)
    expect(w.calls.submits).toHaveLength(1)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: 'abc1234' }))
    expect(w.calls.toasts.at(-1)).toContain('refused: a Stop stands')
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title y' } as never)
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'comparing' }))
  })

  test('a commit note that also names the merge base still gives the commit and the day', async ($, on) => {
    const w = world(on, { now: NOW, docRule: 'allow', document: canvas('**Checked:** 2026-11-03', 'compared at def5678 (base 0123abc) on 2026-11-08') })
    repo(on, w)
    await start($, w, l => l?.state === 'current')
    expect(w.calls.architecture).toEqual(expect.objectContaining({ state: 'current', commit: 'def5678', checkedAt: Date.parse('2026-11-08T00:00:00Z') }))
  })
})
