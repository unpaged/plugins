// The Unpaged MCP server as the mod reaches it, and the person's permission
// rules on a call the mod would make itself: shared by the listener
// (register.ts) and the architecture light (architecture.ts).
import type { Register } from 'claude-code'

export type On = Parameters<Register>[0]
export type Hook = Extract<Parameters<On>[number], (...args: never[]) => unknown>
export type Api = Parameters<Hook>[0]

export const MCP_SERVER = 'unpaged'

export const boardUrlFor = (documentId: string) => `https://unpaged.io/document/${documentId}/edit`
export const text = (value: unknown) => (typeof value === 'string' ? value : '')

export async function mcpServer($: Api) {
  try {
    const connected = (await $.mcp.connect(MCP_SERVER)) as { isConnected?: boolean; server?: string }
    if (connected.isConnected && connected.server) return connected.server
  } catch {
    // fall through to the manifest name
  }
  return MCP_SERVER
}

/** An MCP tool as the person's permission rules name it: `mcp__plugin_unpaged_unpaged__comment_reply` installed with this plugin. */
export const ruleName = (server: string, tool: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`

/**
 * Whether the person's own permission rules already let `tool` run: asked
 * without running it, so no dialog opens and no classifier is asked. The
 * mod's own calls of MCP tools go through those rules either way.
 */
export async function isAllowed($: Api, server: string, tool: string, input: Record<string, unknown>) {
  return (await ruleOn($, server, tool, input)) === 'allow'
}

/** The rules' answer for `tool`, asked the same way: `allow`, `deny`, or `ask` for anything else (no rule, or no answer). */
export async function ruleOn($: Api, server: string, tool: string, input: Record<string, unknown>): Promise<'allow' | 'deny' | 'ask'> {
  try {
    const decision = (await $.tool.check({ tool: ruleName(server, tool), input })).decision
    return decision === 'allow' || decision === 'deny' ? decision : 'ask'
  } catch {
    return 'ask'
  }
}

export function mcpText(result: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown }) {
  const block = result.content?.find(b => b.type === 'text' && typeof b.text === 'string')
  return block?.text ?? (result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent))
}
