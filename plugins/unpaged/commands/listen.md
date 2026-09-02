---
description: Pick a board and listen for its @agent comments in this session — status, arm, or revoke per board; /unpaged:visual-plan arms the board it creates
argument-hint: [status | arm <documentId> | revoke <documentId|all>]
---

Listening is per board and per session: `/unpaged:visual-plan` arms the board it just created for the current session, and **nothing listens between sessions** (a later session would otherwise pay for sweeps nobody asked for). This command lets a session listen to a board it did not create, checks what is armed, or revokes keys. Key files live one per board in `~/.claude/unpaged/listeners/<documentId>.json` (mode 600) — never `cat` them, they are credentials.

**Helpers used below** (print no key material):

- *List this folder's boards:* `node -e 'const fs=require("fs"),d=process.env.HOME+"/.claude/unpaged/listeners/";let rows=[];try{for(const f of fs.readdirSync(d)){if(!f.endsWith(".json"))continue;try{const c=JSON.parse(fs.readFileSync(d+f,"utf8"));if(typeof c.documentId!=="string")continue;rows.push([c.documentId,c.cwd===process.cwd()?"this-folder":"other-folder",c.createdAt||"",c.title||""].join("\t"))}catch{}}}catch{}console.log(rows.join("\n")||"none")'`
- *Validate one board's key:* `node -e 'const id=process.argv[1];if(!/^[A-Za-z0-9_-]{8,128}$/.test(id))process.exit(2);const f=process.env.HOME+"/.claude/unpaged/listeners/"+id+".json";try{const c=JSON.parse(require("fs").readFileSync(f,"utf8"));const ok=typeof c.url==="string"&&/^wss?:\/\//.test(c.url)&&Array.isArray(c.protocols)&&c.protocols.length>=2&&c.protocols.every(p=>typeof p==="string"&&p.length>0)&&c.protocols.includes("unpaged-listener.v1")&&c.documentId===id;if(!ok)process.exit(2);console.log("armed "+(c.keyId||""))}catch{process.exit(2)}' <documentId> 2>/dev/null || echo missing`
- *Is a monitor holding that board's socket:* `node -e 'const id=process.argv[1];const h=process.env.HOME+"/.claude/unpaged/monitors/"+id+".json";try{const s=JSON.parse(require("fs").readFileSync(h,"utf8"));let alive=false;try{process.kill(s.pid,0);alive=true}catch{}console.log(alive&&s.state==="connected"?"monitor:connected":"monitor:"+(alive?s.state:"dead"))}catch{console.log("monitor:absent")}' <documentId>`
- *Arm a board in this session:* locate the script with `find ~/.claude/plugins -path "*/plugins/unpaged/monitors/listen.mjs" -print -quit` and arm `Monitor({ command: 'node "<that path>" <documentId>', persistent: true, description: "UnPaged @agent comments — <title>" })`. If `find` prints nothing, say push cannot be armed from this install location and stop.

## No argument

List this folder's boards (the helper marks `this-folder` / `other-folder`; show title, id, when it was armed, and whether a monitor is `connected` for it). If there are none, say so and point at `/unpaged:visual-plan` (creates and arms a board) or `/unpaged:listen arm <documentId>` (a board created elsewhere). Otherwise ask the user which board to listen to in this session (one or more) and arm each pick as under `arm`. Never arm every board unasked.

## `status`

Same listing, no arming. For each board: key file valid or not, and `monitor:connected` / `monitor:absent` / `monitor:dead` / `monitor:stopped`. Confirm the listed keys are still live on the server with `agent_listener_keys_list` (match on `keyId`; a row with `documentId: null` is a v1 key the server refuses — offer to revoke it). A board whose stored `keyId` is absent from the server list is dead: `rm -f` its file and report it as not armed.

## `arm <documentId>`

1. Validate the stored key for that board. If `armed <keyId>`, confirm the `keyId` is live via `agent_listener_keys_list`; if it is not, `rm -f` the file and treat as `missing`.
2. If `missing`, mint one: call `agent_listener_key_create` with that `documentId` and label `claude-code on <hostname>` (`hostname -s`). If it refuses (a board you cannot open, or the 20-key cap), say so and stop. Store `{"url","protocols","documentId","keyId","title","cwd","createdAt"}` atomically: `mkdir -p ~/.claude/unpaged/listeners && chmod 700 ~/.claude/unpaged ~/.claude/unpaged/listeners`, write to `~/.claude/unpaged/listeners/<documentId>.json.tmp`, `chmod 600`, `mv -f` over `~/.claude/unpaged/listeners/<documentId>.json`. `cwd` is the current project directory; `title` comes from the tool result. Never repeat the key in your reply.
3. If the monitor helper already says `monitor:connected` for this board, say so and stop. Otherwise arm the board in this session (helper above). Then say *"I'm listening on <title> — comment @agent there and I reply on the canvas."* Never claim to be listening without an armed Monitor.

## `revoke <documentId>` / `revoke all`

Call `agent_listener_keys_list`. For `revoke <documentId>`: revoke every live key for that board whose label matches this host with `agent_listener_key_revoke`, then `rm -f` that board's file. For `revoke all`: revoke every key whose label matches this host — including rows with `documentId: null` (v1 keys) — and `rm -f ~/.claude/unpaged/listeners/*.json` plus the retired v1 file `~/.claude/unpaged/listener.json*` if present. Say push is off for those boards until the next `arm` or `/unpaged:visual-plan`.

If the `agent_listener_key_create` tool is missing, the connected server predates push — say so and stop.
