# test-generator: 通用测试用例生成

> 从测试文件、需求文档、技术方案、项目代码综合分析，生成可执行的自动化测试用例。
> 浏览器 E2E 测试通过 auto-test-view MCP 工具执行。

## 触发词

`生成测试`、`写测试用例`、`test cases`、`测试覆盖`、`补充测试`、`执行测试`、`测试报告`、`/test-generator`

## 文档索引

| 文件 | 内容 | 何时阅读 |
|------|------|----------|
| **本文件** | 核心流程、输入源、生命周期、操作指令 | **每次执行前** |
| [reference/schemas.md](reference/schemas.md) | meta.json / results.json Schema + report.md 模板 | 生成/更新数据文件时 |
| [reference/e2e-mcp.md](reference/e2e-mcp.md) | E2E JSON Suite Schema、MCP 工具表、Assert 规则 | 生成/执行 E2E 测试时 |
| [reference/unit-rules.md](reference/unit-rules.md) | 单元测试框架检测、生成模式、Mock 约定 | 生成单元测试时 |
| [reference/challenger-agents.md](reference/challenger-agents.md) | Challenger Agent 三角色定义、执行流程、prompt 模板 | generate 步骤 8 审查时 |
| [reference/failure-analysis.md](reference/failure-analysis.md) | 失败原因分析规则、报告格式 | run 执行后分析失败用例时 |
| [reference/xmind-parser.md](reference/xmind-parser.md) | XMind 文件解析规则、层级映射、标记提取 | 输入源为 .xmind 文件时 |

---

## 一、输入源

Skill 触发后，首先确认用户提供了哪些输入源：

| 输入类型 | 格式 | 用途 |
|----------|------|------|
| 测试用例文件 | CSV / Markdown / JSON / Excel / **XMind** | 手工用例转自动化 |
| 需求文档 | Markdown / PDF / Word | 提取业务场景和验收标准 |
| 技术方案 | Markdown / 项目内文档 | 理解接口定义、模块边界、数据结构 |
| 项目代码 | 源码文件 | 分析函数签名、依赖关系、mock 需求 |

**输入解析规则**：
- CSV：首行为表头，识别 ID/名称/步骤/预期结果/优先级 等列
- Markdown：按标题层级提取用例，`##` 为用例组，`###` 或列表项为单条用例
- JSON：支持数组格式 `[{id, name, steps, expected}]` 或嵌套格式
- 代码文件：分析 export 的函数/类签名、参数类型、返回类型、异常路径
- 需求文档：提取功能点（通常为编号列表或表格）、验收标准、业务规则
- XMind（`.xmind`）：思维导图格式，按树层级提取测试结构（详见 [xmind-parser.md](reference/xmind-parser.md)）

如果用户未提供任何输入源，提示用户至少提供一种（代码文件或测试文件或需求文档）。

---

## 二、输出目录与任务名

### 目录结构

```
<项目>/.auto-test-view/tests/
  <task-name>/
    unit/                 # 单元测试 (.test.ts / .test.js)
    e2e/                  # 浏览器 E2E 测试 (JSON suite, auto-test-view 执行)
    e2e/screenshots/      # E2E 测试截图
    integration/          # 集成/API 测试 (.test.ts)
    meta.json             # 元信息 + 状态 + 来源映射 + 变更记录
    results.json          # 执行结果（逐条明细）
    report.md             # 测试报告（汇总 + 失败分析）
```

### 任务名生成优先级

1. **用户指定** — 用户明确给出名称，直接使用
2. **当前分支名** — `task/TASK-005` → `TASK-005`，`feat/user-login` → `user-login`
3. **最近 commit** — `feat: add login flow` → `add-login-flow`
4. **时间戳兜底** — `test-20260402-001`（当天序号递增）

命名规范：小写字母 + 数字 + 连字符，不含空格或特殊字符。

---

## 三、生命周期与状态模型

```
draft → confirmed → running → completed
  |        |                      |
  修改     修改+记录原因          可重新执行
  重新生成
```

| 状态 | 含义 | 允许操作 |
|------|------|----------|
| `draft` | 已生成，待确认 | 修改、重新生成、删除、确认 |
| `confirmed` | 用户已确认 | 修改（必须记录原因）、执行测试 |
| `running` | 测试执行中 | 查看进度 |
| `completed` | 执行完成 | 查看报告、重新执行 |

