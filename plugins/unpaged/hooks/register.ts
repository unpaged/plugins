// The Unpaged listener mod: a session listens to a canvas's @agent comments
// from inside Claude Code. Arming mints the listener key, the poll loop runs
// in this module on the host's fetch, each new comment shows as a toast and
// starts one reply turn through a submitted prompt. No model step is needed
// to listen, and the key never enters the model's context: it is read from
// the key file, sent in a request header, and never logged or shown.
//
// The loop itself is monitors/listen-loop.mjs, shared with the Monitor
// script that older clients keep using; this file is its host.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { ArmedCanvas } from '../types'
import {
  KEY_DIR_RELATIVE,
  PROTOCOL_PREAMBLE,
  STATUS_DIR_RELATIVE,
  extractMint,
  isDocumentId,
  keyFileFor,
  listenerConfigFromMint,
  parseListenerConfig,
} from '../monitors/listen-core.mjs'
import { runListener } from '../monitors/listen-loop.mjs'
import { MAX_POLL_BYTES, failure, isTerminalStatus, parseEnvelope, pollRequest } from '../monitors/poll-core.mjs'

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
  controller: AbortController
  done: Promise<unknown>
  pending: string[]
  flush: { cancel: () => void } | null
  settled: Promise<string>
}

const MCP_SERVER = 'unpaged'
const FIRST_POLL_WAIT_MS = 8000
const FLUSH_DELAY_MS = 50
/** session.end reasons that end listening; `clear` and `resume` keep it. */
const ENDING_REASONS = new Set(['logout', 'prompt_input_exit', 'other'])

const armed = atom({ plugin: 'unpaged', key: 'armed' } as const, [] as ArmedCanvas[])
const replying = atom({ plugin: 'unpaged', key: 'replying' } as const, false)

// Module records: the truth for what this module runs. The atoms are the
// band's view of them, rewritten on every change; after a hot reload the
// atoms are what is left, and the loops are started again from them.
const canvases = new Map<string, ArmedCanvas>()
const loops = new Map<string, Loop>()
/** Arms in flight, so two calls for one canvas mint one key, not two. */
const arming = new Map<string, Promise<ArmResult>>()

type ArmResult = { already: boolean; canvas: ArmedCanvas | undefined; first?: string }

const boardUrlFor = (documentId: string) => `https://unpaged.io/document/${documentId}/edit`
const text = (value: unknown) => (typeof value === 'string' ? value : '')

async function paths($: Api) {
  const home = (await $.env.get('HOME')) ?? ''
  return {
    keyDir: `${home}/${KEY_DIR_RELATIVE}`,
    statusDir: `${home}/${STATUS_DIR_RELATIVE}`,
    keys: `${$.plugin.root}/monitors/keys.mjs`,
  }
}

async function keysVerb($: Api, verb: string, args: string[], stdin?: string) {
  const { keys } = await paths($)
  const ran = await $.process.run(['node', keys, verb, ...args], stdin === undefined ? undefined : { stdin })
  return { exitCode: ran.exitCode, lines: ran.stdout.split('\n').map(l => l.trim()).filter(Boolean) }
}

async function loadConfig($: Api, documentId: string): Promise<ListenerConfig | null> {
  const { keyDir } = await paths($)
  const file = keyFileFor(keyDir, documentId)
  if (!file || !(await $.fs.exists(file))) return null
  const config = parseListenerConfig(await $.fs.read(file)) as ListenerConfig | null
  return config && config.documentId === documentId ? config : null
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

function mcpText(result: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown }) {
  const block = result.content?.find(b => b.type === 'text' && typeof b.text === 'string')
  return block?.text ?? (result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent))
}

