'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_VAULT = process.env.CODEX_OBSIDIAN_MEMORY_VAULT || 'F:\\Obsidian';
const DEFAULT_BUILTIN_MEMORY_ROOT = process.env.CODEX_BUILTIN_MEMORY_ROOT
  || path.join(os.homedir(), '.codex', 'memories');
const ALLOWED_STATUSES = new Set([
  'candidate',
  'current',
  'verified',
  'deprecated',
  'archived',
]);
const HISTORICAL_STATUSES = new Set([
  'deprecated',
  'archived',
]);
const ALLOWED_NATIVE_MEMORY_RELATIONS = new Set([
  'absent',
  'extends',
  'corrects',
]);
const ALLOWED_SCOPE_KINDS = new Set([
  'project',
  'cross-project',
]);
const TOPIC_DIRECTORIES = new Set([
  'Cross-Project',
  'Patterns',
  'Projects',
  'Domains',
  'Evidence',
  'Logs',
  'Inbox',
]);
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.obsidian',
  '.tools',
  '.trash',
  'node_modules',
]);
const CORE_FILES = [
  'AGENTS.md',
  'INDEX.md',
  'CURRENT_STATE.md',
  'VERIFIED_RULES.md',
  'DECISIONS.md',
  'ERRORS_AND_FIXES.md',
  'INBOX.md',
  path.join('Meta', 'SCHEMA.md'),
  path.join('Meta', 'SYSTEM_STATE.md'),
];
const GENERATED_INDEX_START = '<!-- BEGIN GENERATED MEMORY INDEX -->';
const GENERATED_INDEX_END = '<!-- END GENERATED MEMORY INDEX -->';
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BUILTIN_MEMORY_FILE_BYTES = 8 * 1024 * 1024;
const MIN_CROSS_PROJECT_SCORE = 16;
const BUILTIN_MEMORY_FILES = [
  'memory_summary.md',
  'MEMORY.md',
];
const BENCHMARK_PATH_FIELDS = [
  'relevant_paths',
  'required_paths',
  'forbidden_paths',
];

const COMMON_TERMS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'before',
  'but',
  'can',
  'candidate',
  'current',
  'deprecated',
  'archived',
  'status',
  'scope',
  'scope_kind',
  'applies_to',
  'boundary',
  'evidence',
  'source',
  'benchmark',
  'codex',
  'for',
  'from',
  'have',
  'into',
  'not',
  'obsidian',
  'that',
  'the',
  'this',
  'use',
  'with',
  'check',
  'code',
  'continue',
  'desktop',
  'failed',
  'failure',
  'file',
  'fix',
  'issue',
  'myozi',
  'project',
  'review',
  'test',
  'testing',
  'tests',
  'unit',
  'users',
  'verify',
  'work',
  '一个',
  '什么',
  '以及',
  '但是',
  '使用',
  '如何',
  '已经',
  '我们',
  '我的',
  '插件',
  '是否',
  '这个',
  '进行',
  '需要',
]);

// These phrases describe the act of working rather than the durable subject.
// Remove them before generating overlapping Han n-grams so generic prompts do
// not pull unrelated cross-project notes merely because both mention testing.
const GENERIC_QUERY_PHRASES = /一个|普通|单元测试|自动测试|测试|失败|修复|修好|继续|检查|审查|项目|代码|文件|问题|边界|验证|回归|记忆库|记忆|候选|状态|证据|范围|基准|治理/g;

const SECRET_PATTERNS = [
  {
    name: 'private-key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  },
  {
    name: 'openai-style-key',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: 'github-token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    name: 'gitlab-token',
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: 'slack-token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    name: 'credential-url',
    regex: /\b(?:amqps?|https?|mariadb|mongodb(?:\+srv)?|mysql|postgres(?:ql)?|redis):\/\/[^\s:/@]+:[^\s/@]+@/i,
  },
  {
    name: 'aws-access-key',
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: 'bearer-token',
    regex: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  },
  {
    name: 'assigned-secret',
    regex: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|aws[_-]?secret[_-]?access[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/i,
  },
];

function resolveVault(vault) {
  return path.resolve(vault || DEFAULT_VAULT);
}

function resolveBuiltInMemoryRoot(memoryRoot) {
  return path.resolve(memoryRoot || DEFAULT_BUILTIN_MEMORY_ROOT);
}

function localDate(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}

function writeUtf8Atomic(filePath, content) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) {
      throw error;
    }
    fs.copyFileSync(tempPath, filePath);
    fs.unlinkSync(tempPath);
  }
}

function walkMarkdown(vault, options = {}) {
  const root = resolveVault(vault);
  const includeArchive = Boolean(options.includeArchive);
  if (!fs.existsSync(root)) {
    return [];
  }

  const output = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        if (!includeArchive && entry.name === 'Archive') {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        output.push(fullPath);
      }
    }
  }
  return output.sort((left, right) => left.localeCompare(right));
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') {
    return { data: {}, bodyStartLine: 1 };
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === -1) {
    return { data: {}, bodyStartLine: 1, malformed: true };
  }

  const data = {};
  let activeArrayKey = null;
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index];
    const arrayMatch = line.match(/^\s*-\s+(.+?)\s*$/);
    if (arrayMatch && activeArrayKey) {
      data[activeArrayKey].push(unquote(arrayMatch[1]));
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!keyMatch) {
      activeArrayKey = null;
      continue;
    }
    const [, key, rawValue] = keyMatch;
    if (rawValue === '') {
      data[key] = [];
      activeArrayKey = key;
    } else {
      data[key] = unquote(rawValue);
      activeArrayKey = null;
    }
  }
  return { data, bodyStartLine: closingIndex + 2, malformed: false };
}

function extractTitle(content, fallback) {
  const match = content.match(/^#\s+(.+?)\s*$/m);
  return match ? match[1].trim() : fallback;
}

function addTerm(terms, term) {
  const normalized = term.toLocaleLowerCase().trim();
  if (
    normalized.length < 2
    || COMMON_TERMS.has(normalized)
    || terms.includes(normalized)
  ) {
    return;
  }
  terms.push(normalized);
}

function tokenize(query) {
  const normalized = String(query || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(GENERIC_QUERY_PHRASES, ' ');
  const terms = [];

  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_.:/\\-]{1,}/g)) {
    addTerm(terms, match[0]);
    for (const part of match[0].split(/[_.:/\\-]+/)) {
      addTerm(terms, part);
    }
  }

  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const characters = Array.from(match[0]);
    if (characters.length <= 8) {
      addTerm(terms, match[0]);
    }
    for (const width of [2, 3, 4]) {
      if (terms.length >= 100 || characters.length < width) {
        break;
      }
      for (let index = 0; index <= characters.length - width; index += 1) {
        addTerm(terms, characters.slice(index, index + width).join(''));
        if (terms.length >= 100) {
          break;
        }
      }
    }
  }
  return terms.slice(0, 100);
}

