#!/usr/bin/env node
'use strict';

const path = require('path');
const core = require('./memory-core.cjs');

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

function normalizeBenchmarkPath(value) {
  return String(value || '').replace(/\\/g, '/').toLocaleLowerCase();
}

function runBenchmark(options = {}) {
  const vault = core.resolveVault(options.vault);
  const casesPath = path.resolve(
    options.cases || path.join(vault, 'Meta', 'retrieval-benchmark.json'),
  );
  const fixture = core.validateBenchmarkFixture(vault, casesPath);
  if (!fixture.exists) {
    throw new Error(`benchmark cases file does not exist: ${casesPath}`);
  }
  if (fixture.errors.length > 0) {
    throw new Error(
      `benchmark fixture is invalid:\n${fixture.errors.map((error) => `- ${error}`).join('\n')}`,
    );
  }
  const document = fixture.document;
  const overrideLimit = Number(options.limit);
  const caseResults = document.cases.map((testCase, index) => {
    const id = String(testCase.id || `case-${index + 1}`);
    const query = String(testCase.query || '').trim();
    if (!query) {
      throw new Error(`benchmark case '${id}' is missing query`);
    }
    const limit = Number.isFinite(overrideLimit) && overrideLimit > 0
      ? Math.floor(overrideLimit)
      : Number(testCase.limit) || 3;
    const results = core.searchMemory({
      vault,
      query,
      cwd: testCase.cwd,
      limit,
      includeArchive: Boolean(testCase.include_archive),
      includeAllProjects: Boolean(testCase.include_all_projects),
    });
    const returnedPaths = results.map((result) => normalizeBenchmarkPath(result.relativePath));
    const relevantPaths = (testCase.relevant_paths || []).map(normalizeBenchmarkPath);
    const requiredPaths = (testCase.required_paths || testCase.relevant_paths || [])
      .map(normalizeBenchmarkPath);
    const forbiddenPaths = (testCase.forbidden_paths || []).map(normalizeBenchmarkPath);
    const relevantHits = returnedPaths.filter((item) => relevantPaths.includes(item));
    const forbiddenHits = returnedPaths.filter((item) => forbiddenPaths.includes(item));
    const firstRelevantIndex = returnedPaths.findIndex((item) => relevantPaths.includes(item));
    const expectNoHit = Boolean(testCase.expect_no_hit);
    const requiredPresent = requiredPaths.every((item) => returnedPaths.includes(item));
    const passed = expectNoHit
      ? returnedPaths.length === 0
      : requiredPresent && forbiddenHits.length === 0;
    return {
      id,
      passed,
      query,
      cwd: String(testCase.cwd || ''),
      limit,
      includeArchive: Boolean(testCase.include_archive),
      expectNoHit,
      returnedPaths: results.map((result) => result.relativePath.replace(/\\/g, '/')),
      requiredPresent,
      relevantHits: relevantHits.length,
      relevantTotal: relevantPaths.length,
      precision: relevantPaths.length === 0
        ? null
        : relevantHits.length / Math.max(returnedPaths.length, 1),
      recall: relevantPaths.length === 0
        ? null
        : relevantHits.length / relevantPaths.length,
      reciprocalRank: firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1),
      forbiddenHits,
    };
  });
  const relevanceCases = caseResults.filter((item) => item.relevantTotal > 0);
  const noHitCases = caseResults.filter((item) => item.expectNoHit);
  const average = (items, selector) => (
    items.length === 0
      ? null
      : items.reduce((total, item) => total + selector(item), 0) / items.length
  );
  return {
    version: document.version || 1,
    casesPath,
    generatedAt: new Date().toISOString(),
    totalCases: caseResults.length,
    passedCases: caseResults.filter((item) => item.passed).length,
    passRate: caseResults.filter((item) => item.passed).length / caseResults.length,
    precisionAtK: average(relevanceCases, (item) => item.precision),
    recallAtK: average(relevanceCases, (item) => item.recall),
    mrr: average(relevanceCases, (item) => item.reciprocalRank),
    noHitAccuracy: average(noHitCases, (item) => (item.passed ? 1 : 0)),
    forbiddenHitCases: caseResults.filter((item) => item.forbiddenHits.length > 0).length,
    cases: caseResults,
  };
}

function showHelp() {
  process.stdout.write(`Obsidian scoped multi-project memory CLI

Usage:
  memory-cli.cjs status [--vault PATH] [--builtin-memory PATH] [--json]
  memory-cli.cjs search --query TEXT [--cwd PATH] [--limit N] [--include-archive] [--include-core] [--all-projects] [--vault PATH] [--json]
  memory-cli.cjs benchmark [--cases PATH] [--limit N] [--vault PATH] [--json]
  memory-cli.cjs novelty-check --text TEXT [--cwd PATH] [--builtin-memory PATH] [--vault PATH] [--json]
  memory-cli.cjs capture --title TEXT --summary TEXT --source TEXT --scope TEXT --scope-kind project|cross-project --applies-to a,b --boundary TEXT [--transferability TEXT] [--origin-projects a,b] [--native-memory-relation absent|extends|corrects] [--evidence TEXT] [--tags a,b] [--builtin-memory PATH] [--vault PATH] [--json]
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
        query,
        cwd: options.cwd,
        limit: options.limit,
        includeArchive: Boolean(options['include-archive']),
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
      const result = runBenchmark({
        vault,
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
        scope: options.scope,
        scopeKind: options['scope-kind'],
        appliesTo: options['applies-to'],
        boundary: options.boundary,
        transferability: options.transferability,
        originProjects: options['origin-projects'],
        nativeMemoryRelation: options['native-memory-relation'],
        evidence: options.evidence,
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
