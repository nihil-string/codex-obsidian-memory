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
writes, deletion, publication, or status promotion.
