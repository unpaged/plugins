---
description: Check or repair the UnPaged push listener — @agent comments are pushed to this session; normally armed by /unpaged:visual-plan
argument-hint: [status | revoke]
---

Push is armed automatically the first time `/unpaged:visual-plan` hands back a board; this command only reports or repairs it.

- **No argument or `status`:** check the stored key **without printing it**: `test -s ~/.claude/unpaged/listener.json && echo armed || echo missing` (never `cat` that file — it is a credential). If `armed`, confirm it is still live on the server: call `agent_listener_keys_list` and look for a key labelled `claude-code on <hostname>` (`hostname -s`). Live ⇒ say push is armed and the plugin's background monitor connects at every session start. Not live (revoked elsewhere, or rejected with 4401) ⇒ `rm -f ~/.claude/unpaged/listener.json` and treat it as `missing`. If `missing`, arm it now: follow the "Arm the listener" steps of `/unpaged:visual-plan` (call `agent_listener_key_create` with label `claude-code on <hostname>`, store `{"url","protocols"}` in `~/.claude/unpaged/listener.json` with mode 600, arm `Monitor({ ws: { url, protocols }, persistent: true, description: "UnPaged @agent comments" })` for this session). Never repeat the key in your reply.
- **`revoke`:** call `agent_listener_keys_list`, revoke every key whose label matches this host with `agent_listener_key_revoke`, delete `~/.claude/unpaged/listener.json`, and say push is off until the next `/unpaged:visual-plan`.

If the `agent_listener_key_create` tool is missing, the connected server predates push — say so and stop.
