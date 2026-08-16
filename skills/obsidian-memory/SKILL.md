---
name: obsidian-memory
description: Consult, capture, correct, validate, and maintain the user's scoped multi-project Markdown knowledge vault at F:\Obsidian without mirroring Codex built-in memory. Use when a non-trivial task may depend on durable project-specific facts, transferable patterns, evidence, decisions, or prior fixes; when the user asks Codex to remember, forget, correct, archive, or review durable knowledge; and before finishing work that produced bounded reusable knowledge. Do not use for clearly self-contained trivial requests or when the user explicitly asks not to use memory.
---

# Obsidian 多项目记忆

把 `F:\Obsidian` 作为 Codex 原生记忆的可审计、非重复补充。它是一套能服务多个项目的统一知识库，不代表每条记录都必须跨项目适用。

## 三层职责

- Codex 原生记忆：自动回忆用户偏好、常见工作流、最近项目上下文和简短经验。
- 适用层级的 `AGENTS.md` / 项目文档：必须遵守的规则和项目内真相。
- Obsidian：原生记忆未完整保存的结构化细节、证据、边界、可迁移模式和纠错记录。

不要把原生记忆机械复制到 Obsidian。当前用户指令、源码、配置、运行时、日志和测试证据始终优先。

## 定位与确定性工具

- 将包含本文件的目录记为 `<skill-dir>`。
- 默认 Vault：`F:\Obsidian`。
- 默认 Codex 原生记忆目录：`%USERPROFILE%\.codex\memories`。
- 仅在对应环境变量明确设置时使用 `CODEX_OBSIDIAN_MEMORY_VAULT` 或 `CODEX_BUILTIN_MEMORY_ROOT` 覆盖值。

```powershell
node "<skill-dir>\scripts\memory-cli.cjs" status
node "<skill-dir>\scripts\memory-cli.cjs" search --query "项目名 关键问题" --cwd "$PWD"
node "<skill-dir>\scripts\memory-cli.cjs" search --query "历史争议" --cwd "$PWD" --include-archive
node "<skill-dir>\scripts\memory-cli.cjs" benchmark --cases "F:\Obsidian\Meta\retrieval-benchmark.json"
node "<skill-dir>\scripts\memory-cli.cjs" novelty-check --text "准备保存的结论" --cwd "$PWD"
node "<skill-dir>\scripts\memory-cli.cjs" validate
node "<skill-dir>\scripts\memory-cli.cjs" rebuild-index
node "<skill-dir>\scripts\memory-cli.cjs" maintain
```

## 范围模型

每条主题记录必须属于下列一种范围，不能省略。

### `scope_kind: project`

允许保存只适用于一个项目的内容。必须满足：

- `applies_to` 至少包含一个精确项目目录、稳定项目标识或仓库名。
- 多个目录或标识必须写成独立 YAML 列表项；不得用 `|` 把多个路径拼进同一个值。
- `boundary` 明确哪些项目、版本、框架或情形不得使用。
- 常规检索只有在当前 `cwd` 匹配，或用户明确点名该项目时才返回。
- 当前上下文无法确认匹配时 fail closed，不把该内容注入其他项目。
- 正式笔记放在 `Projects/<project>/` 或 `Projects/<project>.md`。

### `scope_kind: cross-project`

允许只从一个项目中提炼，只要知识本身可迁移。必须满足：

- `transferability` 解释可迁移性依赖什么不变量，而不是仅声称“通用”。
- `applies_to` 写明可采用它的项目、技术栈或条件。
- `boundary` 写明反例和不能迁移的条件。
- `origin_projects` 可只有一个，也可有多个；它是来源，不是适用范围。
- 正式笔记放在 `Cross-Project/`、`Patterns/` 或 `Domains/`。

## 任务开始时

1. 从提示、`cwd`、仓库名、模块名和错误文本提取检索词。
2. 运行带 `--cwd` 的 `search`。项目专属结果由脚本按范围过滤。
3. 检索为 0 命中表示新项目或新主题的正常冷启动，不表示“没有记忆可写”；任务结束时仍须评估是否创建范围化候选。
4. 仅在命中后读取相关完整笔记；核心账本用于理解系统规则，不作为所有任务的默认上下文。
5. 核对 `status`、`scope_kind`、`applies_to`、`boundary`、`source`、`evidence` 和日期。
6. 对易漂移事实，用当前源码或环境刷新验证。
7. 若当前证据与记录冲突，以当前证据为准，并安排范围化纠错。

Hook 注入的片段只是导航信息，不能替代当前验证。

## 写入门槛

只有以下检查全部通过，才允许写入：

1. 内容跨会话仍有价值，不是完整聊天、临时探索或可轻易从源码重新生成的大段材料。
2. 明确选择 `project` 或 `cross-project`，并填写对应范围字段。
3. 运行 `novelty-check`，同时检查 Codex 原生记忆和 Vault 现有主题笔记。
4. 若原生记忆不可读取，保守停止新增；修复检查能力后再写。
5. 若原生记忆已经包含同一结论，不写入：
   - Obsidian 提供原生记忆没有的必要细节或证据时，使用 `native_memory_relation: extends`。
   - Obsidian 明确纠正原生记忆时，使用 `native_memory_relation: corrects` 并保留证据。
   - 完全不存在重叠时，使用 `native_memory_relation: absent`。
