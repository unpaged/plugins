# Create the architecture document (Antigravity reference)

Follow these steps in order when running the `architecture` skill with no argument (or `create`). Resolve `<plugin-root>` as two levels up from `SKILL.md`.

1. **One canvas per repository.** Check `<top level>/.unpaged/architecture.json`. If it exists, parse it safely and call `document_get({ documentId })` on the `unpaged` MCP server:
   - **Reachable → first save what the canvas already says** via `node "<plugin-root>/monitors/architecture.mjs" report "<top level>"` (JSON on stdin via quoted heredoc) using the root date note: `state` is `"current"` if the root date note starts with `**Checked:**` and `"behind"` if it starts with `**Behind since:**`; `checkedAt` is the `YYYY-MM-DD` day at the end of the commit note (`on YYYY-MM-DD`), or the `**Checked:**` day when the commit note has none; `commit` is the commit note's first word if it is 7 to 40 lowercase hex characters (else `null`); `behindSince` is the `**Behind since:**` day when behind (else `null`); skip reporting if the root has no date note yet.
   - Then say the repository already has an architecture document, give its link (`https://unpaged.io/document/<documentId>/edit`), offer `/unpaged:architecture update` (and `[Unpaged Architecture](sidecar://unpaged/architecture/)`), and **stop** — do NOT overwrite the pointer or draw a new canvas unless the user explicitly asks to.
   - When that existing canvas is organised by folder (its cards describe folders and what they hold, the shape drawn before `1.14.0`), say so and offer, beside `update`, to draw a new canvas organised by the reader's questions instead: that writes the new canvas's id to `.unpaged/architecture.json` and leaves the old canvas intact in the library except for one open comment pinned to its date note (`comment_create`): `Redrawn by questions <today>: https://unpaged.io/document/<newDocumentId>/edit. Once the pointer file naming it is merged, this canvas is no longer compared with the code.` (never resolve it yourself). Warn that the new canvas lands in this account's library, so it must be shared with everyone who opens the old one before committing the new pointer, or teammates' status will show unreachable.
   - **Not reachable (not found, no access, permission) → keep the pointer file unchanged:** server wording does not distinguish a deleted canvas from a teammate's canvas under another account. Report `"lost"` via `architecture.mjs report`, tell the user this account cannot open the canvas named by `.unpaged/architecture.json` (it may be deleted or belong to a teammate), suggest asking its owner for access or signing in with the right Unpaged account, and draw a new canvas / overwrite the pointer **only when the user confirms explicitly**.

2. **Read the code before you draw, as a new engineer's questions ask.** Start from how the system is started and reached — manifests, build and deploy configuration, processes that run, and entry points (routes, commands, handlers, jobs, exported APIs) — and follow the code from there. The folder tree (two or three levels, skipping dependencies and build output) is a map you read, never the picture you draw. Find in the code:
   - **What the product does**, from what its entry points let a person or caller do.
   - **What runs where** (each process or deployable, each store, external services, devices or clients) and **what talks to what** (cross-part imports, network calls, queues, tables, files).
   - **The main flows**, the paths the code exists for (central write and read paths, sign-in, external entry paths, background jobs), each followed from its entry point through every part it crosses to the writes it ends in.
   - **The model**, the core concepts and how they relate, with where each lives.
   - **Who may see and change what**, and the code that enforces it (access rules, guards, checks).
   - **The decisions the code embodies** — constraints, rules, chosen mechanisms — with the why where the code or repository records it (a comment, check message, decision record, or commit message), quoted in at most one sentence and ONLY from a commit message or from a tracked file that the `skip` list you write will NOT cover (never from a `.gitignore`d file such as `.env` or outside the repository, because later comparisons never read skipped or untracked files), and marked as inferred where not recorded.
   - **The constraints that shape the code**: boundaries and budgets enforced by lint or build checks, never by a test alone (comparisons skip tests, so a card resting on a test would go stale unseen).
   Read enough to make every card a claim you directly observed in the code; mark unclear areas honestly rather than guessing. Documents in the repository are never taken on faith — the code decides.

