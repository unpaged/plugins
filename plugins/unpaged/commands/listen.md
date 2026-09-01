---
description: Check or repair the UnPaged push listener — @agent comments are pushed to this session; normally armed by /unpaged:visual-plan
argument-hint: [status | revoke]
---

Push is armed automatically the first time `/unpaged:visual-plan` hands back a board; this command only reports or repairs it.

- **No argument or `status`:** run `cat ~/.claude/unpaged/listener.json 2>/dev/null`. If it exists and parses, say push is armed and the plugin's background monitor connects at every session start. If it is missing, arm it now: follow the "Arm the listener" steps of `/unpaged:visual-plan` (call `agent_listener_key_create` with label `claude-code on <hostname>`, store `{"url","protocols"}` in `~/.claude/unpaged/listener.json` with mode 600, arm `Monitor({ ws: { url, protocols }, persistent: true, description: "UnPaged @agent comments" })` for this session). Never print the key.
- **`revoke`:** call `agent_listener_keys_list`, revoke every key whose label matches this host with `agent_listener_key_revoke`, delete `~/.claude/unpaged/listener.json`, and say push is off until the next `/unpaged:visual-plan`.

If the `agent_listener_key_create` tool is missing, the connected server predates push — say so and stop.
