---
description: Check or repair the UnPaged push listener — @agent comments are pushed to this session; normally armed by /unpaged:visual-plan
argument-hint: [status | revoke]
---

Push is armed automatically the first time `/unpaged:visual-plan` hands back a board; this command only reports or repairs it.

- **No argument or `status`:** validate the stored key **without printing it** — this prints only `armed <keyId>` or `missing`:
  `node -e 'const f=process.env.HOME+"/.claude/unpaged/listener.json";try{const c=JSON.parse(require("fs").readFileSync(f,"utf8"));const ok=typeof c.url==="string"&&/^wss?:\/\//.test(c.url)&&Array.isArray(c.protocols)&&c.protocols.length>=2&&c.protocols.every(p=>typeof p==="string"&&p.length>0)&&c.protocols.includes("unpaged-listener.v1");if(!ok)process.exit(2);console.log("armed "+(c.keyId||""))}catch{process.exit(2)}' 2>/dev/null || echo missing`
  (never `cat` that file — it is a credential; a malformed file counts as `missing`, `rm -f` it). If `armed <keyId>`, confirm that exact key is still live on the server: call `agent_listener_keys_list` and look for that `keyId` (labels can repeat on one host — match the id). Live ⇒ say push is armed and the plugin's background monitor connects at every session start. Not live (revoked elsewhere, or rejected with 4401) ⇒ `rm -f ~/.claude/unpaged/listener.json` and treat it as `missing`. If `missing`, arm it now: follow the "Arm the listener" steps of `/unpaged:visual-plan` (call `agent_listener_key_create` with label `claude-code on <hostname>`, store `{"url","protocols","keyId"}` atomically in `~/.claude/unpaged/listener.json` with mode 600, arm `Monitor({ ws: { url, protocols }, persistent: true, description: "UnPaged @agent comments" })` for this session). Never repeat the key in your reply.
- **`revoke`:** call `agent_listener_keys_list`, revoke every key whose label matches this host with `agent_listener_key_revoke`, delete `~/.claude/unpaged/listener.json`, and say push is off until the next `/unpaged:visual-plan`.

If the `agent_listener_key_create` tool is missing, the connected server predates push — say so and stop.
