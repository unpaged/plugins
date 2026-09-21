# Retained runtime fixture

`codex-0.3.2.tar.gz` contains the ten retained runtime/skill files from public
commit `f192e16397a179ad85b29384d138e9e19e28f1bc` in unpaged/plugins (Codex 0.3.2).
SHA-256: `674d08bc267dd60066860bfae29a351d8d924a27f740fa2206e4c1264fa04f73`.

Upgrade tests execute these unchanged historical helpers against the additive
polling ledger. The fixture contains tracked plugin source only, no state or
credentials. Tests extract it only into a disposable temporary directory.
