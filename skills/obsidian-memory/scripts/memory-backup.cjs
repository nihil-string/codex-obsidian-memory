'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('./memory-core.cjs');

const DEFAULT_BACKUP_ROOT = process.env.CODEX_OBSIDIAN_MEMORY_BACKUP_ROOT
  || path.join(os.homedir(), '.codex', 'backups', 'obsidian-memory');
const BACKUP_MANIFEST = 'manifest.json';
const GENERATED_BACKUP_EXCLUSIONS = new Set([
  'INDEX.md',
  'Meta/HEALTH.md',
  'Meta/native-memory-reconcile.json',
]);
const TEXT_EXTENSIONS = new Set([
  '.css', '.js', '.json', '.md', '.toml', '.txt', '.yaml', '.yml',
]);

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeRelative(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function assertContained(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of ${resolvedRoot}`);
  }
  return resolvedTarget;
}

function resolveBackupRoot(value) {
  return path.resolve(value || DEFAULT_BACKUP_ROOT);
}

function shouldExclude(relativePath) {
  const normalized = normalizeRelative(relativePath);
  const segments = normalized.split('/');
  if (segments.some((segment) => ['.git', '.tools', '.trash', 'node_modules'].includes(segment))) {
    return true;
  }
  if (GENERATED_BACKUP_EXCLUSIONS.has(normalized)) {
    return true;
  }
  if (/^\.obsidian\/workspace(?:-mobile)?\.json$/i.test(normalized)) {
    return true;
  }
  return /\.tmp$/i.test(normalized);
}

function walkFiles(root) {
  const resolvedRoot = path.resolve(root);
  const output = [];
  const stack = [resolvedRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(resolvedRoot, fullPath);
      if (shouldExclude(relativePath)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`backup refuses symbolic link or junction: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        output.push(fullPath);
      }
    }
  }
  return output.sort((left, right) => left.localeCompare(right));
}

function sensitiveFindings(filePath, buffer) {
  if (buffer.length > 2 * 1024 * 1024 || !TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return [];
  }
  return core.findSecretFindings(buffer.toString('utf8'));
}

function manifestFingerprint(entries) {
  const digest = crypto.createHash('sha256');
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update(entry.path);
    digest.update('\0');
    digest.update(entry.sha256);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function readManifest(snapshotPath) {
  const manifestPath = path.join(path.resolve(snapshotPath), BACKUP_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`backup manifest does not exist: ${manifestPath}`);
  }
  return {
    manifestPath,
    manifest: JSON.parse(core.readUtf8(manifestPath)),
  };
}

function verifyBackup(snapshotPath) {
  const snapshot = path.resolve(snapshotPath);
  const { manifestPath, manifest } = readManifest(snapshot);
  const vaultRoot = path.join(snapshot, 'vault');
  const errors = [];
  const declared = new Set();
  for (const entry of manifest.files || []) {
    const relativePath = normalizeRelative(entry.path);
    if (!relativePath || relativePath.startsWith('../')) {
      errors.push(`unsafe manifest path: ${entry.path}`);
      continue;
    }
    if (declared.has(relativePath)) {
      errors.push(`duplicate manifest path: ${relativePath}`);
      continue;
    }
    declared.add(relativePath);
    const filePath = assertContained(vaultRoot, path.join(vaultRoot, relativePath), 'manifest file');
    if (!fs.existsSync(filePath)) {
      errors.push(`missing backup file: ${relativePath}`);
      continue;
    }
    const buffer = fs.readFileSync(filePath);
    if (buffer.length !== entry.size) {
      errors.push(`size mismatch: ${relativePath}`);
    }
    if (sha256Buffer(buffer) !== entry.sha256) {
      errors.push(`hash mismatch: ${relativePath}`);
    }
  }
  const actual = fs.existsSync(vaultRoot)
    ? walkFiles(vaultRoot).map((filePath) => normalizeRelative(path.relative(vaultRoot, filePath)))
    : [];
  for (const relativePath of actual) {
    if (!declared.has(relativePath)) {
      errors.push(`undeclared backup file: ${relativePath}`);
    }
  }
  if (manifest.contentFingerprint !== manifestFingerprint(manifest.files || [])) {
    errors.push('manifest content fingerprint mismatch');
  }
  return {
    ok: errors.length === 0,
    snapshotPath: snapshot,
    manifestPath,
    createdAt: String(manifest.createdAt || ''),
    filesChecked: declared.size,
    excludedSensitive: manifest.excludedSensitive || [],
    errors,
  };
}