6. 若 Vault 已有相同结论，更新原记录，不新建重复项。
7. 必须遵守的规则同时放在正确层级的 `AGENTS.md` 或项目文档；不要仅依赖 Obsidian。

Vault 零命中只说明没有既有记录。只要本轮形成了跨会话有价值、原生记忆未完整包含且范围明确的知识，就应创建新的 `candidate`；不得以“项目范围记忆未命中”为跳过理由。

## 候选创建

项目专属示例：

```powershell
node "<skill-dir>\scripts\memory-cli.cjs" capture `
  --title "Alpha 项目的部署锁判定" `
  --summary "只有目标 DLL 的真实文件锁才能证明 Alpha 正在占用部署产物。" `
  --source "当前任务中的脚本与进程验证" `
  --scope "Alpha 部署流程" `
  --scope-kind "project" `
  --applies-to "C:\work\Alpha" `
  --boundary "不得用于 Beta 或未使用同一部署脚本的项目" `
  --native-memory-relation "absent" `
  --tags "deployment,alpha"
```

单项目来源、但可迁移的示例：

```powershell
node "<skill-dir>\scripts\memory-cli.cjs" capture `
  --title "部署状态应使用目标文件锁" `
  --summary "进程残留不能证明部署目标仍被占用，应检查真实目标文件锁。" `
  --source "Alpha 项目验证" `
  --scope "具有可锁定部署产物的本地部署流程" `
  --scope-kind "cross-project" `
  --applies-to "使用本地文件部署的项目" `
  --boundary "不适用于无本地目标文件或远程原子部署" `
  --transferability "判定依据是操作系统文件锁，与来源仓库无关" `
  --origin-projects "Alpha" `
  --native-memory-relation "extends" `
  --tags "deployment,file-lock"
```

`capture` 只创建 `candidate`。正式归并时仍需按 schema 写入正确目录。

## 状态与证据

- `candidate`：自动捕获或尚未核实，不得直接当事实使用。
- `current`：有依据但可能变化。
- `verified`：本轮有直接源码、测试、运行时、日志证据，或用户明确确认。
- `deprecated`：被更准确记录替代，需写 `superseded_by` 或正文原因。
- `archived`：只供历史追溯，默认检索不返回。

默认检索同时排除 `deprecated` 与 `archived`；只有显式 `--include-archive` 的历史回溯才允许返回。状态扣分不能替代这个门禁，因为精确标题命中仍可能让旧结论排到第一。

缺少游戏实机或完整端到端验证时，必须缩小结论层级和 `boundary`，但这不妨碍保存已由源码、构建或自动测试支持的候选。自动测试可以证明相应代码契约或回归结果，不能外推为实机行为已验证。

只有同时具备精确范围、来源、证据和验证日期，才能使用 `verified`。`capture` 写入后会统一刷新索引、校验与健康报告；手工修改或移动笔记后仍须运行 `validate` 和 `rebuild-index`（或直接运行 `maintain`）。失败必须修复或明确报告。

## 安全、纠错与沟通

- 不保存密码、API key、令牌、Cookie、私钥、完整认证头、带凭据连接 URL 或完整聊天。确定性的 GitHub/GitLab、Slack、JWT、云密钥与数据库凭据模式必须在写入、校验和注入前使用同一套规则拒绝或脱敏。
- 发现错误时不静默覆盖：旧记录标为 `deprecated`，链接替代记录，并记录传播风险。
- 除非用户明确要求或内容是可恢复的无价值自动产物，不物理删除历史记录。
- 用户要求不使用记忆时，本轮不检索也不写入。
- 最终答复若使用了本轮未验证的记忆事实，要简要说明来源及可能过期的边界。

## 自动 hooks

本插件的 hooks 会：

- 会话开始时只注入角色分工、范围规则和健康状态，不灌入全局项目内容。
- 每个用户提示提交时按 `cwd` 和明确项目名做有界检索。
- 用户提示只把正文用于相关度评分，`cwd` 仅参与范围门禁；通用工作措辞先去噪，跨项目候选需要达到最低相关分和词元覆盖率，除非标题或路径命中足够强的 ASCII 项目标识。
- 默认最多注入 3 条紧凑结果，`UserPromptSubmit` 硬上限为 3000 字符；预算不足时省略较低排名结果，不无界截断上下文。
- 模型可见的每条紧凑结果保留 `status`、`scope_kind`、`applies_to`、`boundary`、`source`、`evidence` 与验证/更新日期；缺失证据时显式标记 `evidence=not-declared`。
- Archive 默认不参与检索；只有显式 `--include-archive` 时返回归档和 deprecated 历史。
- `benchmark` 和 `validate` 会先检查基准路径仍在 Vault 内且真实存在，并拒绝 required/relevant/forbidden 自相矛盾的陈旧夹具；夹具错误不得混入检索质量指标。
- 把本轮检索命中数带入结束判断；0 命中时明确按冷启动评估新候选。
- 可能产生长期价值时，在结束前触发去重、范围分类和写回判断。
- 会话结束时重建索引并写入健康报告。

Hooks 不会自动把内容升级为 `verified`，也不会绕过 Codex 对非托管命令 hook 的用户信任要求。