function countOccurrences(haystack, needle, limit = 6) {
  let count = 0;
  let offset = 0;
  while (count < limit) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) {
      break;
    }
    count += 1;
    offset = index + Math.max(needle.length, 1);
  }
  return count;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termPattern(term) {
  if (!/^[a-z0-9]+$/.test(term)) {
    return null;
  }
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?=$|[^a-z0-9])`, 'g');
}

function includesTerm(haystack, term) {
  const pattern = termPattern(term);
  return pattern ? pattern.test(haystack) : haystack.includes(term);
}

function countTermOccurrences(haystack, term, limit = 6) {
  const pattern = termPattern(term);
  if (!pattern) {
    return countOccurrences(haystack, term, limit);
  }
  let count = 0;
  while (count < limit && pattern.exec(haystack)) {
    count += 1;
  }
  return count;
}

function asList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  const scalar = String(value || '').trim();
  if (!scalar || scalar === '[]') {
    return [];
  }
  return scalar.split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeApplicability(value) {
  return String(value || '').trim().replace(/^cwd\s*=\s*/i, '');
}

function isPathLike(value) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value);
}

function scopeAllowsContext(frontmatterData, options = {}) {
  const scopeKind = String(frontmatterData.scope_kind || '').toLocaleLowerCase();
  if (scopeKind !== 'project' || options.includeAllProjects) {
    return true;
  }

  const appliesTo = asList(frontmatterData.applies_to);
  if (appliesTo.length === 0) {
    return false;
  }

  const query = String(options.query || '').normalize('NFKC').toLocaleLowerCase();
  const cwd = String(options.cwd || '').trim();
  const normalizedCwd = cwd ? path.resolve(cwd).toLocaleLowerCase() : '';
  const cwdBaseName = normalizedCwd
    ? path.basename(normalizedCwd).toLocaleLowerCase()
    : '';

  return appliesTo.some((entry) => {
    const applicability = normalizeApplicability(entry);
    const lower = applicability.normalize('NFKC').toLocaleLowerCase();
    if (!lower) {
      return false;
    }
    if (isPathLike(applicability)) {
      const target = path.resolve(applicability).toLocaleLowerCase();
      const pathMatch = normalizedCwd === target
        || normalizedCwd.startsWith(`${target}${path.sep.toLocaleLowerCase()}`);
      if (pathMatch) {
        return true;
      }
      const targetBaseName = path.basename(target).toLocaleLowerCase();
      return targetBaseName.length >= 3 && query.includes(targetBaseName);
    }
    return lower === cwdBaseName || (lower.length >= 3 && query.includes(lower));
  });
}

function statusWeight(status) {
  switch (status) {
    case 'verified':
      return 10;
    case 'current':
      return 4;
    case 'candidate':
      return -2;
    case 'deprecated':
      return -18;
    case 'archived':
      return -24;
    default:
      return 0;
  }
}

function bestExcerpt(content, terms, bodyStartLine = 1, radius = 1) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const bodyStartIndex = Math.max(0, bodyStartLine - 1);
  let bestIndex = -1;
  let bestScore = -1;

  for (let index = bodyStartIndex; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || /^#{1,6}\s+/.test(trimmed)) {
      continue;
    }
    const lower = lines[index].toLocaleLowerCase();
    let score = 0;
    for (const term of terms) {
      if (includesTerm(lower, term)) {
        score += term.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  if (bestIndex === -1) {
    bestIndex = lines.findIndex((line, index) => (
      index >= bodyStartIndex
      && line.trim()
      && !/^#{1,6}\s+/.test(line.trim())
    ));
  }
  if (bestIndex === -1) {
    bestIndex = bodyStartIndex;
  }

  const start = Math.max(bodyStartIndex, bestIndex - radius);
  const end = Math.min(lines.length, bestIndex + radius + 1);
  const excerpt = lines
    .slice(start, end)
    .map((line, offset) => `${start + offset + 1}: ${line}`)
    .join('\n');
  return excerpt.length > 600 ? `${excerpt.slice(0, 600)}…` : excerpt;
}

function searchMemory(options = {}) {
  const vault = resolveVault(options.vault);
  const query = String(options.query || '').trim();
  const limit = Math.max(1, Math.min(Number(options.limit) || 6, 20));
  const includeCore = Boolean(options.includeCore);
  const terms = tokenize(query);
  if (!query || terms.length === 0 || !fs.existsSync(vault)) {
    return [];
  }

  const results = [];
  for (const filePath of walkMarkdown(vault, {
    includeArchive: Boolean(options.includeArchive),
  })) {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SEARCH_FILE_BYTES) {
      continue;
    }
    const content = readUtf8(filePath);
    const frontmatter = parseFrontmatter(content);
    const relativePath = path.relative(vault, filePath);
    const status = String(frontmatter.data.status || 'unknown').toLocaleLowerCase();
    if (
      !includeCore
      && !isTopicNote(relativePath)
      && !(options.includeArchive && isArchiveNote(relativePath))
    ) {
      continue;
    }
    if (!options.includeArchive && HISTORICAL_STATUSES.has(status)) {
      continue;
    }
    if (!scopeAllowsContext(frontmatter.data, {
      query,
      cwd: options.cwd,
      includeAllProjects: Boolean(options.includeAllProjects),
    })) {
      continue;
    }
    const title = extractTitle(content, path.basename(filePath, '.md'));
    const lowerContent = content.toLocaleLowerCase();
    const lowerPath = relativePath.toLocaleLowerCase();
    const lowerTitle = title.toLocaleLowerCase();
    const metadataText = Object.values(frontmatter.data)
      .flat()
      .join(' ')
      .toLocaleLowerCase();

    let score = statusWeight(status);
    let matchedTerms = 0;
    let strongAnchorMatched = false;
    for (const term of terms) {
      let termScore = 0;
      const pathMatch = includesTerm(lowerPath, term);
      const titleMatch = includesTerm(lowerTitle, term);
      if (pathMatch) {
        termScore += 12;
      }
      if (titleMatch) {
        termScore += 10;
      }
      if (includesTerm(metadataText, term)) {
        termScore += 6;
      }
      termScore += Math.min(countTermOccurrences(lowerContent, term), 5) * 2;
      if (termScore > 0) {
        matchedTerms += 1;
        score += termScore;
        if (
          /^[a-z0-9][a-z0-9_.:/\\-]{4,}$/i.test(term)
          && (pathMatch || titleMatch)
        ) {
          strongAnchorMatched = true;
        }
      }
    }

    if (matchedTerms === 0 || score <= 0) {
      continue;
    }
    const scopeKind = String(frontmatter.data.scope_kind || '').toLocaleLowerCase();
    const minimumCrossProjectMatches = terms.length >= 12 ? 3 : (terms.length >= 4 ? 2 : 1);
    if (
      scopeKind === 'cross-project'
      && matchedTerms < minimumCrossProjectMatches
      && !strongAnchorMatched
    ) {
      continue;
    }
    if (scopeKind === 'cross-project' && score < MIN_CROSS_PROJECT_SCORE) {
      continue;
    }
    if (CORE_FILES.includes(relativePath)) {
      score += 3;
    }

    results.push({
      filePath,
      relativePath,
      title,
      status,
      scope: String(frontmatter.data.scope || ''),
      scopeKind,
      appliesTo: asList(frontmatter.data.applies_to),
      boundary: String(frontmatter.data.boundary || ''),
      source: String(frontmatter.data.source || ''),
      evidence: String(frontmatter.data.evidence || ''),
      updatedAt: String(frontmatter.data.updated_at || ''),
      verifiedAt: String(frontmatter.data.verified_at || ''),
      score,
      excerpt: bestExcerpt(content, terms, frontmatter.bodyStartLine),
      modifiedAt: stat.mtime.toISOString(),
    });
  }

  return results
    .sort((left, right) => (
      right.score - left.score
      || left.relativePath.localeCompare(right.relativePath)
    ))
    .slice(0, limit);
}

function builtInMemoryFiles(memoryRoot) {
  const root = resolveBuiltInMemoryRoot(memoryRoot);
  return BUILTIN_MEMORY_FILES
    .map((relativePath) => path.join(root, relativePath))
    .filter((filePath) => {
      if (!fs.existsSync(filePath)) {
        return false;
      }
      const stat = fs.statSync(filePath);
      return stat.isFile() && stat.size <= MAX_BUILTIN_MEMORY_FILE_BYTES;
    });
}

function compactForComparison(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function significantTerms(text) {
  return tokenize(text)
    .filter((term) => Array.from(term).length >= 3)
    .slice(0, 60);
}

function searchBuiltInMemory(options = {}) {
  const query = String(options.query || '').trim();
  const limit = Math.max(1, Math.min(Number(options.limit) || 5, 20));
  const terms = significantTerms(query);
  if (!query || terms.length === 0) {
    return [];
  }

  const root = resolveBuiltInMemoryRoot(options.memoryRoot);
  const results = [];
  for (const filePath of builtInMemoryFiles(root)) {
    const content = readUtf8(filePath);
    const lower = content.toLocaleLowerCase();
    let score = 0;
    let matchedTerms = 0;
    for (const term of terms) {
      const occurrences = countOccurrences(lower, term, 8);
      if (occurrences > 0) {
        matchedTerms += 1;
        score += Math.min(occurrences, 5) * Math.max(2, term.length);
      }
    }
    if (matchedTerms === 0) {
      continue;
    }
    results.push({
      filePath,
      relativePath: path.relative(root, filePath),
      score,
      matchedTerms,
      excerpt: redactSecrets(bestExcerpt(content, terms, 1, 3)),
    });
  }
  return results
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function checkNativeMemoryOverlap(options = {}) {
  const text = String(options.text || '').trim();
  const files = builtInMemoryFiles(options.memoryRoot);
  if (!text || files.length === 0) {
    return {
      memoryRoot: resolveBuiltInMemoryRoot(options.memoryRoot),
      available: files.length > 0,
      filesChecked: files.length,
      likelyDuplicate: false,
      exactDuplicate: false,
      termCoverage: 0,
      matchedTerms: 0,
      totalTerms: 0,
      matches: [],
    };
  }

  const combined = files.map((filePath) => readUtf8(filePath)).join('\n');
  const compactCandidate = compactForComparison(text);
  const compactBuiltIn = compactForComparison(combined);
  const exactDuplicate = compactCandidate.length >= 24
    && compactBuiltIn.includes(compactCandidate);
  const terms = significantTerms(text);
  const lowerBuiltIn = combined.toLocaleLowerCase();
  const matchedTerms = terms.filter((term) => lowerBuiltIn.includes(term)).length;
  const termCoverage = terms.length > 0 ? matchedTerms / terms.length : 0;
  const likelyDuplicate = exactDuplicate
    || (terms.length >= 5 && matchedTerms >= 5 && termCoverage >= 0.82);

  return {
    memoryRoot: resolveBuiltInMemoryRoot(options.memoryRoot),
    available: true,
    filesChecked: files.length,
    likelyDuplicate,
    exactDuplicate,
    termCoverage,
    matchedTerms,
    totalTerms: terms.length,
    matches: searchBuiltInMemory({
      query: text,
      memoryRoot: options.memoryRoot,
      limit: options.limit,
    }),
  };
}

function checkNovelty(options = {}) {
  const text = String(options.text || '').trim();
  return {
    nativeMemory: checkNativeMemoryOverlap({
      text,
      memoryRoot: options.memoryRoot,
      limit: options.limit,
    }),
    vaultMatches: searchMemory({
      vault: options.vault,
      query: text,
      cwd: options.cwd,
      limit: options.limit,
      includeAllProjects: true,
    }),
  };
}

function redactSecrets(text) {
  let output = String(text || '');
  for (const pattern of SECRET_PATTERNS) {
    const globalFlags = pattern.regex.flags.includes('g')
      ? pattern.regex.flags
      : `${pattern.regex.flags}g`;
    output = output.replace(new RegExp(pattern.regex.source, globalFlags), '[REDACTED]');
  }
  return output;
}

function truncateInline(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function formatSearchResults(results, vault, options = {}) {
  if (!results.length) {
    return '未找到匹配且范围允许的 Obsidian 记忆。';
  }
  const root = resolveVault(vault);
  const compact = Boolean(options.compact);
  const entries = results.map((result, index) => {
    const absolutePath = path.join(root, result.relativePath);
    const checkedAt = result.verifiedAt || result.updatedAt;
    const metadata = compact
      ? [
        `status=${result.status}`,
        result.scopeKind ? `scope_kind=${result.scopeKind}` : '',
        checkedAt ? `${result.verifiedAt ? 'verified_at' : 'updated_at'}=${checkedAt}` : '',
        result.appliesTo.length
          ? `applies_to=${truncateInline(result.appliesTo.join('|'), 90)}`
          : '',
        result.boundary ? `boundary=${truncateInline(result.boundary, 120)}` : '',
        result.source ? `source=${truncateInline(result.source, 100)}` : 'source=not-declared',
        result.evidence
          ? `evidence=${truncateInline(result.evidence, 100)}`
          : 'evidence=not-declared',
      ].filter(Boolean).join(', ')
      : [
        `status=${result.status}`,
        result.scope ? `scope=${result.scope}` : '',
        result.scopeKind ? `scope_kind=${result.scopeKind}` : '',
        result.appliesTo.length ? `applies_to=${result.appliesTo.join('|')}` : '',
        result.boundary ? `boundary=${result.boundary}` : '',
        result.source ? `source=${result.source}` : '',
        result.evidence ? `evidence=${result.evidence}` : '',
        result.updatedAt ? `updated_at=${result.updatedAt}` : '',
        result.verifiedAt ? `verified_at=${result.verifiedAt}` : '',
        `score=${result.score}`,
      ].filter(Boolean).join(', ');
    const excerpt = compact ? truncateInline(result.excerpt, 180) : result.excerpt;
    return [
      `${index + 1}. ${compact ? truncateInline(result.title, 120) : result.title}`,
      `   file: ${absolutePath}`,
      `   ${metadata}`,
      excerpt.split('\n').map((line) => `   ${line}`).join('\n'),
    ].join('\n');
  });

  const requestedBudget = Number(options.charBudget);
  if (!Object.prototype.hasOwnProperty.call(options, 'charBudget')) {
    return entries.join('\n\n');
  }
  if (!Number.isFinite(requestedBudget) || requestedBudget <= 0) {
    return '';
  }
  const budget = Math.floor(requestedBudget);
  const included = [];
  for (const entry of entries) {
    const candidate = [...included, entry].join('\n\n');
    if (candidate.length > budget) {
      break;
    }
    included.push(entry);
  }
  if (included.length === 0) {
    return '命中结果超出自动注入预算；请按需运行显式 search 读取。'.slice(0, budget);
  }
  let output = included.join('\n\n');
  const omitted = entries.length - included.length;
  if (omitted > 0) {
    const notice = `\n\n受上下文预算限制，省略 ${omitted} 条较低排名命中；可按需运行显式 search。`;
    if (output.length + notice.length <= budget) {
      output += notice;
    }
  }
  return output;
}

function findSecretFindings(content) {
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(content)) {
      findings.push(pattern.name);
    }
  }
  return findings;
}

function isTopicNote(relativePath) {
  const firstSegment = relativePath.split(path.sep)[0];
  return TOPIC_DIRECTORIES.has(firstSegment);
}

function isArchiveNote(relativePath) {
  return relativePath.split(path.sep)[0] === 'Archive';
}

function normalizeBenchmarkReference(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/]+/g, path.sep);
}

function validateBenchmarkFixture(vault, casesPath) {
  const root = resolveVault(vault);
  const resolvedCasesPath = path.resolve(
    casesPath || path.join(root, 'Meta', 'retrieval-benchmark.json'),
  );
  const result = {
    casesPath: resolvedCasesPath,
    exists: fs.existsSync(resolvedCasesPath),
    document: null,
    errors: [],
  };
  if (!result.exists) {
    return result;
  }

  try {
    result.document = JSON.parse(readUtf8(resolvedCasesPath));
  } catch (error) {
    result.errors.push(`invalid JSON: ${error.message}`);
    return result;
  }
  if (!Array.isArray(result.document.cases) || result.document.cases.length === 0) {
    result.errors.push('must contain a non-empty cases array');
    return result;
  }

  const ids = new Set();
  for (const [index, testCase] of result.document.cases.entries()) {
    if (!testCase || typeof testCase !== 'object' || Array.isArray(testCase)) {
      result.errors.push(`case ${index + 1} must be an object`);
      continue;
    }
    const id = String(testCase.id || `case-${index + 1}`).trim();
    if (ids.has(id)) {
      result.errors.push(`case '${id}' has a duplicate id`);
    }
    ids.add(id);
    if (!String(testCase.query || '').trim()) {
      result.errors.push(`case '${id}' is missing query`);
    }

    const normalizedByField = {};
    for (const field of BENCHMARK_PATH_FIELDS) {
      const values = testCase[field] === undefined ? [] : testCase[field];
      if (!Array.isArray(values)) {
        result.errors.push(`case '${id}' field '${field}' must be an array`);
        normalizedByField[field] = [];
        continue;
      }
      normalizedByField[field] = [];
      for (const [pathIndex, rawValue] of values.entries()) {
        if (typeof rawValue !== 'string' || !rawValue.trim()) {
          result.errors.push(
            `case '${id}' field '${field}' entry ${pathIndex + 1} must be a non-empty string`,
          );
          continue;
        }
        const normalized = normalizeBenchmarkReference(rawValue);
        normalizedByField[field].push(normalized.toLocaleLowerCase());
        if (path.isAbsolute(normalized)) {
          result.errors.push(`case '${id}' field '${field}' must use a vault-relative path: ${rawValue}`);
          continue;
        }
        const targetPath = path.resolve(root, normalized);
        const relativeToVault = path.relative(root, targetPath);
        if (
          relativeToVault === '..'
          || relativeToVault.startsWith(`..${path.sep}`)
          || path.isAbsolute(relativeToVault)
        ) {
          result.errors.push(`case '${id}' field '${field}' escapes the vault: ${rawValue}`);
          continue;
        }
        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
          result.errors.push(`case '${id}' field '${field}' path does not exist: ${rawValue}`);
        }
      }
    }

    const relevant = new Set(normalizedByField.relevant_paths);
    const required = normalizedByField.required_paths.length > 0
      ? normalizedByField.required_paths
      : normalizedByField.relevant_paths;
    const forbidden = new Set(normalizedByField.forbidden_paths);
    for (const requiredPath of required) {
      if (!relevant.has(requiredPath)) {
        result.errors.push(
          `case '${id}' required path is not listed in relevant_paths: ${requiredPath}`,
        );
      }
      if (
        !testCase.include_archive
        && requiredPath.split(path.sep)[0] === 'archive'
      ) {
        result.errors.push(
          `case '${id}' requires an Archive path without include_archive=true: ${requiredPath}`,
        );
      }
    }
    for (const relevantPath of relevant) {
      if (forbidden.has(relevantPath)) {
        result.errors.push(
          `case '${id}' lists the same path as relevant and forbidden: ${relevantPath}`,
        );
      }
    }
    if (testCase.expect_no_hit && (relevant.size > 0 || required.length > 0)) {
      result.errors.push(`case '${id}' expect_no_hit cannot declare relevant or required paths`);
    }
  }
  return result;
}

function validateVault(vault, options = {}) {
  const root = resolveVault(vault);
  const builtInMemoryRoot = resolveBuiltInMemoryRoot(options.memoryRoot);
  const availableBuiltInMemoryFiles = builtInMemoryFiles(builtInMemoryRoot);
  const errors = [];
  const warnings = [];
  const statusCounts = {
    candidate: 0,
    current: 0,
    verified: 0,
    deprecated: 0,
    archived: 0,
    unknown: 0,
  };
  const topicStatusCounts = {
    candidate: 0,
    current: 0,
    verified: 0,
    deprecated: 0,
    archived: 0,
    unknown: 0,
  };
  const archiveStatusCounts = {
    candidate: 0,
    current: 0,
    verified: 0,
    deprecated: 0,
    archived: 0,
    unknown: 0,
  };
  const memoryIds = new Map();

  if (!fs.existsSync(root)) {
    return {
      vault: root,
      ok: false,
      errors: [`Vault does not exist: ${root}`],
      warnings,
      filesChecked: 0,
      topicNotes: 0,
      archivedNotes: 0,
      statusCounts,
      topicStatusCounts,
      archiveStatusCounts,
      builtInMemoryRoot,
      builtInMemoryAvailable: availableBuiltInMemoryFiles.length > 0,
      builtInMemoryFilesChecked: availableBuiltInMemoryFiles.length,
      generatedAt: new Date().toISOString(),
    };
  }

  if (availableBuiltInMemoryFiles.length === 0) {
    warnings.push(
      `Codex built-in memory baseline is unavailable at ${builtInMemoryRoot}; new captures must fail closed.`,
    );
  }

  for (const relativePath of CORE_FILES) {
    if (!fs.existsSync(path.join(root, relativePath))) {
      errors.push(`Missing required file: ${relativePath}`);
    }
  }

  const indexPath = path.join(root, 'INDEX.md');
  if (fs.existsSync(indexPath)) {
    const indexContent = readUtf8(indexPath);
    if (
      !indexContent.includes(GENERATED_INDEX_START)
      || !indexContent.includes(GENERATED_INDEX_END)
    ) {
      errors.push('INDEX.md is missing generated-index markers.');
    }
  }

  const communityPluginPath = path.join(root, '.obsidian', 'community-plugins.json');
  if (fs.existsSync(communityPluginPath)) {
    try {
      const enabled = JSON.parse(readUtf8(communityPluginPath));
      if (!Array.isArray(enabled) || !enabled.includes('obsidian-local-rest-api')) {
        warnings.push('obsidian-local-rest-api is not enabled in community-plugins.json.');
      }
    } catch (error) {
      errors.push(`Invalid .obsidian/community-plugins.json: ${error.message}`);
    }
  } else {
    warnings.push('Missing .obsidian/community-plugins.json.');
  }

  const benchmarkFixture = validateBenchmarkFixture(root);
  for (const benchmarkError of benchmarkFixture.errors) {
    errors.push(`Meta/retrieval-benchmark.json: ${benchmarkError}`);
  }

  let topicNotes = 0;
  let archivedNotes = 0;
  const files = walkMarkdown(root, { includeArchive: true });
  for (const filePath of files) {
    const relativePath = path.relative(root, filePath);
    const content = readUtf8(filePath);
    const frontmatter = parseFrontmatter(content);
    const status = String(frontmatter.data.status || 'unknown').toLocaleLowerCase();
    const secretFindings = findSecretFindings(content);

    if (secretFindings.length > 0) {
      errors.push(`${relativePath}: possible secret material (${secretFindings.join(', ')}).`);
    }
    if (frontmatter.malformed) {
      errors.push(`${relativePath}: unclosed YAML frontmatter.`);
    }
    if (Object.prototype.hasOwnProperty.call(statusCounts, status)) {
      statusCounts[status] += 1;
    } else {
      statusCounts.unknown += 1;
    }

    const topicNote = isTopicNote(relativePath);
    const archiveNote = isArchiveNote(relativePath);
    if (!topicNote && !archiveNote) {
      continue;
    }
    if (topicNote) {
      topicNotes += 1;
      if (Object.prototype.hasOwnProperty.call(topicStatusCounts, status)) {
        topicStatusCounts[status] += 1;
      } else {
        topicStatusCounts.unknown += 1;
      }
    } else {
      archivedNotes += 1;
      if (Object.prototype.hasOwnProperty.call(archiveStatusCounts, status)) {
        archiveStatusCounts[status] += 1;
      } else {
        archiveStatusCounts.unknown += 1;
      }
      if (!['archived', 'deprecated'].includes(status)) {
        errors.push(`${relativePath}: Archive/ notes must be archived or deprecated.`);
      }
    }
    const required = [
      'memory_id',
      'type',
      'status',
      'scope',
      'scope_kind',
      'boundary',
      'native_memory_relation',
      'native_memory_checked_at',
      'source',
      'created_at',
      'updated_at',
    ];
    for (const field of required) {
      const value = frontmatter.data[field];
      if (value === undefined || value === '' || Array.isArray(value)) {
        errors.push(`${relativePath}: missing scalar frontmatter field '${field}'.`);
      }
    }
    const scopeKind = String(frontmatter.data.scope_kind || '').toLocaleLowerCase();
    const nativeMemoryRelation = String(
      frontmatter.data.native_memory_relation || '',
    ).toLocaleLowerCase();
    const appliesTo = asList(frontmatter.data.applies_to);
    const firstSegment = relativePath.split(path.sep)[0];

    if (!ALLOWED_SCOPE_KINDS.has(scopeKind)) {
      errors.push(`${relativePath}: invalid scope_kind '${scopeKind}'.`);
    }
    if (!ALLOWED_NATIVE_MEMORY_RELATIONS.has(nativeMemoryRelation)) {
      errors.push(
        `${relativePath}: invalid native_memory_relation '${nativeMemoryRelation}'.`,
      );
    }
    if (appliesTo.length === 0) {
      errors.push(`${relativePath}: missing non-empty 'applies_to'.`);
    }
    if (appliesTo.some((value) => String(value).includes('|'))) {
      errors.push(
        `${relativePath}: each applies_to entry must contain one path or stable id; use separate YAML items instead of '|'.`,
      );
    }
    if (firstSegment === 'Inbox' && status !== 'candidate') {
      errors.push(`${relativePath}: Inbox/ notes must use status 'candidate'.`);
    }
    if (status === 'candidate' && firstSegment !== 'Inbox') {
      errors.push(`${relativePath}: candidate notes must remain in Inbox/.`);
    }
    if (HISTORICAL_STATUSES.has(status) && firstSegment !== 'Archive') {
      errors.push(`${relativePath}: ${status} notes must be moved to Archive/.`);
    }
    if (firstSegment === 'Projects' && scopeKind !== 'project') {
      errors.push(`${relativePath}: Projects/ notes must use scope_kind 'project'.`);
    }
    if (
      ['Cross-Project', 'Patterns', 'Domains'].includes(firstSegment)
      && scopeKind !== 'cross-project'
    ) {
      errors.push(
        `${relativePath}: ${firstSegment}/ notes must use scope_kind 'cross-project'.`,
      );
    }
    if (scopeKind === 'cross-project') {
      const transferability = frontmatter.data.transferability;
      if (!transferability || Array.isArray(transferability)) {
        errors.push(
          `${relativePath}: cross-project note is missing scalar 'transferability'.`,
        );
      }
    }
    if (!ALLOWED_STATUSES.has(status)) {
      errors.push(`${relativePath}: invalid status '${status}'.`);
    }
    if (status === 'verified') {
      for (const field of ['evidence', 'verified_at']) {
        if (!frontmatter.data[field] || Array.isArray(frontmatter.data[field])) {
          errors.push(`${relativePath}: verified note is missing '${field}'.`);
        }
      }
    }
    if (
      relativePath.split(path.sep).slice(0, 2).join('/') === 'Inbox/Auto-Captures'
      && status === 'verified'
    ) {
      errors.push(`${relativePath}: auto-captured notes cannot be verified.`);
    }
    if (
      status === 'deprecated'
      && !frontmatter.data.superseded_by
      && !/替代|supersed/i.test(content)
    ) {
      warnings.push(`${relativePath}: deprecated note has no superseded_by.`);
    }

    const memoryId = String(frontmatter.data.memory_id || '');
    if (memoryId) {
      if (memoryIds.has(memoryId)) {
        errors.push(
          `${relativePath}: duplicate memory_id '${memoryId}' also used by ${memoryIds.get(memoryId)}.`,
        );
      } else {
        memoryIds.set(memoryId, relativePath);
      }
    }

    if (status === 'candidate') {
      const ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
      if (ageMs > 90 * 24 * 60 * 60 * 1000) {
        warnings.push(`${relativePath}: candidate is older than 90 days.`);
      }
    }
  }

  return {
    vault: root,
    ok: errors.length === 0,
    errors,
    warnings,
    filesChecked: files.length,
    topicNotes,
    archivedNotes,
    statusCounts,
    topicStatusCounts,
    archiveStatusCounts,
    builtInMemoryRoot,
    builtInMemoryAvailable: availableBuiltInMemoryFiles.length > 0,
    builtInMemoryFilesChecked: availableBuiltInMemoryFiles.length,
    generatedAt: new Date().toISOString(),
  };
}

function wikilinkFor(relativePath) {
  return relativePath
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '');
}

function rebuildIndex(vault) {
  const root = resolveVault(vault);
  const indexPath = path.join(root, 'INDEX.md');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Missing INDEX.md: ${indexPath}`);
  }

  const notes = [];
  for (const filePath of walkMarkdown(root, { includeArchive: false })) {
    const relativePath = path.relative(root, filePath);
    if (!isTopicNote(relativePath)) {
      continue;
    }
    const content = readUtf8(filePath);
    const frontmatter = parseFrontmatter(content);
    notes.push({
      relativePath,
      title: extractTitle(content, path.basename(filePath, '.md')),
      status: String(frontmatter.data.status || 'unknown'),
      scope: String(frontmatter.data.scope || ''),
      scopeKind: String(frontmatter.data.scope_kind || ''),
      appliesTo: asList(frontmatter.data.applies_to),
      updatedAt: String(frontmatter.data.updated_at || ''),
    });
  }

  const rank = {
    verified: 0,
    current: 1,
    candidate: 2,
    deprecated: 3,
    archived: 4,
    unknown: 5,
  };
  notes.sort((left, right) => (
    (rank[left.status] ?? 9) - (rank[right.status] ?? 9)
    || left.relativePath.localeCompare(right.relativePath)
  ));

  let generated = '尚无主题笔记。';
  if (notes.length > 0) {
    const groups = new Map();
    for (const note of notes) {
      if (!groups.has(note.status)) {
        groups.set(note.status, []);
      }
      groups.get(note.status).push(note);
    }
    generated = Array.from(groups.entries()).map(([status, group]) => {
      const entries = group.map((note) => {
        const details = [
          note.scope ? `scope: ${note.scope}` : '',
          note.scopeKind ? `scope_kind: ${note.scopeKind}` : '',
          note.appliesTo.length ? `applies_to: ${note.appliesTo.join(', ')}` : '',
          note.updatedAt ? `updated: ${note.updatedAt}` : '',
        ].filter(Boolean).join('; ');
        return `- [[${wikilinkFor(note.relativePath)}|${note.title}]]${details ? ` — ${details}` : ''}`;
      }).join('\n');
      return `### ${status}\n\n${entries}`;
    }).join('\n\n');
  }

  const content = readUtf8(indexPath);
  const markerPattern = new RegExp(
    `${GENERATED_INDEX_START}[\\s\\S]*?${GENERATED_INDEX_END}`,
  );
  if (!markerPattern.test(content)) {
    throw new Error('INDEX.md is missing generated-index markers.');
  }
  const replacement = [
    GENERATED_INDEX_START,
    generated,
    GENERATED_INDEX_END,
  ].join('\n');
  const updated = content.replace(markerPattern, replacement);
  if (updated !== content) {
    writeUtf8Atomic(indexPath, updated);
  }
  return { indexedNotes: notes.length, indexPath };
}