/** Mints a fresh key for the canvas and stores it through the key helper (tmp + rename, mode 600). */
async function mint($: Api, documentId: string): Promise<ListenerConfig> {
  const server = await mcpServer($)
  const host = (await keysVerb($, 'check', [documentId])).lines.find(l => l.startsWith('host '))?.slice(5) ?? 'this machine'
  const result = (await $.mcp.call(server, 'agent_listener_key_create', {
    documentId,
    label: `claude-code on ${host}`,
  })) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean; structuredContent?: unknown }
  const body = mcpText(result)
  if (result.isError) throw new Error(`the server refused to mint a listener key: ${body.slice(0, 200)}`)
  const found = extractMint(result.structuredContent ?? body)
  if (!found) throw new Error('the mint result carried no listener key')
  const stored = await keysVerb($, 'store', [documentId], JSON.stringify(found))
  if (!stored.lines.some(l => l.startsWith('stored '))) throw new Error('the key helper could not store the key')
  const config = listenerConfigFromMint(found, { cwd: await $.session.cwd(), createdAt: new Date().toISOString() }) as ListenerConfig | null
  if (!config) throw new Error('the stored key does not parse as a listener config')
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
  ): Promise<{ events: Array<Record<string, unknown>>; nextCursor: string | null } | { terminal: number }> => {
    const { url, headers } = pollRequest(binding, settings.cursor)
    let rejectLate: (error: Error) => void = () => {}
    const timedOut = new Promise<never>((_resolve, reject) => {
      rejectLate = reject
    })
    const deadline = $.clock.after(settings.timeoutMs, () => rejectLate(failure('poll_timeout')))
    try {
      const response = await Promise.race([$.http.fetch(url, { headers }), timedOut])
      if (settings.signal?.aborted) throw failure('poll_aborted')
      if (isTerminalStatus(response.status)) return { terminal: response.status }
      if (response.status !== 200) throw failure('poll_http_error')
      if (response.text.length > MAX_POLL_BYTES) throw failure('poll_body_limit')
      return parseEnvelope(response.text, binding.documentId)
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
      } else {
        $.ui.toast(line.slice(0, 160), { timeoutMs: 8000 })
      }
    }
    loop.pending.push(line)
    loop.flush?.cancel()
    loop.flush = $.clock.after(FLUSH_DELAY_MS, () => {
      const lines = loop.pending.splice(0)
      loop.flush = null
      if (lines.length === 0) return
      void update($, replying, () => true)
      void $.prompt.submit({ text: lines.join('\n') })
    })
  }
}

