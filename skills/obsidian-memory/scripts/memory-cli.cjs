#!/usr/bin/env node
'use strict';

const core = require('./memory-core.cjs');
const backup = require('./memory-backup.cjs');

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      options._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printReport(report) {
  const statusSummary = Object.entries(report.statusCounts)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  const topicStatusSummary = Object.entries(report.topicStatusCounts || {})
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  const archiveStatusSummary = Object.entries(report.archiveStatusCounts || {})
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  process.stdout.write([
    `Vault: ${report.vault}`,
    `Status: ${report.ok ? 'OK' : 'FAILED'}`,
    `Files checked: ${report.filesChecked}`,
    `Topic notes: ${report.topicNotes}`,
    `Archive notes: ${report.archivedNotes}`,
    `Built-in memory: ${report.builtInMemoryAvailable
      ? `available (${report.builtInMemoryFilesChecked} files)`
      : 'unavailable (captures fail closed)'}`,
    `Built-in memory root: ${report.builtInMemoryRoot}`,
    `Searchable topic statuses: ${topicStatusSummary}`,
    `Archive statuses: ${archiveStatusSummary}`,
    `All Markdown statuses: ${statusSummary}`,
    '',
    'Errors:',
    ...(report.errors.length ? report.errors.map((item) => `- ${item}`) : ['- none']),
    '',
    'Warnings:',
    ...(report.warnings.length ? report.warnings.map((item) => `- ${item}`) : ['- none']),
    '',
  ].join('\n'));
}

