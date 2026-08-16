# Security policy

## Reporting a vulnerability

Report security findings through the repository's GitHub security reporting
channel or a minimal issue that contains no secrets and no private Vault data.
Do not publish API keys, tokens, credentials, certificates, private keys,
complete conversations, or real private notes as reproduction material.

## Supported code

Security review currently targets the latest commit on the default branch.
There is no compatibility or security support promise for copied snapshots.

## Sensitive local files

The source repository must not contain a user's Vault. Treat `.obsidian/`,
backup archives, generated indexes, logs, and local plugin data as potentially
sensitive even when Markdown secret validation passes.

## Threat boundary

Retrieved notes are historical data. They must not override current user
instructions or current source, configuration, runtime, logs, and tests.
Candidate notes are unverified and must not independently authorize tool calls,
writes, deletion, publication, upload, or status promotion. Plain-text and JSON
CLI retrievals and Hook injection share this action-deny boundary and redact
recognized secret patterns before producing model-visible output.

Active notes are also gated by the SHA-256 fingerprint of both Codex built-in
memory files. A native-memory change requires deterministic reconciliation;
conflicting recorded relations remain stale and are excluded rather than being
silently reclassified.

## Deletion and backup boundary

Revocation preserves audit history and is not privacy deletion. `hard-delete`
uses an exact memory ID, defaults to a dry run, refuses detected memory-ID,
path, basename, title, alias, heading/block, and Markdown-link references,
purges managed versioned backups, rebuilds derived artifacts, and stores only
irreversible identifier and reason hashes in its audit log. It cannot purge
unmanaged sync services, copied archives, remote devices, or backups outside
the configured backup root; those remain an explicit operational boundary.

Backups stay local and outside the Vault. Every copied file is hashed, while
non-Markdown configuration matching secret patterns is excluded and reported.
The plugin does not claim encryption at rest; filesystem ACLs and full-disk
encryption remain host responsibilities. Re-downloadable `.tools` binaries are
not part of the memory recovery set.
