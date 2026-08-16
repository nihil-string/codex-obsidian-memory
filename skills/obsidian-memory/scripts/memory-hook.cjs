#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./memory-core.cjs');

const MAX_USER_PROMPT_CONTEXT_CHARS = 3000;

function readInput() {
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function hookContext(eventName, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
}

function stateRoot() {
  const configured = process.env.PLUGIN_DATA;
  return path.resolve(
    configured || path.join(os.tmpdir(), 'codex-obsidian-memory-state'),
  );
}

function sessionKey(sessionId) {
  return crypto
    .createHash('sha256')
    .update(String(sessionId || 'unknown'))
    .digest('hex')
    .slice(0, 24);
}

function statePath(input) {
  return path.join(stateRoot(), `${sessionKey(input.session_id)}.json`);
}

function readState(input) {
  const filePath = statePath(input);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(core.readUtf8(filePath));
  } catch {
    return {};
  }
}

function writeState(input, state) {
  const filePath = statePath(input);
  core.writeUtf8Atomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function hasMemoryOptOut(prompt) {
  return /(?:不要|别|无需|禁止).{0,8}(?:使用|读取|检索|写入|保存).{0,8}(?:记忆|memory)|(?:do not|don't|ignore|disable|without).{0,12}(?:memory|memories)/i.test(prompt);
}

function classifyPrompt(prompt) {
  const text = String(prompt || '');
  const explicitMemory = /记住|永久记忆|长期记忆|以后都|今后都|不要忘|忘掉|删除记忆|纠正记忆|更新记忆|memory|remember|forget/i.test(text);
  const durableTask = /修复|修好|实现|修改|改成|调整|优化|安装|配置|迁移|部署|验证|测试|构建|发布|调试|排查|回归|根因|决定|决策|选择|约定|规则|路径|版本|日志|源码|仓库|项目|插件|错了|不对|有问题|异常|失效|遗漏|误判|skill|hook|fix|implement|change|update|adjust|install|configure|migrate|deploy|verify|test|build|release|debug|wrong|broken|incorrect|issue|bug|root cause|decision|repository|project|plugin/i.test(text);
  return {
    explicitMemory,
    durableTask,
    optedOut: hasMemoryOptOut(text),
    promptDigest: crypto.createHash('sha256').update(text).digest('hex'),
  };
}

function responseLooksComplete(response) {
  return /已完成|已修复|修好|改好|已实现|已安装|已配置|已验证|验证通过|测试通过|构建成功|通过|根因|结论|决定|未验证|无法验证|完成了|fixed|implemented|installed|configured|verified|tests? pass(?:ed)?|build succeeded|root cause|decision|completed/i.test(String(response || ''));
}

function handleSessionStart(input, vault) {
  const report = core.validateVault(vault);
  const context = [
    '[Obsidian 范围化多项目记忆]',
    `Vault: ${vault}`,
    '本库是 Codex 原生记忆的非重复补充，不是镜像。原生记忆负责自动回忆；Obsidian 只保存有明确边界、可审计的项目专属知识、可迁移知识及其证据。',
    'scope_kind=project 的记录仅在 cwd 或用户明确指定的项目与 applies_to 匹配时可见；不匹配时必须 fail closed。scope_kind=cross-project 可只源自一个项目，但必须说明 transferability 和 boundary。',
    'Vault 检索零命中只表示这是尚无记录的新项目或新主题，不是跳过写入的理由；若本轮产生持久且非重复的结论，应创建范围化候选。',
    '写入前必须检查 Codex 原生记忆；纯重复项不写入，只有明确增加细节或纠正错误时才分别标为 extends 或 corrects。',
    '当前源码、运行时、日志、测试证据和本轮用户指令始终优先。不要存储秘密、完整聊天或无边界结论。',
    `Vault health: ${report.ok ? 'OK' : `FAILED (${report.errors.length} errors)`}`,
    `Built-in memory baseline: ${report.builtInMemoryAvailable
      ? `available (${report.builtInMemoryFilesChecked} files)`
      : 'unavailable; refuse new captures'}`,
  ].join('\n');
  printJson(hookContext('SessionStart', context));
}

function handleUserPrompt(input, vault) {
  const prompt = String(input.prompt || '');
  const classification = classifyPrompt(prompt);
  const state = {
    ...classification,
    cwd: String(input.cwd || ''),
    updatedAt: new Date().toISOString(),
    lastReviewedTurnId: null,
    memoryMatchCount: null,
  };

  if (classification.optedOut) {
    writeState(input, state);
    printJson({});
    return;
  }

  // cwd is already used by the scope gate. Scoring the full path made common
  // parent segments such as Users/Desktop look relevant across repositories.
  const query = prompt;
  const results = core.searchMemory({
    vault,
    query,
    cwd: String(input.cwd || ''),
    limit: 3,
    includeArchive: false,
  });
  writeState(input, {
    ...state,
    memoryMatchCount: results.length,
    memorySearchStatus: results.length === 0 ? 'cold-start' : 'matched',
  });
  const coldStartGuidance = results.length === 0
    ? '本轮 Vault 检索为 0 命中：这属于新项目或新主题的正常冷启动。0 命中不表示“没有记忆可写”；任务结束时若形成持久、非重复且边界明确的结论，应创建新的 project 或 cross-project 候选。'
    : `本轮命中 ${results.length} 条记录：写回时优先更新既有主题，避免重复。`;
  const prefix = [
    '[Obsidian 自动检索]',
    `Vault: ${vault}`,
    coldStartGuidance,
    '以下结果已按项目范围过滤：项目专属记录仅在 cwd 或用户明确点名的项目匹配时出现；跨项目记录仍需核对 applies_to、boundary 和 transferability。',
    core.AGENT_SAFE_RETRIEVAL_BOUNDARY,
    '先检查 status、scope_kind、applies_to、boundary、source、evidence 和日期。',
  ].join('\n\n');
  const formattedBudget = Math.max(
    0,
    MAX_USER_PROMPT_CONTEXT_CHARS - prefix.length - 2,
  );
  const formatted = core.redactSecrets(
    core.formatSearchResults(results, vault, {
      compact: true,
      charBudget: formattedBudget,
    }),
  );
  let context = `${prefix}\n\n${formatted}`;
  if (context.length > MAX_USER_PROMPT_CONTEXT_CHARS) {
    context = `${prefix}\n\n命中结果超出自动注入预算；请按需运行显式 search 读取。`;
  }
  printJson(hookContext('UserPromptSubmit', context));
}

function handleStop(input) {
  if (input.stop_hook_active) {
    printJson({});
    return;
  }
  const state = readState(input);
  if (state.optedOut) {
    printJson({});
    return;
  }
  if (state.lastReviewedTurnId && state.lastReviewedTurnId === input.turn_id) {
    printJson({});
    return;
  }

  const shouldReview = Boolean(
    state.explicitMemory
    || (state.durableTask && responseLooksComplete(input.last_assistant_message)),
  );
  if (!shouldReview) {
    printJson({});
    return;
  }

  writeState(input, {
    ...state,
    lastReviewedTurnId: input.turn_id || 'unknown',
    reviewedAt: new Date().toISOString(),
  });
  const retrievalGuidance = state.memoryMatchCount === 0
    ? '本轮 Vault 检索为 0 命中，表示冷启动而非禁止写入。不得仅以“项目范围记忆未命中”为理由跳过；若本轮形成持久、非重复且范围明确的修复、规则、证据或决策，应创建新候选。'
    : Number.isInteger(state.memoryMatchCount)
      ? `本轮 Vault 检索命中 ${state.memoryMatchCount} 条；优先更新匹配记录，确属新事实时再新建。`
      : '本轮没有可用的检索计数；仍须独立判断是否形成持久的新知识，不能把未知计数当成不写入理由。';
  printJson({
    decision: 'block',
    reason: [
      '在结束本轮前执行一次 $obsidian-memory 维护判断。',
      retrievalGuidance,
      '只评估本轮是否产生了原生记忆未完整包含、跨会话仍有价值且能写清边界的事实、证据、决策或错误修复；不要复制用户偏好、最近项目状态或原生记忆已有摘要。',
      '项目专属内容允许保存，但必须使用 scope_kind=project、精确 applies_to 和明确 boundary；检索不得向其他项目泄漏。',
      '可迁移内容即使只来自一个项目也允许保存，但必须使用 scope_kind=cross-project，并写清 transferability、applies_to、boundary 和 origin_projects。',
      '写入前先运行 novelty-check。若 Codex 原生记忆基线不可用则不写；若结论只是重复则不写；若提供原生记忆没有的细节或纠错，分别标为 native_memory_relation=extends 或 corrects。',
      '必须遵守的规则仍写入适用层级的 AGENTS.md 或项目文档，Obsidian 只保存非重复的审计资料与边界。',
      '若确需写入：按 F:\\Obsidian\\Meta\\SCHEMA.md 记录 scope/source/evidence/date，并运行 validate 与 rebuild-index。',
      '缺少游戏实机或完整端到端验证只会限制 status 和结论边界，不会阻止保存已经由源码、构建或自动测试支持的候选；自动捕获默认使用 candidate。',
      '只有本轮存在直接测试、运行时、日志、源码证据或用户明确确认，并且正文精确限定已验证层级时，才允许 status: verified；否则使用 current 或 candidate。',
      '若没有长期价值，只需作出“不写入”的判断并继续最终答复。不得保存秘密或完整聊天记录。',
    ].join(' '),
  });
}

function handleSessionEnd(vault) {
  const report = core.maintainVault(vault);
  if (!report.ok) {
    process.stderr.write(
      `obsidian-memory maintenance failed: ${report.errors.join('; ')}\n`,
    );
    process.exitCode = 1;
  }
}

function main() {
  const mode = process.argv[2];
  const input = readInput();
  const vault = core.resolveVault();

  if (!fs.existsSync(vault)) {
    if (mode === 'SessionEnd' || mode === 'session-end') {
      process.stderr.write(`obsidian-memory vault is missing: ${vault}\n`);
      process.exitCode = 1;
      return;
    }
    printJson({
      systemMessage: `Obsidian memory vault is missing: ${vault}`,
    });
    return;
  }

  switch (mode) {
    case 'session-start':
      handleSessionStart(input, vault);
      return;
    case 'user-prompt':
      handleUserPrompt(input, vault);
      return;
    case 'stop':
      handleStop(input);
      return;
    case 'session-end':
      handleSessionEnd(vault);
      return;
    default:
      throw new Error(`Unknown hook mode '${mode || ''}'`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`obsidian-memory hook: ${error.stack || error.message}\n`);
  process.exitCode = 1;
}
