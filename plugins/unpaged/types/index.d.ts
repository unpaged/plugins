// The mod's state contract: what the band draws from, held by the host for
// the session (it survives a hot reload; /clear resets it, and the module
// rebuilds it from its own records).

/** One canvas this session listens to. */
export type ArmedCanvas = {
  documentId: string
  /** The key's identifier (never the key). */
  keyId: string | null
  title: string
  boardUrl: string
  armedAt: number
  state: 'connecting' | 'connected' | 'reconnecting' | 'stopped'
  /** Why it stopped: `http-401`, `http-409`, `shutdown`, or a failure to start. */
  reason: string | null
  unread: number
  lastEventAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    unpaged: {
      armed: ArmedCanvas[]
      /** The canvases whose comments the running reply turn covers; empty when none. */
      replying: string[]
      /** Every canvas this session has armed, by hand or on its own: a canvas is armed on its own only once. */
      armedOnce: string[]
      /** Event ids already answered with "On it…", oldest first, at most 200: a replayed poll does not answer them again. */
      acked: string[]
    }
  }
}