function markdownEscape(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function writeHealthReport(vault, report) {
  const root = resolveVault(vault);
  const statusLines = Object.entries(report.statusCounts)
    .map(([status, count]) => `| ${status} | ${count} |`)
    .join('\n');
  const topicStatusLines = Object.entries(report.topicStatusCounts || {})
    .map(([status, count]) => `| ${status} | ${count} |`)
    .join('\n');
  const archiveStatusLines = Object.entries(report.archiveStatusCounts || {})
    .map(([status, count]) => `| ${status} | ${count} |`)
    .join('\n');
  const errorLines = report.errors.length
    ? report.errors.map((item) => `- ${markdownEscape(item)}`).join('\n')
    : '- 无';
  const warningLines = report.warnings.length
    ? report.warnings.map((item) => `- ${markdownEscape(item)}`).join('\n')
    : '- 无';
  const content = `---
type: health-report
status: current
scope: memory-system
source: obsidian-memory-maintenance
updated_at: ${localDate()}
---

# 记忆库健康报告

- 生成时间：${report.generatedAt}
- 总体状态：${report.ok ? '通过' : '失败'}
- 检查 Markdown 文件：${report.filesChecked}
- 主题笔记：${report.topicNotes}
- Archive 笔记：${report.archivedNotes}
- Codex 原生记忆基线：${report.builtInMemoryAvailable
    ? `可用（${report.builtInMemoryFilesChecked} 个文件）`
    : '不可用（新写入将拒绝）'}
- 原生记忆目录：${report.builtInMemoryRoot}

## 可检索主题笔记状态

| 状态 | 数量 |
|---|---:|
${topicStatusLines}

## Archive 笔记状态

| 状态 | 数量 |
|---|---:|
${archiveStatusLines}

## 全部 Markdown 状态

> 包括根级系统账本与 Archive；\`unknown\` 可来自不使用 frontmatter 的 \`AGENTS.md\`，不等于未分类主题记忆。

| 状态 | 数量 |
|---|---:|
${statusLines}

## 错误

${errorLines}

## 警告

${warningLines}
`;
  const reportPath = path.join(root, 'Meta', 'HEALTH.md');
  writeUtf8Atomic(reportPath, content);
  return reportPath;
}

function maintainVault(vault, options = {}) {
  const root = resolveVault(vault);
  const indexResult = rebuildIndex(root);
  const report = validateVault(root, options);
  const healthPath = writeHealthReport(root, report);
  return { ...report, ...indexResult, healthPath };
}

function safeSlug(input) {
  const normalized = String(input || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return normalized || 'memory';
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ''));
}

