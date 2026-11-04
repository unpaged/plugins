// The mod's state contract: what the lines above the prompt draw from, held
// by the host for the session (it survives a hot reload; /clear resets it,
// and the module rebuilds it from its own records).

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

/** The architecture line: the repository's architecture canvas and whether it still describes the code. */
export type ArchitectureLight = {
  /** The canvas the repository's pointer file names; null while there is none. */
  documentId: string | null
  title: string | null
  boardUrl: string | null
  /**
   * `none`: a git repository with no pointer file (the grey invitation);
   * `unknown`: a pointer, but no verdict known on this machine; `current`:
   * up to date; `behind`: some claims no longer hold; `comparing`: a
   * comparison under way; `lost`: the canvas is deleted or unreachable.
   */
  state: 'none' | 'unknown' | 'current' | 'behind' | 'comparing' | 'lost'
  /** The day of the last comparison, ms since the epoch, or null. */
  checkedAt: number | null
  /** The commit the canvas was last compared at, or null. */
  commit: string | null
  /** The day the canvas fell behind, ms since the epoch, or null. */
  behindSince: number | null
  /** What started the comparison under way. */
  source: 'pull-request' | 'update' | null
  /** The blink phase while comparing: the dot is drawn full when true. */
  on: boolean
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
      /** The architecture line; null while the working folder is no git repository. */
      architecture: ArchitectureLight | null
    }
  }
}
