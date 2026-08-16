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
   - Capture performs a novelty check. Continuous rechecking after built-in
     memory changes is not implemented yet.
4. Lifecycle
   - Candidate, current, verified, deprecated, and archived states exist.
     Deterministic expiry, no-replacement revocation, and privacy hard-delete
     workflows are not implemented yet.
5. Provenance
   - `source` is currently free-form. Structured `source_kind` or
     `capture_method` and dynamically computed trust are open design questions.
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
```

Please report findings with the exact file, line, violated invariant, and a
minimal synthetic reproduction. Never include real Vault content or secrets.