function yamlList(name, values) {
  const entries = asList(values);
  if (entries.length === 0) {
    return `${name}: []`;
  }
  return `${name}:\n${entries.map((value) => `  - ${yamlScalar(value)}`).join('\n')}`;
}

function findExactVaultDuplicate(vault, summary) {
  const compactSummary = compactForComparison(summary);
  if (compactSummary.length < 24) {
    return null;
  }
  for (const filePath of walkMarkdown(vault, { includeArchive: true })) {
    const relativePath = path.relative(vault, filePath);
    if (!isTopicNote(relativePath) && !isArchiveNote(relativePath)) {
      continue;
    }
    if (compactForComparison(readUtf8(filePath)).includes(compactSummary)) {
      return relativePath;
    }
  }
  return null;
}

function createCandidate(options = {}) {
  const vault = resolveVault(options.vault);
  const title = String(options.title || '').trim();
  const summary = String(options.summary || '').trim();
  const source = String(options.source || '').trim();
  const scope = String(options.scope || '').trim();
  const scopeKind = String(options.scopeKind || '').trim().toLocaleLowerCase();
  const appliesTo = asList(options.appliesTo);
  const boundary = String(options.boundary || '').trim();
  const transferability = String(options.transferability || '').trim();
  const originProjects = asList(options.originProjects);
  const nativeMemoryRelation = String(
    options.nativeMemoryRelation || 'absent',
  ).trim().toLocaleLowerCase();
  const evidence = String(options.evidence || '').trim();
  const tags = String(options.tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  for (const [name, value] of Object.entries({
    title,
    summary,
    source,
    scope,
    'scope-kind': scopeKind,
    boundary,
  })) {
    if (!value) {
      throw new Error(`capture requires --${name}`);
    }
  }
  if (!ALLOWED_SCOPE_KINDS.has(scopeKind)) {
    throw new Error(
      `--scope-kind must be one of: ${Array.from(ALLOWED_SCOPE_KINDS).join(', ')}`,
    );
  }
  if (appliesTo.length === 0) {
    throw new Error('capture requires at least one --applies-to value');
  }
  if (scopeKind === 'cross-project' && !transferability) {
    throw new Error('cross-project capture requires --transferability');
  }
  if (!ALLOWED_NATIVE_MEMORY_RELATIONS.has(nativeMemoryRelation)) {
    throw new Error(
      `--native-memory-relation must be one of: ${
        Array.from(ALLOWED_NATIVE_MEMORY_RELATIONS).join(', ')
      }`,
    );
  }

  const candidateText = [
    title,
    summary,
    source,
    scope,
    scopeKind,
    ...appliesTo,
    boundary,
    transferability,
    ...originProjects,
    evidence,
    ...tags,
  ].join('\n');
  const secretFindings = findSecretFindings(candidateText);
  if (secretFindings.length > 0) {
    throw new Error(`Refusing to store possible secret material: ${secretFindings.join(', ')}`);
  }

  const nativeMemory = checkNativeMemoryOverlap({
    text: summary,
    memoryRoot: options.memoryRoot,
    limit: 5,
  });
  if (!nativeMemory.available) {
    throw new Error(
      `Refusing capture because Codex built-in memory cannot be checked at ${nativeMemory.memoryRoot}`,
    );
  }
  if (nativeMemory.likelyDuplicate && nativeMemoryRelation === 'absent') {
    throw new Error(
      'Refusing capture because the conclusion likely duplicates Codex built-in memory; '
      + 'omit it or explicitly classify the added value as extends/corrects',
    );
  }
  if (
    nativeMemoryRelation !== 'absent'
    && nativeMemory.matches.length === 0
  ) {
    throw new Error(
      `native_memory_relation '${nativeMemoryRelation}' requires a matching built-in memory entry`,
    );
  }

  const vaultDuplicate = findExactVaultDuplicate(vault, summary);
  if (vaultDuplicate) {
    throw new Error(
      `Refusing duplicate capture; update the existing note instead: ${vaultDuplicate}`,
    );
  }

  const date = localDate();
  const digest = crypto
    .createHash('sha256')
    .update(`${title}\n${summary}\n${source}`)
    .digest('hex')
    .slice(0, 10);
  const memoryId = `candidate-${date.replace(/-/g, '')}-${digest}`;
  const baseName = `${date}-${safeSlug(title)}.md`;
  const directory = path.join(vault, 'Inbox');
  fs.mkdirSync(directory, { recursive: true });
  let filePath = path.join(directory, baseName);
  let suffix = 2;
  while (fs.existsSync(filePath)) {
    filePath = path.join(directory, `${date}-${safeSlug(title)}-${suffix}.md`);
    suffix += 1;
  }

  const tagBlock = tags.length
    ? yamlList('tags', tags)
    : 'tags: []';
  const appliesToBlock = yamlList('applies_to', appliesTo);
  const originProjectsBlock = yamlList('origin_projects', originProjects);
  const transferabilityField = transferability
    ? `transferability: ${yamlScalar(transferability)}\n`
    : '';
  const evidenceSection = evidence
    ? `\n## 当前证据\n\n${evidence}\n`
    : '';
  const transferabilitySection = transferability
    ? `\n## 可迁移价值\n\n${transferability}\n`
    : '';
  const content = `---
memory_id: ${memoryId}
type: candidate
status: candidate
scope: ${yamlScalar(scope)}
scope_kind: ${scopeKind}
${appliesToBlock}
boundary: ${yamlScalar(boundary)}
${transferabilityField}${originProjectsBlock}
native_memory_relation: ${nativeMemoryRelation}
native_memory_checked_at: ${date}
source: ${yamlScalar(source)}
created_at: ${date}
updated_at: ${date}
${tagBlock}
---

# ${title}

## 候选结论

${summary}
${transferabilitySection}
## 适用范围与边界

- 范围类型：\`${scopeKind}\`
- 适用于：${appliesTo.map((value) => `\`${value}\``).join('、')}
- 不适用于：${boundary}

