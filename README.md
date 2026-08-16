# Codex Obsidian Memory

`obsidian-memory` is a Codex plugin and skill for maintaining a scoped,
auditable Markdown knowledge vault that complements rather than mirrors Codex
built-in memory.

The repository contains the plugin, its skill, hook definitions, deterministic
search and validation code, and self-tests. It intentionally contains no real
Vault notes, user conversations, credentials, API keys, certificates, private
keys, caches, backups, or generated indexes.

## Trust model

- Current user instructions and current source, configuration, runtime, logs,
  and tests outrank stored memory.
- Project notes are returned only when `cwd` or an explicitly named project
  matches `applies_to`; uncertain project scope fails closed.
- Cross-project notes require explicit applicability, boundaries, and a
  transferability argument plus at least one provenance-bearing
  `origin_projects` entry.
- Automatic capture creates `candidate` notes only. A candidate is an
  unverified lead, not an authorization or a verified fact.
- New notes are checked against Codex built-in memory and the Vault to avoid
  duplicate or conflicting permanent records.
- Deprecated and archived records are excluded from normal retrieval.
- Every model-visible CLI and Hook retrieval carries the same data-only and
  action-deny boundary. Secret-like material is rejected on capture and
  validation and redacted from both plain-text and JSON retrieval results.

See [REVIEW.md](REVIEW.md) for the current audit scope and known gaps.

## Repository layout

```text
.codex-plugin/plugin.json             Codex plugin manifest
hooks/hooks.json                      Hook declarations
skills/obsidian-memory/SKILL.md       Skill workflow and governance
skills/obsidian-memory/agents/        Skill interface metadata
skills/obsidian-memory/scripts/       Search, validation, hooks, CLI, self-tests
```

## Requirements

- Node.js 18 or newer; CI uses Node.js 22.
- A Codex installation that supports plugins and skills.
- A Markdown Vault. The local default is `F:\Obsidian`, overridable with
  `CODEX_OBSIDIAN_MEMORY_VAULT`.
- Readable Codex built-in memory files under `%USERPROFILE%\.codex\memories`,
  overridable with `CODEX_BUILTIN_MEMORY_ROOT`.

## Run the tests

No npm dependencies are required.

```powershell
npm test
```

Equivalent direct commands:

```powershell
node skills/obsidian-memory/scripts/memory-cli.cjs self-test
node skills/obsidian-memory/scripts/memory-cli-selftest.cjs
node skills/obsidian-memory/scripts/memory-hook-selftest.cjs
```

To validate a real Vault without modifying it:

```powershell
node skills/obsidian-memory/scripts/memory-cli.cjs validate --vault "F:\Obsidian"
```

The self-tests use temporary synthetic Vaults and remove them after completion.

## Installation status

This first public repository is published primarily for transparent review.
The local personal-marketplace installation remains the production path while
public installation and release packaging are reviewed separately.

## Privacy boundary

Do not attach or commit an entire Vault for bug reports. Provide the smallest
synthetic fixture that reproduces the problem. In particular, exclude
`.obsidian/` because third-party plugin settings can contain API keys,
certificates, or private keys.

## License

No open-source license has been selected. Public visibility permits inspection
and review but does not grant reuse, modification, or redistribution rights.