3. **Decide the structure from what this code is**, organised by the reader's questions:
   - **Root canvas (`Overview`):** the system at a glance — what the product does in one line; the parts that run as boxes (`rectangle`s with both `fillColor` and `strokeColor`) labelled with what each is for and joined by `connector`s showing what talks to what; and up to nine clickable boxes (`isLink: true`, `linkTarget`) opening child canvases (`node_create_with_elements`) that answer one question each.
   - **Child canvases:** a **flow** canvas shows numbered steps across the parts the flow crosses in order, each step a testable claim; a **model** canvas shows core concepts and relations; an **access** canvas shows roles/capabilities and the enforcing code; a **decisions** canvas shows one note per decision (decision, enforcing constraint, recorded or inferred why); a **start here** canvas names the entry points of each flow (where file names belong). Pick only the questions this code raises; never force an empty template.
   - Keep folder/file names to at most a short plain-text line under a card that already explains what the part does; no card or table lists what a folder holds. Keep every claim testable (`"the API talks to the database only through the data-access library"` is testable; `"well-structured"` is not).

4. **Create the canvas** with `document_create({ title: "<repository name>", folder: "Architecture" })` (`folder` creates the *Architecture* folder on demand; if an older server rejects `folder`, retry without it and mention that folders need a current server; if `folderWarning` is returned, mention it and carry on).

5. **Draw** with `batch_create_elements` on `rootNodeId` and `node_create_with_elements` for each nested canvas (set `backgroundColor: "#ffffff"` or Warm Paper light `#f6efe3` consistently; give every `rectangle` and basic shape both `fillColor` and `strokeColor`; `text` `fillColor` is text colour; use `connector` with `startAnchor`/`endAnchor`, never `line` arrows):
   - Top-left title `text` (Markdown heading, `fontSize: 28`).
   - Top-right date note (`x ≈ canvasWidth - 440, y: 60`):
     - `**Checked:** YYYY-MM-DD` (`fontSize: 20`, `fillColor: "#0f172a"`)
     - Beneath it: `compared at <short HEAD> (base <short merge base>) on YYYY-MM-DD` (`fontSize: 12`, `fillColor: "#64748b"`).
   - Space elements generously inside the canvas (enlarge first via `node_update` if needed; split dense questions into child canvases rather than oversized canvases), one idea per card, at most nine linked boxes per canvas, step numbers as small outlined squares (never filled corner circles, which look like link badges), and no code beyond a path or identifier.

6. **Verify as a new engineer, then look visually:** verify each canvas answers its question in order without reading like a folder index, then call `node_picture` on the root and every nested canvas and fix any overlap or clipped text via MCP tools (checking at most twice per canvas; skip and say so if `node_picture` is unavailable).

7. **Write `.unpaged/architecture.json`** at `<top level>` with `documentId`, `title`, and a repo-tailored `skip` list (keeping out of `skip` any folder holding a record quoted by a card). Note in your reply that the pointer file should be committed with the code and the canvas shared with teammates who need to open it. (If replacing a folder-drawn canvas from step 1, post the `Redrawn by questions` comment on the old canvas's date note now.)

8. **Report locally** via quoted stdin heredoc:
   ```sh
   node "<plugin-root>/monitors/architecture.mjs" report "<top level>" <<'EOF'
   {"documentId":"<documentId>","state":"current","title":"<title>","checkedAt":"<YYYY-MM-DD>","commit":"<short HEAD>","behindSince":null}
   EOF
   ```

9. **Reply** with `https://unpaged.io/document/<documentId>/edit` (call it a canvas, never a board), one line naming the questions answered, `.unpaged/architecture.json`, truthful `@agent` listener status (`keys.mjs check <documentId>` — offer listening via `listen` if unarmed), and `[Unpaged Architecture](sidecar://unpaged/architecture/)`.