## 与 Codex 原生记忆的关系

- 关系：\`${nativeMemoryRelation}\`
- 检查日期：${date}
- 仅当关系为 \`extends\` 或 \`corrects\` 时，本笔记可与原生记忆存在重叠；正文必须保留新增或纠正内容。
${evidenceSection}
## 核实要求

- 在使用前核对适用范围和当前证据。
- 未经用户确认或直接验证，不得升级为 \`verified\`。
`;
  writeUtf8Atomic(filePath, content);
  const maintenance = maintainVault(vault, { memoryRoot: options.memoryRoot });
  return {
    filePath,
    memoryId,
    scopeKind,
    appliesTo,
    nativeMemoryRelation,
    nativeMemoryMatches: nativeMemory.matches.map((match) => match.relativePath),
    maintenance: {
      ok: maintenance.ok,
      errors: maintenance.errors,
      warnings: maintenance.warnings,
      indexPath: maintenance.indexPath,
      healthPath: maintenance.healthPath,
    },
  };
}

function createSelfTestVault() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-memory-selftest-'));
  const memoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'obsidian-memory-native-selftest-'),
  );
  const alphaProject = path.join(os.tmpdir(), 'obsidian-memory-project-alpha');
  const betaProject = path.join(os.tmpdir(), 'obsidian-memory-project-beta');
  const frontmatter = `---
type: test
status: current
scope: self-test
source: self-test
updated_at: ${localDate()}
---
`;
  for (const relativePath of CORE_FILES) {
    const filePath = path.join(vault, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let body = `${frontmatter}\n# ${path.basename(relativePath, '.md')}\n`;
    if (relativePath === 'INDEX.md') {
      body += `\n${GENERATED_INDEX_START}\nempty\n${GENERATED_INDEX_END}\n`;
    }
    fs.writeFileSync(filePath, body, 'utf8');
  }
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '.obsidian', 'community-plugins.json'),
    JSON.stringify(['obsidian-local-rest-api']),
    'utf8',
  );
  fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, 'Projects', 'alpha.md'),
    `---
memory_id: project-alpha
type: project
status: verified
scope: exact alpha project only
scope_kind: project
applies_to:
  - ${yamlScalar(alphaProject)}
boundary: ${yamlScalar('Do not use in beta or any unrelated project.')}
native_memory_relation: absent
native_memory_checked_at: ${localDate()}
source: self-test
evidence: self-test
created_at: ${localDate()}
updated_at: ${localDate()}
verified_at: ${localDate()}
---

# Alpha Project

The alpha-only cobalt marker must never leak into unrelated projects.
`,
    'utf8',
  );
  fs.mkdirSync(path.join(vault, 'Patterns'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, 'Patterns', 'portable-zirconium.md'),
    `---
memory_id: portable-zirconium
type: pattern
status: verified
scope: repositories with deterministic text indexes
scope_kind: cross-project
applies_to:
  - deterministic text index implementations
boundary: ${yamlScalar('Do not apply to semantic vector-only indexes.')}
transferability: ${yamlScalar('The invariant depends on index behavior, not the source repository.')}
origin_projects:
  - alpha
native_memory_relation: absent
native_memory_checked_at: ${localDate()}
source: self-test
evidence: self-test
created_at: ${localDate()}
updated_at: ${localDate()}
verified_at: ${localDate()}
---

# Portable Zirconium Pattern

The deterministic index keeps a portable zirconium marker across repositories.
通用隔离规则不能仅凭一个低覆盖率词元命中无关项目查询。
`,
    'utf8',
  );
  fs.mkdirSync(path.join(vault, 'Archive', 'alpha'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, 'Archive', 'alpha', 'historic-neon-compass.md'),
    `---
memory_id: archived-neon-compass
type: evidence
status: archived
scope: exact alpha project history
scope_kind: project
applies_to:
  - ${yamlScalar(alphaProject)}
boundary: ${yamlScalar('Historical evidence only; do not use as current behavior.')}
native_memory_relation: absent
native_memory_checked_at: ${localDate()}
source: self-test archive
created_at: ${localDate()}
updated_at: ${localDate()}
superseded_by: project-alpha
---

# Historic Neon Compass

The historic neon compass protocol is retained only for explicit archive retrieval.
`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(memoryRoot, 'memory_summary.md'),
    '# Test native memory summary\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(memoryRoot, 'MEMORY.md'),
    [
      '# Test native memory',
      '',
      'The copper lighthouse protocol always validates the live lock before deployment.',
      '',
    ].join('\n'),
    'utf8',
  );
  return {
    vault,
    memoryRoot,
    alphaProject,
    betaProject,
  };
}

