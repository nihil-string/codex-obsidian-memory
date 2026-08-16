#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('./memory-core.cjs');
const backup = require('./memory-backup.cjs');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrows(fn, pattern, message) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert(thrown && pattern.test(String(thrown.message || thrown)), message);
}

function writeCoreFiles(vault) {
  for (const relativePath of core.CORE_FILES) {
    let content = `# ${path.basename(relativePath, '.md')}\n`;
    if (relativePath === 'INDEX.md') {
      content += '\n<!-- BEGIN GENERATED MEMORY INDEX -->\nempty\n<!-- END GENERATED MEMORY INDEX -->\n';
    }
    core.writeUtf8Atomic(path.join(vault, relativePath), content);
  }
  core.writeUtf8Atomic(
    path.join(vault, '.obsidian', 'community-plugins.json'),
    '["obsidian-local-rest-api"]\n',
  );
}

function noteContent(options) {
  const optional = [
    options.validUntil ? `valid_until: ${options.validUntil}` : '',
    options.reviewAfter ? `review_after: ${options.reviewAfter}` : '',
  ].filter(Boolean).join('\n');
  return `---
memory_id: ${options.memoryId}
type: ${options.type || 'test'}
status: ${options.status || 'candidate'}
scope: governance self-test
scope_kind: project
applies_to:
  - ${JSON.stringify(options.projectRoot)}
boundary: governance self-test only
native_memory_relation: ${options.nativeRelation || 'absent'}
native_memory_checked_at: ${core.localDate()}
native_memory_fingerprint: ${options.nativeFingerprint}
source: governance self-test
source_kind: test-result
capture_method: manual
created_at: ${core.localDate()}
updated_at: ${core.localDate()}
${optional}
---

# ${options.title}

## 当前结论

${options.conclusion}
`;
}

