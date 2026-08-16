# Review guide

This repository is public so GitHub reviewers and Codex agents can inspect the
actual plugin implementation instead of relying on screenshots or summaries.

## Highest-value review areas

1. Candidate trust boundary
   - Candidates participate in relevance ranking but carry a negative status
     weight and an explicit unverified label.
   - CLI and Hook consumption paths now share a data-only/action-deny boundary,
     plain and JSON results are redacted, and synthetic adversarial candidates
     are covered by CLI and Hook regression tests. Review host-level behavior
     separately because an offline formatter test cannot prove Agent obedience.
2. Scope isolation
   - Inspect `scopeAllowsContext`, project path normalization, explicit project
     matching, cross-project thresholds, and archive handling.
3. Built-in memory reconciliation
   - Inspect whole-baseline fingerprinting, per-note relation checks, conflict
     reporting, stale-note retrieval exclusion, and conservative relation
     review. Reconciliation must never invent `extends` or `corrects`.
4. Lifecycle
   - Inspect deterministic `valid_until`, advisory `review_after`, `revoked`
     archive movement, confirmation gates, reference refusal, managed-backup
     purge, hash-only audit, and postconditions for privacy hard-delete.
5. Provenance
   - Inspect required `source_kind` and `capture_method`, conservative legacy
     migration, and dynamically computed `effective_trust`. Legacy provenance
     must never be upgraded by filename or free-text inference.
6. Secret handling
   - Inspect pattern coverage, false positives, and structured-value redaction
     before adding provider-specific patterns.
7. Schema enforcement
   - Cross-project capture and validation now require non-empty
     `origin_projects`; review migrations before adding future required fields.
8. Host behavior
   - Hook scripts and self-tests are present, but a previously tested Windows
     Codex Desktop build did not dispatch `UserPromptSubmit`. The explicit skill
     workflow remains the observed production fallback.
9. Backup and recovery
   - Inspect path containment, symlink refusal, secret-bearing configuration
     exclusion, per-file manifest verification, isolated restoration, derived
     index reconstruction, and benchmark execution. The backup is local and
     not encrypted by the plugin.

## Known non-goals

- Obsidian is not the sole source of truth.
- The plugin does not store complete chats.
- The plugin does not use embeddings or a vector database.
- A passing offline test does not prove host hook dispatch or live behavior.

## Suggested commands

```powershell
npm test
node skills/obsidian-memory/scripts/memory-cli.cjs status
node skills/obsidian-memory/scripts/memory-cli.cjs validate
node skills/obsidian-memory/scripts/memory-cli.cjs reconcile-native
node skills/obsidian-memory/scripts/memory-governance-selftest.cjs
```

Please report findings with the exact file, line, violated invariant, and a
minimal synthetic reproduction. Never include real Vault content or secrets.