function runSelfTest() {
  const fixture = createSelfTestVault();
  const {
    vault,
    memoryRoot,
    alphaProject,
    betaProject,
  } = fixture;
  try {
    // Assemble synthetic credentials at runtime so public source scanners do not
    // mistake the fixtures for live secrets while the detector still sees the
    // complete value under test.
    const secretSamples = [
      ['github-token', ['ghp_', '123456789012345678901234567890123456'].join('')],
      ['jwt', [
        'eyJhbGciOiJIUzI1NiJ9',
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
        'abcdefghijklmnopqrstuv',
      ].join('.')],
      ['slack-token', [
        'xoxb-',
        '123456789012-123456789012-abcdefghijklmnopqrstuvwx',
      ].join('')],
      ['credential-url', [
        'postgres://',
        'alice:SuperSecretPassword@localhost/db',
      ].join('')],
    ];
    for (const [expectedFinding, sample] of secretSamples) {
      if (!findSecretFindings(sample).includes(expectedFinding)) {
        throw new Error(`secret scanner missed ${expectedFinding}`);
      }
      if (redactSecrets(sample).includes(sample)) {
        throw new Error(`secret redactor missed ${expectedFinding}`);
      }
    }

    const portableResults = searchMemory({
      vault,
      query: 'zirconium alpha',
      cwd: betaProject,
      limit: 3,
    });
    if (
      !portableResults.some(
        (result) => result.relativePath.endsWith('portable-zirconium.md'),
      )
    ) {
      throw new Error('cross-project search did not return the portable test note');
    }
    const weakCrossProjectResults = searchMemory({
      vault,
      query: 'MapleStoryAutoLevelUp 国服怀旧服隔离移植全量历史',
      cwd: vault,
      limit: 10,
    });
    if (weakCrossProjectResults.length !== 0) {
      throw new Error('one weak term recalled an unrelated cross-project note');
    }
    const matchingProjectResults = searchMemory({
      vault,
      query: 'cobalt marker',
      cwd: alphaProject,
      limit: 3,
    });
    if (!matchingProjectResults.some((result) => result.relativePath.endsWith('alpha.md'))) {
      throw new Error('matching project search did not return the project-only note');
    }
    const unrelatedProjectResults = searchMemory({
      vault,
      query: 'cobalt marker',
      cwd: betaProject,
      limit: 3,
    });
    if (unrelatedProjectResults.some((result) => result.relativePath.endsWith('alpha.md'))) {
      throw new Error('project-only note leaked into an unrelated project');
    }

    const defaultArchiveResults = searchMemory({
      vault,
      query: 'historic neon compass protocol',
      cwd: alphaProject,
      limit: 3,
    });
    if (defaultArchiveResults.length !== 0) {
      throw new Error('archive note leaked into default retrieval');
    }
    const explicitArchiveResults = searchMemory({
      vault,
      query: 'historic neon compass protocol',
      cwd: alphaProject,
      limit: 3,
      includeArchive: true,
    });
    if (
      !explicitArchiveResults.some(
        (result) => result.relativePath.endsWith('historic-neon-compass.md'),
      )
    ) {
      throw new Error('explicit archive retrieval did not return archived history');
    }

    const misplacedDeprecatedPath = path.join(vault, 'Inbox', 'deprecated-cobalt-history.md');
    fs.mkdirSync(path.dirname(misplacedDeprecatedPath), { recursive: true });
    fs.writeFileSync(
      misplacedDeprecatedPath,
      `---
memory_id: deprecated-cobalt-history
type: evidence
status: deprecated
scope: exact alpha project history
scope_kind: project
applies_to:
  - ${yamlScalar(alphaProject)}
boundary: ${yamlScalar('Superseded self-test history only.')}
native_memory_relation: absent
native_memory_checked_at: ${localDate()}
source: self-test
created_at: ${localDate()}
updated_at: ${localDate()}
superseded_by: project-alpha
---

# Deprecated Cobalt History

The deprecated cobalt history must never outrank its replacement.
`,
      'utf8',
    );
    const defaultDeprecatedResults = searchMemory({
      vault,
      query: 'deprecated cobalt history',
      cwd: alphaProject,
      limit: 3,
    });
    if (defaultDeprecatedResults.some((result) => result.filePath === misplacedDeprecatedPath)) {
      throw new Error('deprecated note leaked into default retrieval');
    }
    const explicitDeprecatedResults = searchMemory({
      vault,
      query: 'deprecated cobalt history',
      cwd: alphaProject,
      limit: 3,
      includeArchive: true,
    });
    if (!explicitDeprecatedResults.some((result) => result.filePath === misplacedDeprecatedPath)) {
      throw new Error('explicit history retrieval did not return a deprecated note');
    }
    const misplacedDeprecatedReport = validateVault(vault, { memoryRoot });
    if (
      !misplacedDeprecatedReport.errors.some(
        (error) => error.includes("Inbox/ notes must use status 'candidate'"),
      )
    ) {
      throw new Error('validator accepted a deprecated note in Inbox');
    }
    fs.rmSync(misplacedDeprecatedPath);

    let archivedDuplicateBlocked = false;
    try {
      createCandidate({
        vault,
        memoryRoot,
        title: 'Duplicate archived protocol',
        summary: 'The historic neon compass protocol is retained only for explicit archive retrieval.',
        source: 'self-test',
        scope: 'alpha archive history',
        scopeKind: 'project',
        appliesTo: alphaProject,
        boundary: 'Historical self-test only.',
      });
    } catch (error) {
      archivedDuplicateBlocked = /Refusing duplicate capture/.test(error.message);
    }
    if (!archivedDuplicateBlocked) {
      throw new Error('duplicate capture was not blocked by archived history');
    }

    const duplicateText = 'The copper lighthouse protocol always validates the live lock before deployment.';
    const nativeOverlap = checkNativeMemoryOverlap({
      text: duplicateText,
      memoryRoot,
    });
    if (!nativeOverlap.likelyDuplicate) {
      throw new Error('native-memory duplicate was not detected');
    }
    let duplicateCaptureBlocked = false;
    try {
      createCandidate({
        vault,
        memoryRoot,
        title: 'Duplicate native rule',
        summary: duplicateText,
        source: 'self-test',
        scope: 'all deployment projects',
        scopeKind: 'cross-project',
        appliesTo: 'deployment projects',
        boundary: 'Only when a live lock exists.',
        transferability: 'The rule is repository-independent.',
        originProjects: 'alpha',
      });
    } catch (error) {
      duplicateCaptureBlocked = /duplicates Codex built-in memory/.test(error.message);
    }
    if (!duplicateCaptureBlocked) {
      throw new Error('duplicate native-memory capture was not blocked');
    }

    const coldStartBefore = searchMemory({
      vault,
      query: 'silver gyroscope shield ordering',
      cwd: betaProject,
      limit: 3,
    });
    if (coldStartBefore.length !== 0) {
      throw new Error('cold-start query unexpectedly matched an existing note');
    }
    const coldStartProjectCandidate = createCandidate({
      vault,
      memoryRoot,
      title: 'Cold-start beta shield ordering',
      summary: 'A silver gyroscope marker preserves tested shield ordering in the beta overlay.',
      source: 'self-test',
      scope: 'beta overlay only',
      scopeKind: 'project',
      appliesTo: betaProject,
      boundary: 'Do not apply outside betaProject or to live runtime behavior not covered by tests.',
      evidence: 'automated self-test',
      tags: 'cold-start,project',
    });
    if (
      !coldStartProjectCandidate.maintenance.ok
      || !fs.existsSync(coldStartProjectCandidate.maintenance.healthPath)
    ) {
      throw new Error('candidate capture did not refresh a valid health report');
    }
    const coldStartAfter = searchMemory({
      vault,
      query: 'silver gyroscope shield ordering',
      cwd: betaProject,
      limit: 3,
    });
    if (
      !coldStartAfter.some(
        (result) => result.filePath === coldStartProjectCandidate.filePath,
      )
    ) {
      throw new Error('cold-start project candidate was not retrievable from its project');
    }
    const coldStartUnrelated = searchMemory({
      vault,
      query: 'silver gyroscope shield ordering',
      cwd: alphaProject,
      limit: 3,
    });
    if (
      coldStartUnrelated.some(
        (result) => result.filePath === coldStartProjectCandidate.filePath,
      )
    ) {
      throw new Error('cold-start project candidate leaked into an unrelated project');
    }

    const uniqueCandidate = createCandidate({
      vault,
      memoryRoot,
      title: 'Single-origin portable candidate',
      summary: 'A quartz shuttle marker protects deterministic note promotion across bounded repositories.',
      source: 'self-test',
      scope: 'deterministic note promotion',
      scopeKind: 'cross-project',
      appliesTo: 'repositories with deterministic note promotion',
      boundary: 'Do not apply when promotion is probabilistic.',
      transferability: 'The invariant depends on promotion semantics rather than repository identity.',
      originProjects: 'alpha',
    });

    const invalidScopePath = path.join(vault, 'Inbox', 'invalid-scope-alias.md');
    fs.writeFileSync(
      invalidScopePath,
      `---
memory_id: invalid-scope-alias
type: candidate
status: candidate
scope: invalid combined project aliases
scope_kind: project
applies_to:
  - ${yamlScalar(`${alphaProject}|${betaProject}`)}
boundary: ${yamlScalar('Self-test only.')}
native_memory_relation: absent
native_memory_checked_at: ${localDate()}
source: self-test
created_at: ${localDate()}
updated_at: ${localDate()}
---

# Invalid Scope Alias
`,
      'utf8',
    );
    const invalidScopeReport = validateVault(vault, { memoryRoot });
    if (
      !invalidScopeReport.errors.some(
        (error) => error.includes("use separate YAML items instead of '|'"),
      )
    ) {
      throw new Error('validator accepted multiple applies_to paths in one scalar');
    }
    fs.rmSync(invalidScopePath);

    const benchmarkPath = path.join(vault, 'Meta', 'retrieval-benchmark.json');
    fs.writeFileSync(
      benchmarkPath,
      `${JSON.stringify({
        version: 1,
        cases: [
          {
            id: 'alpha-current',
            query: 'cobalt marker',
            cwd: alphaProject,
            relevant_paths: ['Projects/alpha.md'],
            required_paths: ['Projects/alpha.md'],
          },
          {
            id: 'alpha-archive',
            query: 'historic neon compass protocol',
            cwd: alphaProject,
            include_archive: true,
            relevant_paths: ['Archive/alpha/historic-neon-compass.md'],
            required_paths: ['Archive/alpha/historic-neon-compass.md'],
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    );
    const validBenchmarkFixture = validateBenchmarkFixture(vault, benchmarkPath);
    if (validBenchmarkFixture.errors.length !== 0) {
      throw new Error(`valid benchmark fixture was rejected: ${validBenchmarkFixture.errors.join('; ')}`);
    }
    const staleBenchmarkPath = path.join(vault, 'Meta', 'stale-retrieval-benchmark.json');
    fs.writeFileSync(
      staleBenchmarkPath,
      `${JSON.stringify({
        version: 1,
        cases: [
          {
            id: 'stale-path',
            query: 'missing fixture path',
            relevant_paths: ['Projects/missing.md'],
            required_paths: ['Projects/missing.md'],
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    );
    const staleBenchmarkFixture = validateBenchmarkFixture(vault, staleBenchmarkPath);
    if (!staleBenchmarkFixture.errors.some((error) => error.includes('path does not exist'))) {
      throw new Error('benchmark fixture validator accepted a missing qrel path');
    }
    fs.rmSync(staleBenchmarkPath);

    const index = rebuildIndex(vault);
    if (index.indexedNotes !== 4) {
      throw new Error(`expected four indexed notes, got ${index.indexedNotes}`);
    }
    const report = validateVault(vault, { memoryRoot });
    if (!report.ok) {
      throw new Error(`validation failed: ${report.errors.join('; ')}`);
    }
    const topicStatusTotal = Object.values(report.topicStatusCounts)
      .reduce((total, count) => total + count, 0);
    if (
      topicStatusTotal !== report.topicNotes
      || report.topicStatusCounts.candidate !== 2
      || report.topicStatusCounts.verified !== 2
      || report.archivedNotes !== 1
      || report.archiveStatusCounts.archived !== 1
    ) {
      throw new Error('topic status counts include system ledgers or omit topic notes');
    }
    return {
      ok: true,
      crossProjectResults: portableResults.length,
      matchingProjectResults: matchingProjectResults.length,
      unrelatedProjectResults: unrelatedProjectResults.length,
      projectScopeIsolation: true,
      weakCrossProjectNoiseSuppressed: true,
      defaultArchiveResults: defaultArchiveResults.length,
      explicitArchiveResults: explicitArchiveResults.length,
      defaultDeprecatedResults: defaultDeprecatedResults.length,
      explicitDeprecatedResults: explicitDeprecatedResults.length,
      archivedDuplicateBlocked,
      secretPatternsCovered: secretSamples.length,
      benchmarkFixtureValidation: true,
      appliesToAliasValidation: true,
      nativeDuplicateDetected: true,
      duplicateCaptureBlocked: true,
      coldStartBeforeResults: coldStartBefore.length,
      coldStartProjectCandidate: Boolean(coldStartProjectCandidate.filePath),
      captureMaintenance: true,
      coldStartAfterResults: coldStartAfter.length,
      coldStartProjectIsolation: true,
      singleOriginPortableCandidate: Boolean(uniqueCandidate.filePath),
      indexedNotes: index.indexedNotes,
      filesChecked: report.filesChecked,
      topicStatusCounts: report.topicStatusCounts,
      archiveStatusCounts: report.archiveStatusCounts,
    };
  } finally {
    const expectedPrefix = path.join(os.tmpdir(), 'obsidian-memory-selftest-');
    const expectedMemoryPrefix = path.join(
      os.tmpdir(),
      'obsidian-memory-native-selftest-',
    );
    if (vault.startsWith(expectedPrefix)) {
      fs.rmSync(vault, { recursive: true, force: true });
    }
    if (memoryRoot.startsWith(expectedMemoryPrefix)) {
      fs.rmSync(memoryRoot, { recursive: true, force: true });
    }
  }
}

module.exports = {
  ALLOWED_NATIVE_MEMORY_RELATIONS,
  ALLOWED_SCOPE_KINDS,
  ALLOWED_STATUSES,
  CORE_FILES,
  DEFAULT_BUILTIN_MEMORY_ROOT,
  DEFAULT_VAULT,
  checkNativeMemoryOverlap,
  checkNovelty,
  createCandidate,
  findSecretFindings,
  formatSearchResults,
  localDate,
  maintainVault,
  parseFrontmatter,
  readUtf8,
  rebuildIndex,
  redactSecrets,
  resolveBuiltInMemoryRoot,
  resolveVault,
  runSelfTest,
  searchMemory,
  tokenize,
  validateBenchmarkFixture,
  validateVault,
  walkMarkdown,
  writeHealthReport,
  writeUtf8Atomic,
};