function showHelp() {
  process.stdout.write(`Obsidian scoped multi-project memory CLI

Usage:
  memory-cli.cjs status [--vault PATH] [--builtin-memory PATH] [--json]
  memory-cli.cjs search --query TEXT [--cwd PATH] [--limit N] [--include-archive] [--include-expired] [--include-stale-native] [--include-core] [--all-projects] [--vault PATH] [--json]
  memory-cli.cjs benchmark [--cases PATH] [--limit N] [--vault PATH] [--json]
  memory-cli.cjs novelty-check --text TEXT [--cwd PATH] [--builtin-memory PATH] [--vault PATH] [--json]
  memory-cli.cjs capture --title TEXT --summary TEXT --source TEXT --source-kind KIND --scope TEXT --scope-kind project|cross-project --applies-to a,b --boundary TEXT [--capture-method METHOD] [--transferability TEXT] [--origin-projects a,b] [--native-memory-relation absent|extends|corrects] [--evidence TEXT] [--valid-until YYYY-MM-DD] [--review-after YYYY-MM-DD] [--tags a,b] [--builtin-memory PATH] [--vault PATH] [--json]
  memory-cli.cjs migrate-schema [--apply] [--vault PATH] [--json]
  memory-cli.cjs reconcile-native [--apply] [--builtin-memory PATH] [--vault PATH] [--json]
  memory-cli.cjs lifecycle-set --memory-id ID [--valid-until YYYY-MM-DD] [--review-after YYYY-MM-DD] [--confirm ID] [--vault PATH] [--json]
  memory-cli.cjs revoke --memory-id ID --reason TEXT [--confirm ID] [--vault PATH] [--json]
  memory-cli.cjs backup [--backup-root PATH] [--allow-legacy-schema] [--vault PATH] [--builtin-memory PATH] [--json]
  memory-cli.cjs verify-backup --snapshot PATH [--json]
  memory-cli.cjs restore-test --snapshot PATH [--builtin-memory PATH] [--json]
  memory-cli.cjs hard-delete --memory-id ID --reason TEXT [--confirm ID] [--backup-root PATH] [--vault PATH] [--json]
  memory-cli.cjs validate [--vault PATH] [--builtin-memory PATH] [--json]
  memory-cli.cjs rebuild-index [--vault PATH] [--json]
  memory-cli.cjs maintain [--vault PATH] [--builtin-memory PATH] [--json]
  memory-cli.cjs self-test [--json]
`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] || 'help';
  const vault = core.resolveVault(options.vault);
  const memoryRoot = core.resolveBuiltInMemoryRoot(options['builtin-memory']);
  const asJson = Boolean(options.json);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      return;

    case 'status': {
      const report = core.validateVault(vault, { memoryRoot });
      if (asJson) {
        printJson(report);
      } else {
        printReport(report);
      }
      if (!report.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case 'search': {
      const query = String(options.query || '').trim();
      if (!query) {
        throw new Error('search requires --query');
      }
      const results = core.searchMemory({
        vault,
        memoryRoot,
        query,
        cwd: options.cwd,
        limit: options.limit,
        includeArchive: Boolean(options['include-archive']),
        includeExpired: Boolean(options['include-expired']),
        includeStaleNative: Boolean(options['include-stale-native']),
        includeCore: Boolean(options['include-core']),
        includeAllProjects: Boolean(options['all-projects']),
      });
      if (asJson) {
        printJson(core.createAgentSafeSearchPayload({ vault, query, results }));
      } else {
        process.stdout.write(`${core.formatAgentSafeSearchResults(results, vault)}\n`);
      }
      return;
    }

    case 'benchmark': {
      const result = core.runBenchmark({
        vault,
        memoryRoot,
        cases: options.cases,
        limit: options.limit,
      });
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write([
          `Benchmark cases: ${result.passedCases}/${result.totalCases} passed`,
          `Pass rate: ${(result.passRate * 100).toFixed(1)}%`,
          `Precision@K: ${result.precisionAtK === null ? 'n/a' : result.precisionAtK.toFixed(3)}`,
          `Recall@K: ${result.recallAtK === null ? 'n/a' : result.recallAtK.toFixed(3)}`,
          `MRR: ${result.mrr === null ? 'n/a' : result.mrr.toFixed(3)}`,
          `No-hit accuracy: ${result.noHitAccuracy === null ? 'n/a' : result.noHitAccuracy.toFixed(3)}`,
          `Forbidden-hit cases: ${result.forbiddenHitCases}`,
          '',
          ...result.cases.map((item) => (
            `${item.passed ? 'PASS' : 'FAIL'} ${item.id}: ${item.returnedPaths.join(', ') || '(no hits)'}`
          )),
          '',
        ].join('\n'));
      }
      if (result.passedCases !== result.totalCases) {
        process.exitCode = 1;
      }
      return;
    }

    case 'novelty-check': {
      const text = String(options.text || '').trim();
      if (!text) {
        throw new Error('novelty-check requires --text');
      }
      const result = core.checkNovelty({
        vault,
        text,
        cwd: options.cwd,
        memoryRoot,
        limit: options.limit,
      });
      if (asJson) {
        printJson(core.redactStructuredValue({
          vault,
          text,
          nativeMemory: result.nativeMemory,
          vaultMatches: result.vaultMatches,
          retrievalPolicy: core.AGENT_SAFE_RETRIEVAL_POLICY,
          trustBoundary: core.AGENT_SAFE_RETRIEVAL_BOUNDARY,
        }));
      } else {
        const native = result.nativeMemory;
        process.stdout.write([
          `Built-in memory available: ${native.available ? 'yes' : 'no'}`,
          `Likely duplicate: ${native.likelyDuplicate ? 'yes' : 'no'}`,
          `Exact duplicate: ${native.exactDuplicate ? 'yes' : 'no'}`,
          `Term coverage: ${(native.termCoverage * 100).toFixed(1)}%`,
          `Built-in matches: ${native.matches.length}`,
          ...native.matches.map(
            (match) => `- ${match.relativePath} (score=${match.score})`,
          ),
          '',
          `Vault matches: ${result.vaultMatches.length}`,
          core.formatAgentSafeSearchResults(result.vaultMatches, vault),
          '',
        ].join('\n'));
      }
      return;
    }

    case 'capture': {
      const result = core.createCandidate({
        vault,
        memoryRoot,
        title: options.title,
        summary: options.summary,
        source: options.source,
        sourceKind: options['source-kind'],
        captureMethod: options['capture-method'],
        scope: options.scope,
        scopeKind: options['scope-kind'],
        appliesTo: options['applies-to'],
        boundary: options.boundary,
        transferability: options.transferability,
        originProjects: options['origin-projects'],
        nativeMemoryRelation: options['native-memory-relation'],
        evidence: options.evidence,
        validUntil: options['valid-until'],
        reviewAfter: options['review-after'],
        tags: options.tags,
      });
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write(`Created candidate: ${result.filePath}\n`);
        process.stdout.write(`memory_id: ${result.memoryId}\n`);
        process.stdout.write(`Index: ${result.maintenance.indexPath}\n`);
        process.stdout.write(`Health report: ${result.maintenance.healthPath}\n`);
      }
      if (!result.maintenance.ok) {
        process.stderr.write([
          'Candidate was created, but post-write maintenance failed:',
          ...result.maintenance.errors.map((error) => `- ${error}`),
          '',
        ].join('\n'));
        process.exitCode = 1;
      }
      return;
    }

    case 'migrate-schema': {
      const result = core.migrateVaultSchema(vault, { apply: Boolean(options.apply) });
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write([
          `Schema migration: ${result.apply ? 'APPLIED' : 'DRY RUN'}`,
          `Changed notes: ${result.changedNotes}`,
          ...result.changes.map((item) => `- ${item.relativePath}: ${Object.keys(item.updates).join(', ')}`),
          result.apply ? '' : 'Run again with --apply after reviewing the paths above.',
          '',
        ].join('\n'));
      }
      return;
    }

    case 'reconcile-native': {
      const result = core.reconcileNativeMemory(vault, {
        memoryRoot,
        apply: Boolean(options.apply),
        writeReport: true,
      });
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write([
          `Native reconcile: ${result.ok ? 'OK' : 'REVIEW REQUIRED'}`,
          `Mode: ${result.applied ? 'APPLIED' : 'DRY RUN'}`,
          `Fingerprint: ${result.nativeMemoryFingerprint || 'unavailable'}`,
          `Notes checked: ${result.notesChecked}`,
          `Notes updated: ${result.updatedNotes}`,
          `Conflicts: ${result.conflicts.length}`,
          ...result.conflicts.map(
            (item) => `- ${item.relativePath}: recorded=${item.recordedRelation}, duplicate=${item.observedLikelyDuplicate}, coverage=${item.observedTermCoverage}`,
          ),
          `Report: ${result.reportPath || 'not-written'}`,
          '',
        ].join('\n'));
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case 'lifecycle-set': {
      const result = core.setMemoryLifecycle(vault, {
        memoryId: options['memory-id'],
        validUntil: options['valid-until'],
        reviewAfter: options['review-after'],
        confirm: options.confirm,
        memoryRoot,
      });
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
      return;
    }

    case 'revoke': {
      const result = core.revokeMemory(vault, {
        memoryId: options['memory-id'],
        reason: options.reason,
        confirm: options.confirm,
        memoryRoot,
      });
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
      return;
    }

    case 'backup': {
      const result = backup.createBackup({
        vault,
        memoryRoot,
        backupRoot: options['backup-root'],
        allowLegacySchema: Boolean(options['allow-legacy-schema']),
      });
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write([
          `Backup: ${result.verification.ok ? 'VERIFIED' : 'FAILED'}`,
          `Snapshot: ${result.snapshotPath}`,
          `Files copied: ${result.filesCopied}`,
          `Sensitive config files excluded: ${result.excludedSensitive.length}`,
          `Fingerprint: ${result.contentFingerprint}`,
          '',
        ].join('\n'));
      }
      return;
    }

    case 'verify-backup': {
      const result = backup.verifyBackup(options.snapshot);
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case 'restore-test': {
      const result = backup.restoreTest({
        snapshotPath: options.snapshot,
        memoryRoot,
      });
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case 'hard-delete': {
      const result = backup.hardDeleteMemory({
        vault,
        memoryRoot,
        backupRoot: options['backup-root'],
        memoryId: options['memory-id'],
        reason: options.reason,
        confirm: options.confirm,
      });
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
      return;
    }

    case 'validate': {
      const report = core.validateVault(vault, { memoryRoot });
      if (asJson) {
        printJson(report);
      } else {
        printReport(report);
      }
      if (!report.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case 'rebuild-index': {
      const result = core.rebuildIndex(vault);
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write(`Indexed ${result.indexedNotes} topic notes in ${result.indexPath}\n`);
      }
      return;
    }

    case 'maintain': {
      const report = core.maintainVault(vault, { memoryRoot });
      if (asJson) {
        printJson(report);
      } else {
        printReport(report);
        process.stdout.write(`Index: ${report.indexPath}\n`);
        process.stdout.write(`Health report: ${report.healthPath}\n`);
      }
      if (!report.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case 'self-test': {
      const result = core.runSelfTest();
      if (asJson) {
        printJson(result);
      } else {
        process.stdout.write(`Self-test: ${result.ok ? 'OK' : 'FAILED'}\n`);
        process.stdout.write(`Cross-project results: ${result.crossProjectResults}\n`);
        process.stdout.write(`Matching project results: ${result.matchingProjectResults}\n`);
        process.stdout.write(`Unrelated project results: ${result.unrelatedProjectResults}\n`);
        process.stdout.write(`Project scope isolation: ${result.projectScopeIsolation ? 'OK' : 'FAILED'}\n`);
        process.stdout.write(`Native duplicate detection: ${result.nativeDuplicateDetected ? 'OK' : 'FAILED'}\n`);
        process.stdout.write(`Duplicate capture blocking: ${result.duplicateCaptureBlocked ? 'OK' : 'FAILED'}\n`);
        process.stdout.write(`Cold-start results before capture: ${result.coldStartBeforeResults}\n`);
        process.stdout.write(`Cold-start project capture: ${result.coldStartProjectCandidate ? 'OK' : 'FAILED'}\n`);
        process.stdout.write(`Cold-start results after capture: ${result.coldStartAfterResults}\n`);
        process.stdout.write(`Cold-start project isolation: ${result.coldStartProjectIsolation ? 'OK' : 'FAILED'}\n`);
        process.stdout.write(`Single-origin cross-project capture: ${result.singleOriginPortableCandidate ? 'OK' : 'FAILED'}\n`);
        process.stdout.write(`Indexed notes: ${result.indexedNotes}\n`);
        process.stdout.write(`Files checked: ${result.filesChecked}\n`);
      }
      return;
    }

    default:
      throw new Error(`Unknown command '${command}'. Run with 'help'.`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`obsidian-memory: ${error.message}\n`);
  process.exitCode = 1;
}