function main() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-memory-governance-vault-'));
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-memory-governance-native-'));
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-memory-governance-backup-'));
  const projectRoot = path.join(vault, 'workspace', 'governance-project');
  try {
    writeCoreFiles(vault);
    core.writeUtf8Atomic(path.join(memoryRoot, 'memory_summary.md'), '# Governance native summary\n');
    core.writeUtf8Atomic(path.join(memoryRoot, 'MEMORY.md'), '# Governance native registry\n');
    const nativeFingerprint = core.builtInMemorySnapshot(memoryRoot).fingerprint;

    core.writeUtf8Atomic(
      path.join(vault, 'Projects', 'active.md'),
      noteContent({
        memoryId: 'governance-active',
        status: 'current',
        projectRoot,
        nativeFingerprint,
        title: 'Active Mercury Contract',
        conclusion: 'The mercury reconciliation sentinel is current only after a matching native snapshot check.',
      }),
    );
    core.writeUtf8Atomic(
      path.join(vault, 'Inbox', 'expired.md'),
      noteContent({
        memoryId: 'governance-expired',
        projectRoot,
        nativeFingerprint,
        validUntil: '2000-01-01',
        title: 'Expired Cerulean Contract',
        conclusion: 'The cerulean-expiry-sentinel must be absent from default retrieval after valid_until.',
      }),
    );
    core.writeUtf8Atomic(
      path.join(vault, 'Inbox', 'review.md'),
      noteContent({
        memoryId: 'governance-review',
        projectRoot,
        nativeFingerprint,
        reviewAfter: '2000-01-01',
        title: 'Review Amber Contract',
        conclusion: 'The amber-review-sentinel remains retrievable but must be labelled review-overdue.',
      }),
    );
    core.writeUtf8Atomic(
      path.join(vault, 'Inbox', 'hard-delete.md'),
      noteContent({
        memoryId: 'governance-hard-delete',
        projectRoot,
        nativeFingerprint,
        title: 'Hard Delete Violet Contract',
        conclusion: 'The violet-hard-delete-sentinel exists only to prove current and managed backup purging.',
      }).replace(
        'capture_method: manual\n',
        'capture_method: manual\naliases:\n  - Violet Privacy Contract\n',
      ),
    );
    core.writeUtf8Atomic(
      path.join(vault, 'Meta', 'retrieval-benchmark.json'),
      `${JSON.stringify({
        version: 1,
        cases: [{
          id: 'governance-active',
          query: 'mercury reconciliation sentinel',
          cwd: projectRoot,
          relevant_paths: ['Projects/active.md'],
          required_paths: ['Projects/active.md'],
        }],
      }, null, 2)}\n`,
    );

    const initialMaintenance = core.maintainVault(vault, { memoryRoot });
    assert(initialMaintenance.ok, `initial governance fixture invalid: ${initialMaintenance.errors.join('; ')}`);

    const expiredDefault = core.searchMemory({
      vault,
      memoryRoot,
      cwd: projectRoot,
      query: 'cerulean-expiry-sentinel',
    });
    assert(
      !expiredDefault.some((item) => item.relativePath.endsWith('expired.md')),
      'expired note leaked into default retrieval',
    );
    const expiredExplicit = core.searchMemory({
      vault,
      memoryRoot,
      cwd: projectRoot,
      query: 'cerulean-expiry-sentinel',
      includeExpired: true,
    });
    const explicitExpiredNote = expiredExplicit.find((item) => item.relativePath.endsWith('expired.md'));
    assert(explicitExpiredNote?.freshness === 'expired', 'explicit expired retrieval lost freshness');

    const reviewResults = core.searchMemory({
      vault,
      memoryRoot,
      cwd: projectRoot,
      query: 'amber-review-sentinel',
    });
    const reviewNote = reviewResults.find((item) => item.relativePath.endsWith('review.md'));
    assert(reviewNote?.freshness === 'review-overdue', 'review_after did not label stale retrieval');
    assert(reviewNote?.effectiveTrust === 'lead-only', 'candidate effective trust was overstated');

    fs.appendFileSync(
      path.join(memoryRoot, 'MEMORY.md'),
      '\nThe mercury reconciliation sentinel is current only after a matching native snapshot check.\n',
      'utf8',
    );
    const staleResults = core.searchMemory({
      vault,
      memoryRoot,
      cwd: projectRoot,
      query: 'mercury reconciliation sentinel',
    });
    assert(
      !staleResults.some((item) => item.relativePath.endsWith('active.md')),
      'native-memory fingerprint drift did not fail closed',
    );
    const drift = core.reconcileNativeMemory(vault, { memoryRoot, apply: true });
    assert(
      !drift.ok && drift.conflicts.some((item) => item.memoryId === 'governance-active'),
      'native-memory drift did not require relation review',
    );
    const activePath = path.join(vault, 'Projects', 'active.md');
    core.writeUtf8Atomic(
      activePath,
      core.readUtf8(activePath).replace('native_memory_relation: absent', 'native_memory_relation: extends'),
    );
    const reconciled = core.reconcileNativeMemory(vault, { memoryRoot, apply: true });
    assert(reconciled.ok, 'reviewed native-memory relation did not reconcile');
    const activeResults = core.searchMemory({
      vault,
      memoryRoot,
      cwd: projectRoot,
      query: 'mercury reconciliation sentinel',
    });
    const activeNote = activeResults.find((item) => item.relativePath.endsWith('active.md'));
    assert(activeNote?.effectiveTrust === 'bounded-current', 'current effective trust was not derived');

    const legacyPath = path.join(vault, 'Inbox', 'legacy.md');
    core.writeUtf8Atomic(
      legacyPath,
      noteContent({
        memoryId: 'governance-legacy',
        projectRoot,
        nativeFingerprint: core.builtInMemorySnapshot(memoryRoot).fingerprint,
        title: 'Legacy Provenance Contract',
        conclusion: 'The legacy-provenance-sentinel is migrated without inventing a trusted source.',
      })
        .replace('source_kind: test-result\n', '')
        .replace('capture_method: manual\n', ''),
    );
    const migrationPreview = core.migrateVaultSchema(vault, { apply: false });
    assert(migrationPreview.changedNotes === 1, 'schema migration preview missed the legacy note');
    core.migrateVaultSchema(vault, { apply: true });
    core.reconcileNativeMemory(vault, { memoryRoot, apply: true });
    const migrated = core.parseFrontmatter(core.readUtf8(legacyPath)).data;
    assert(
      migrated.source_kind === 'legacy-unspecified' && migrated.capture_method === 'legacy',
      'legacy provenance migration invented or omitted provenance',
    );

    const revokePreview = core.revokeMemory(vault, {
      memoryRoot,
      memoryId: 'governance-review',
      reason: 'self-test explicit revocation',
    });
    assert(revokePreview.dryRun && fs.existsSync(path.join(vault, 'Inbox', 'review.md')), 'revoke dry-run mutated the Vault');
    const revoked = core.revokeMemory(vault, {
      memoryRoot,
      memoryId: 'governance-review',
      reason: 'self-test explicit revocation',
      confirm: 'governance-review',
    });
    assert(revoked.applied, 'confirmed revocation was not applied');
    const revokedDefault = core.searchMemory({
      vault,
      memoryRoot,
      cwd: projectRoot,
      query: 'amber-review-sentinel',
    });
    assert(
      !revokedDefault.some((item) => item.status === 'revoked'),
      'revoked note leaked into default retrieval',
    );
    const revokedHistory = core.searchMemory({
      vault,
      memoryRoot,
      cwd: projectRoot,
      query: 'amber-review-sentinel',
      includeArchive: true,
    });
    assert(
      revokedHistory.some((item) => item.status === 'revoked'),
      'explicit history did not return revoked note',
    );

    const snapshot = backup.createBackup({ vault, memoryRoot, backupRoot });
    assert(snapshot.verification.ok, 'versioned backup did not verify');
    const restored = backup.restoreTest({ snapshotPath: snapshot.snapshotPath, memoryRoot });
    assert(restored.ok && restored.isolated, 'isolated restore test failed');

    const aliasReferencePath = path.join(vault, 'Inbox', 'hard-delete-alias-reference.md');
    core.writeUtf8Atomic(
      aliasReferencePath,
      noteContent({
        memoryId: 'governance-hard-delete-alias-reference',
        projectRoot,
        nativeFingerprint: core.builtInMemorySnapshot(memoryRoot).fingerprint,
        title: 'Hard Delete Alias Reference',
        conclusion: 'This note retains [[Violet Privacy Contract#^retention-block]] as an alias and block reference.',
      }),
    );
    const aliasReferenceSnapshot = backup.createBackup({ vault, memoryRoot, backupRoot });
    assertThrows(
      () => backup.hardDeleteMemory({
        vault,
        memoryRoot,
        backupRoot,
        memoryId: 'governance-hard-delete',
        reason: 'self-test privacy deletion',
        confirm: 'governance-hard-delete',
      }),
      /durable notes still reference/,
      'hard-delete did not refuse an alias/block reference',
    );
    fs.unlinkSync(aliasReferencePath);
    assertThrows(
      () => backup.hardDeleteMemory({
        vault,
        memoryRoot,
        backupRoot,
        memoryId: 'governance-hard-delete',
        reason: 'self-test privacy deletion',
        confirm: 'governance-hard-delete',
      }),
      /durable notes still reference/,
      'hard-delete did not refuse an alias/block reference retained by a managed backup',
    );
    assert(
      aliasReferenceSnapshot.snapshotPath.startsWith(path.resolve(backupRoot) + path.sep),
      'self-test backup cleanup escaped the temporary backup root',
    );
    fs.rmSync(aliasReferenceSnapshot.snapshotPath, { recursive: true, force: true });

    const deletePreview = backup.hardDeleteMemory({
      vault,
      memoryRoot,
      backupRoot,
      memoryId: 'governance-hard-delete',
      reason: 'self-test privacy deletion',
    });
    assert(
      deletePreview.dryRun && deletePreview.backupOccurrences.length === 1,
      'hard-delete dry-run did not report current and backup scope',
    );
    const deleted = backup.hardDeleteMemory({
      vault,
      memoryRoot,
      backupRoot,
      memoryId: 'governance-hard-delete',
      reason: 'self-test privacy deletion',
      confirm: 'governance-hard-delete',
    });
    assert(deleted.applied, 'confirmed hard-delete was not applied');
    assert(backup.verifyBackup(snapshot.snapshotPath).ok, 'backup failed verification after privacy purge');
    const restoredAfterPurge = backup.restoreTest({ snapshotPath: snapshot.snapshotPath, memoryRoot });
    assert(restoredAfterPurge.ok, 'backup restore failed after privacy purge');

    const linkTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-memory-governance-link-target-'));
    const linkPath = path.join(vault, '.junction-probe');
    try {
      fs.symlinkSync(linkTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      assertThrows(
        () => backup.createBackup({ vault, memoryRoot, backupRoot }),
        /refuses symbolic link or junction/,
        'backup did not refuse a symbolic link or Windows junction',
      );
    } finally {
      if (fs.existsSync(linkPath)) {
        fs.unlinkSync(linkPath);
      }
      if (linkTarget.startsWith(path.join(os.tmpdir(), 'obsidian-memory-governance-link-target-'))) {
        fs.rmSync(linkTarget, { recursive: true, force: true });
      }
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      nativeMemoryDriftFailsClosed: true,
      provenanceMigrationIsConservative: true,
      expiredDefaultExcluded: true,
      reviewAfterLabelled: true,
      revokedDefaultExcluded: true,
      hardDeleteAliasAndBackupReferencesRefused: true,
      hardDeleteDryRunAndBackupPurge: true,
      backupSymlinkOrJunctionRefused: true,
      isolatedRestoreVerified: true,
    }, null, 2)}\n`);
  } finally {
    const safePrefixes = [
      [vault, path.join(os.tmpdir(), 'obsidian-memory-governance-vault-')],
      [memoryRoot, path.join(os.tmpdir(), 'obsidian-memory-governance-native-')],
      [backupRoot, path.join(os.tmpdir(), 'obsidian-memory-governance-backup-')],
    ];
    for (const [target, expectedPrefix] of safePrefixes) {
      if (target.startsWith(expectedPrefix)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`obsidian-memory governance self-test: ${error.stack || error.message}\n`);
  process.exitCode = 1;
}