---

## 四、操作指令

### generate — 生成测试用例

**触发**：用户提供输入源并要求生成测试

**流程**：

1. **确定任务名**（按优先级推导）
2. **创建目录** `<项目>/.auto-test-view/tests/<task-name>/`
3. **解析输入源**（见上方输入解析规则）
4. **判断测试类型**（对每个测试点）：
   - 纯函数 / 工具模块 / 数据处理逻辑 → `unit/`
   - 页面交互 / 用户流程 / UI 验证 → `e2e/`（auto-test-view MCP）
   - API 调用 / 服务间通信 / 数据库操作 → `integration/`
5. **检测项目测试框架**（详见 [unit-rules.md](reference/unit-rules.md)）
6. **生成测试文件**：
   - 单元测试：按模块生成 `.test.ts`（详见 [unit-rules.md](reference/unit-rules.md)）
   - E2E 测试：生成 JSON suite 文件（详见 [e2e-mcp.md](reference/e2e-mcp.md)）
   - 集成测试：按服务/API 生成 `.test.ts`
7. **生成 meta.json**（status: draft，Schema 见 [schemas.md](reference/schemas.md)）
8. **Challenger Agent 审查**（详见 [challenger-agents.md](reference/challenger-agents.md)）：
   - 并行启动 3 个 Sub Agent：覆盖率挑战者、质量挑战者、对抗挑战者
   - 收集审查报告 → 整合去重 → 自动修正用例
   - 更新 meta.json 的 `challengerReview` 字段
   - 可跳过条件：用例 <= 3 条、用户指定 `--skip-review`
9. **输出用例列表 + 审查摘要供确认**
10. **等待用户确认**（不可自动跳过）

### confirm — 确认测试用例

**触发**：用户确认用例列表（"确认"、"可以"、"没问题"）

1. 更新 `meta.json`：`status → confirmed`，`confirmedAt → now`
2. 输出确认信息

### modify — 修改已确认用例

**触发**：用户在 confirmed 状态下要求修改

**强制要求**：必须提供变更原因。无原因则提示并拒绝修改。

1. 要求用户说明修改原因（如果未提供）
2. 执行修改
3. 记录到 `meta.json` 的 `changelog`
4. 输出变更确认

### run — 执行测试

**触发**：用户要求执行测试（"执行测试"、"跑测试"、"run tests"）

**前置检查**：status 必须为 `confirmed` 或 `completed`

1. 更新 status → `running`
2. 按类型分别执行：
   - **单元测试**：`npx vitest run .auto-test-view/tests/<task>/unit/ --reporter=json`
   - **集成测试**：`npx vitest run .auto-test-view/tests/<task>/integration/ --reporter=json`
   - **E2E 浏览器测试**：逐个读取 `e2e/*.json`，通过 auto-test-view MCP 执行（详见 [e2e-mcp.md](reference/e2e-mcp.md)）
3. 收集所有结果 → 写入 `results.json`（Schema 见 [schemas.md](reference/schemas.md)）
4. 分析失败用例（详见 [failure-analysis.md](reference/failure-analysis.md)）
5. 生成 `report.md`（模板见 [schemas.md](reference/schemas.md)）
6. 更新 status → `completed`
7. 输出执行汇总

### report — 查看测试报告

**触发**：用户要求查看报告

1. 读取 `results.json`
2. 如果 `report.md` 不存在或已过期，重新生成
3. 输出报告内容

### list — 列出测试任务

**触发**：用户要求查看所有测试任务

1. 扫描 `<项目>/.auto-test-view/tests/` 下所有子目录
2. 读取每个 `meta.json`
3. 输出列表

---

## 五、注意事项

1. **不要猜测测试数据**：从输入源提取，或使用明确的 fixture，不要编造业务数据
2. **E2E 的 element index 不是固定的**：页面 DOM 可能变化，优先使用 `execute_task`（自然语言）描述交互意图，而非硬编码 index
3. **敏感数据脱敏**：测试用例中不包含真实密码、API key、个人信息
4. **截图路径**：统一放在 `e2e/screenshots/` 下，命名为 `<case-id>-<step>-<状态>.png`
5. **并发限制**：E2E 测试通过 auto-test-view 串行执行（单浏览器窗口），不支持并发
6. **超时设置**：单元测试默认 15s，E2E 单步默认 120s，`execute_task` 默认 480s