function createBackup(options = {}) {
  const vault = core.resolveVault(options.vault);
  const backupRoot = resolveBackupRoot(options.backupRoot);
  const relativeRoot = path.relative(vault, backupRoot);
  if (!relativeRoot.startsWith('..') && !path.isAbsolute(relativeRoot)) {
    throw new Error('backup root must be outside the production Vault');
  }
  const validation = core.validateVault(vault, { memoryRoot: options.memoryRoot });
  const toleratedLegacyErrors = validation.errors.filter((error) => (
    /missing scalar frontmatter field '(?:native_memory_fingerprint|source_kind|capture_method)'/.test(error)
    || /invalid (?:source_kind|capture_method) ''/.test(error)
    || /stale native-memory reconciliation/.test(error)
  ));
  const blockingErrors = validation.errors.filter((error) => !toleratedLegacyErrors.includes(error));
  if (!validation.ok && !(options.allowLegacySchema && blockingErrors.length === 0)) {
    throw new Error(`refusing backup of invalid Vault: ${validation.errors.join('; ')}`);
  }
  fs.mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  const staging = assertContained(
    backupRoot,
    path.join(backupRoot, `.${stamp}.${process.pid}.staging`),
    'backup staging directory',
  );
  fs.mkdirSync(path.join(staging, 'vault'), { recursive: true });
  const entries = [];
  const excludedSensitive = [];
  try {
    for (const sourcePath of walkFiles(vault)) {
      const relativePath = normalizeRelative(path.relative(vault, sourcePath));
      const buffer = fs.readFileSync(sourcePath);
      const findings = sensitiveFindings(sourcePath, buffer);
      if (findings.length > 0) {
        if (path.extname(sourcePath).toLowerCase() === '.md') {
          throw new Error(`refusing backup because Markdown contains possible secret material: ${relativePath}`);
        }
        excludedSensitive.push({ path: relativePath, findings });
        continue;
      }
      const destination = assertContained(
        path.join(staging, 'vault'),
        path.join(staging, 'vault', relativePath),
        'backup destination',
      );
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(sourcePath, destination);
      try {
        fs.chmodSync(destination, 0o600);
      } catch (_) {
        // Windows ACLs are inherited from the user-owned backup root.
      }
      entries.push({
        path: relativePath,
        size: buffer.length,
        sha256: sha256Buffer(buffer),
      });
    }
    const contentFingerprint = manifestFingerprint(entries);
    const snapshotId = `${stamp}-${contentFingerprint.slice(0, 12)}`;
    const manifest = {
      version: 1,
      snapshotId,
      createdAt: new Date().toISOString(),
      sourceVault: vault,
      contentFingerprint,
      files: entries,
      excludedSensitive,
      legacySchemaBootstrap: Boolean(options.allowLegacySchema && toleratedLegacyErrors.length > 0),
      toleratedLegacyErrors: toleratedLegacyErrors.length,
      exclusions: [...GENERATED_BACKUP_EXCLUSIONS],
      purgedMemoryIdHashes: [],
    };
    core.writeUtf8Atomic(
      path.join(staging, BACKUP_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const verification = verifyBackup(staging);
    if (!verification.ok) {
      throw new Error(`staged backup verification failed: ${verification.errors.join('; ')}`);
    }
    const destination = assertContained(backupRoot, path.join(backupRoot, snapshotId), 'backup snapshot');
    if (fs.existsSync(destination)) {
      throw new Error(`backup snapshot already exists: ${destination}`);
    }
    fs.renameSync(staging, destination);
    core.writeUtf8Atomic(
      path.join(backupRoot, 'latest.json'),
      `${JSON.stringify({ snapshotId, snapshotPath: destination, createdAt: manifest.createdAt }, null, 2)}\n`,
    );
    return {
      backupRoot,
      snapshotPath: destination,
      snapshotId,
      filesCopied: entries.length,
      excludedSensitive,
      legacySchemaBootstrap: manifest.legacySchemaBootstrap,
      toleratedLegacyErrors: manifest.toleratedLegacyErrors,
      contentFingerprint,
      verification: verifyBackup(destination),
    };
  } catch (error) {
    if (fs.existsSync(staging)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
}

function restoreTest(options = {}) {
  const snapshotPath = path.resolve(options.snapshotPath || '');
  const verification = verifyBackup(snapshotPath);
  if (!verification.ok) {
    throw new Error(`backup verification failed: ${verification.errors.join('; ')}`);
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-memory-restore-test-'));
  const restoredVault = path.join(temporaryRoot, 'vault');
  try {
    fs.cpSync(path.join(snapshotPath, 'vault'), restoredVault, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const restoredIndex = path.join(restoredVault, 'INDEX.md');
    if (!fs.existsSync(restoredIndex)) {
      core.writeUtf8Atomic(
        restoredIndex,
        '# 记忆索引\n\n<!-- BEGIN GENERATED MEMORY INDEX -->\nempty\n<!-- END GENERATED MEMORY INDEX -->\n',
      );
    }
    const maintenance = core.maintainVault(restoredVault, { memoryRoot: options.memoryRoot });
    const validation = core.validateVault(restoredVault, { memoryRoot: options.memoryRoot });
    const benchmark = core.runBenchmark({
      vault: restoredVault,
      memoryRoot: options.memoryRoot,
      cases: path.join(restoredVault, 'Meta', 'retrieval-benchmark.json'),
    });
    return {
      ok: maintenance.ok && validation.ok && benchmark.passedCases === benchmark.totalCases,
      isolated: true,
      productionVaultUntouched: true,
      snapshotPath,
      verification,
      maintenance: {
        ok: maintenance.ok,
        reconciliationOk: maintenance.reconciliation.ok,
      },
      validation: {
        ok: validation.ok,
        errors: validation.errors,
        warnings: validation.warnings,
        filesChecked: validation.filesChecked,
        topicNotes: validation.topicNotes,
        archivedNotes: validation.archivedNotes,
      },
      benchmark: {
        passedCases: benchmark.passedCases,
        totalCases: benchmark.totalCases,
        precisionAtK: benchmark.precisionAtK,
        recallAtK: benchmark.recallAtK,
        mrr: benchmark.mrr,
        noHitAccuracy: benchmark.noHitAccuracy,
        forbiddenHitCases: benchmark.forbiddenHitCases,
      },
    };
  } finally {
    if (temporaryRoot.startsWith(path.join(os.tmpdir(), 'obsidian-memory-restore-test-'))) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function listSnapshotPaths(backupRoot) {
  const root = resolveBackupRoot(backupRoot);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(root, entry.name))
    .filter((snapshotPath) => fs.existsSync(path.join(snapshotPath, BACKUP_MANIFEST)))
    .sort();
}

function inspectMemoryInBackups(backupRoot, memoryId) {
  const occurrences = [];
  const references = [];
  for (const snapshotPath of listSnapshotPaths(backupRoot)) {
    const { manifest } = readManifest(snapshotPath);
    for (const entry of manifest.files || []) {
      if (path.extname(entry.path).toLowerCase() !== '.md') {
        continue;
      }
      const filePath = path.join(snapshotPath, 'vault', entry.path);
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const content = core.readUtf8(filePath);
      const frontmatter = core.parseFrontmatter(content);
      if (String(frontmatter.data.memory_id || '') === memoryId) {
        occurrences.push({ snapshotPath, relativePath: entry.path });
      } else if (content.includes(memoryId)) {
        references.push({ snapshotPath, relativePath: entry.path });
      }
    }
  }
  return { occurrences, references };
}

function purgeMemoryFromBackups(backupRoot, memoryId) {
  const root = resolveBackupRoot(backupRoot);
  const inspected = inspectMemoryInBackups(root, memoryId);
  if (inspected.references.length > 0) {
    throw new Error(
      `backup notes still reference memory_id '${memoryId}': ${inspected.references.map((item) => item.relativePath).join(', ')}`,
    );
  }
  const grouped = new Map();
  for (const occurrence of inspected.occurrences) {
    if (!grouped.has(occurrence.snapshotPath)) {
      grouped.set(occurrence.snapshotPath, []);
    }
    grouped.get(occurrence.snapshotPath).push(occurrence.relativePath);
  }
  const purged = [];
  for (const [snapshotPath, relativePaths] of grouped.entries()) {
    const { manifestPath, manifest } = readManifest(snapshotPath);
    for (const relativePath of relativePaths) {
      const filePath = assertContained(
        path.join(snapshotPath, 'vault'),
        path.join(snapshotPath, 'vault', relativePath),
        'backup purge target',
      );
      fs.unlinkSync(filePath);
      purged.push({ snapshotPath, relativePath });
    }
    const removed = new Set(relativePaths.map(normalizeRelative));
    manifest.files = (manifest.files || []).filter((entry) => !removed.has(normalizeRelative(entry.path)));
    manifest.contentFingerprint = manifestFingerprint(manifest.files);
    manifest.purgedMemoryIdHashes = [
      ...(manifest.purgedMemoryIdHashes || []),
      {
        sha256: sha256Buffer(memoryId),
        purgedAt: new Date().toISOString(),
      },
    ];
    core.writeUtf8Atomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const verification = verifyBackup(snapshotPath);
    if (!verification.ok) {
      throw new Error(`backup failed verification after purge: ${verification.errors.join('; ')}`);
    }
  }
  return { backupRoot: root, purged, references: [] };
}

function currentVaultReferences(vault, target) {
  const targetLink = normalizeRelative(target.relativePath).replace(/\.md$/i, '');
  const references = [];
  for (const filePath of core.walkMarkdown(vault, { includeArchive: true })) {
    if (path.resolve(filePath) === path.resolve(target.filePath)) {
      continue;
    }
    const relativePath = normalizeRelative(path.relative(vault, filePath));
    if (GENERATED_BACKUP_EXCLUSIONS.has(relativePath)) {
      continue;
    }
    const content = core.readUtf8(filePath);
    if (content.includes(target.frontmatter.data.memory_id) || content.includes(`[[${targetLink}`)) {
      references.push(relativePath);
    }
  }
  return references;
}

function hardDeleteMemory(options = {}) {
  const vault = core.resolveVault(options.vault);
  const backupRoot = resolveBackupRoot(options.backupRoot);
  const memoryId = String(options.memoryId || '').trim();
  const reason = String(options.reason || '').trim();
  if (!reason) {
    throw new Error('hard-delete requires --reason');
  }
  if (core.findSecretFindings(reason).length > 0) {
    throw new Error('hard-delete reason contains possible secret material');
  }
  const target = core.findMemoryById(vault, memoryId);
  const references = currentVaultReferences(vault, target);
  const backupInspection = inspectMemoryInBackups(backupRoot, memoryId);
  const preview = {
    applied: false,
    dryRun: true,
    memoryId,
    relativePath: normalizeRelative(target.relativePath),
    currentReferences: references,
    backupOccurrences: backupInspection.occurrences,
    backupReferences: backupInspection.references,
    confirmationRequired: memoryId,
  };
  if (String(options.confirm || '') !== memoryId) {
    return preview;
  }
  if (references.length > 0 || backupInspection.references.length > 0) {
    throw new Error('hard-delete refused because other durable notes still reference the target');
  }
  const backupPurge = purgeMemoryFromBackups(backupRoot, memoryId);
  fs.unlinkSync(target.filePath);
  const auditPath = path.join(vault, 'Meta', 'HARD_DELETE_AUDIT.jsonl');
  fs.appendFileSync(auditPath, `${JSON.stringify({
    deletedAt: new Date().toISOString(),
    memoryIdSha256: sha256Buffer(memoryId),
    reasonSha256: sha256Buffer(reason),
    backupsPurged: backupPurge.purged.length,
  })}\n`, 'utf8');
  const maintenance = core.maintainVault(vault, { memoryRoot: options.memoryRoot });
  let stillPresent = false;
  try {
    core.findMemoryById(vault, memoryId);
    stillPresent = true;
  } catch (_) {
    stillPresent = false;
  }
  const remainingBackup = inspectMemoryInBackups(backupRoot, memoryId);
  if (stillPresent || remainingBackup.occurrences.length > 0 || remainingBackup.references.length > 0) {
    throw new Error('hard-delete postcondition failed: target remains in current Vault or managed backups');
  }
  return {
    ...preview,
    applied: true,
    dryRun: false,
    backupPurge,
    auditPath,
    maintenance,
    postcondition: 'target absent from current Vault and managed backups',
  };
}

module.exports = {
  DEFAULT_BACKUP_ROOT,
  createBackup,
  hardDeleteMemory,
  inspectMemoryInBackups,
  listSnapshotPaths,
  purgeMemoryFromBackups,
  resolveBackupRoot,
  restoreTest,
  verifyBackup,
};