async function writeStatus($: Api, documentId: string, state: string, reason: string | null, lastSuccessfulPollAt: string | null) {
  try {
    const { statusDir } = await paths($)
    await $.fs.write(
      `${statusDir}/${documentId}.json`,
      JSON.stringify({
        pid: 0,
        state,
        reason,
        script: null,
        documentId,
        updatedAt: new Date().toISOString(),
        transport: 'mod-v1',
        sessionId: await $.session.id(),
        lastSuccessfulPollAt,
      }),
    )
  } catch {
    // Advisory state: a missed write costs one "unverified" status line, nothing more.
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
  const loop: Loop = { controller, done: Promise.resolve(), pending: [], flush: null, settled }
  loops.set(documentId, loop)
  const reportStatus = async (state: string, reason: string | null | undefined, metadata: { lastSuccessfulPollAt?: string | null }) => {
    const known = state === 'connecting' || state === 'connected' || state === 'reconnecting' || state === 'stopped' ? state : 'reconnecting'
    record(documentId, { state: known, reason: reason ?? null })
    await sync($)
    await writeStatus($, documentId, state, reason ?? null, metadata?.lastSuccessfulPollAt ?? null)
    if (state !== 'connecting') settle(state)
  }
  loop.done = runListener(config, {
    poll: pollWith($),
    sleep: sleepWith($),
    say: sayWith($, documentId),
    now: () => Date.now(),
    reportStatus,
    retireKey: async () => (await keysVerb($, 'retire', [documentId, config.keyId ?? ''])).lines[0] ?? 'absent',
    signal: controller.signal,
  })
    .catch(() => ({ reason: 'failed' }))
    .then(async (result: { reason?: string }) => {
      if (loops.get(documentId) === loop) loops.delete(documentId)
      record(documentId, { state: 'stopped', reason: result?.reason ?? 'stopped' })
      await sync($)
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
  const previous = await loadConfig($, documentId)
  const config = await mint($, documentId)
  if (previous?.keyId && previous.keyId !== config.keyId) void revoke($, previous.keyId)
  const name = title || config.title || previous?.title || documentId
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
  return { already: false, canvas: canvases.get(documentId), first }
}

async function stop($: Api, documentId: string) {
  const loop = loops.get(documentId)
  const canvas = canvases.get(documentId)
  if (loop) {
    loop.controller.abort()
    await loop.done
  }
  const keyId = canvas?.keyId ?? (await loadConfig($, documentId))?.keyId ?? null
  const revoked = await revoke($, keyId)
  if (revoked) await keysVerb($, 'forget', [documentId])
  canvases.delete(documentId)
  await sync($)
  return { title: canvas?.title ?? documentId, revoked, keyId }
}

function describe(canvas: ArmedCanvas | undefined, first?: string) {
  if (!canvas) return 'nothing armed'
  const state = first === 'pending' ? 'armed, first poll pending' : canvas.state
  const unread = canvas.unread ? `, ${canvas.unread} new` : ''
  return `${canvas.title} (${canvas.documentId}): ${state}${canvas.reason ? ` (${canvas.reason})` : ''}${unread}`
}

async function statusText($: Api) {
  const lines = [...canvases.values()].map(c => describe(c))
  const files = await keysVerb($, 'list', [])
  return [
    lines.length ? `Listening in this session:\n${lines.join('\n')}` : 'Nothing is armed in this session.',
    `Stored keys on this machine:\n${files.lines.join('\n') || 'none'}`,
  ].join('\n\n')
}

async function restoreAfterReload($: Api) {
  const kept = await read($, armed)
  for (const canvas of kept) {
    if (canvas.state === 'stopped' || loops.has(canvas.documentId)) continue
    const config = await loadConfig($, canvas.documentId)
    if (!config) continue
    canvases.set(canvas.documentId, { ...canvas, state: 'connecting', reason: null })
    await startLoop($, { ...config, title: canvas.title })
  }
  await sync($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.tool.register({
        name: 'listen_arm',
        description:
          'Listen to an Unpaged canvas for @agent comments in this session: mints the listener key, stores it, and polls from inside Claude Code. New comments arrive as a message from the unpaged plugin. Pass the documentId (and the title for the band).',
        inputSchema: {
          type: 'object',
          properties: { documentId: { type: 'string' }, title: { type: 'string' } },
          required: ['documentId'],
        },
      })
      await $.tool.register({
        name: 'listen_stop',
        description: 'Stop listening to an Unpaged canvas in this session and revoke its listener key.',
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
    void restoreAfterReload($)
    return started
  })

  // /clear and /resume reset the atoms but not this module: rebuild the view.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await sync($)
    return next(e)
  })

  on('command.run', { command: 'unpaged-listen' }, async ($, e) => {
    const [verb = 'status', target = ''] = e.args.trim().split(/\s+/)
    try {
      if (verb === 'status') return { text: await statusText($) }
      if (verb === 'arm') {
        const result = await arm($, target, null)
        return { text: result.already ? `Already listening: ${describe(result.canvas)}` : `Listening on ${describe(result.canvas, result.first)}` }
      }
      if (verb === 'stop') {
        const targets = target === 'all' ? [...canvases.keys()] : [target]
        const lines: string[] = []
        for (const id of targets) {
          const result = await stop($, id)
          lines.push(`${result.title}: stopped${result.revoked ? ', key revoked' : result.keyId ? ', key NOT revoked (revoke it with /unpaged:listen revoke)' : ''}`)
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
    try {
      const result = await arm($, text(input.documentId), text(input.title) || null)
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
      const result = await stop($, text(input.documentId))
      return { result: `${result.title}: stopped${result.revoked ? ', key revoked' : ', key not revoked (the server refused or was unreachable)'}` }
    } catch (err) {
      return { result: `listen_stop failed: ${String((err as Error).message ?? err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__unpaged__listen_status' }, async $ => ({ result: await statusText($) }))

  // The mod answers for its own tools: no permission prompt and no classifier.
  for (const tool of ['mcp__unpaged__listen_arm', 'mcp__unpaged__listen_stop', 'mcp__unpaged__listen_status']) {
    on('tool.check', { tool }, async () => ({ decision: 'allow' }))
  }

  on('turn.complete', async ($, e, next) => {
    if (await read($, replying)) await update($, replying, () => false)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (ENDING_REASONS.has(e.reason)) {
      for (const loop of loops.values()) loop.controller.abort()
    }
    return next(e)
  })
}
