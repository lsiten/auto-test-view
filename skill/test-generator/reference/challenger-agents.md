# Challenger Agent 三角色审查

> **核心目标**：消除测试用例生成者的确认偏差。生成者倾向于"证明代码正确"，而 Challenger 的职责是"证明测试不够好"。

## 设计原则

1. **独立性**：3 个 Challenger 互不通信，各自独立审查，避免群体思维
2. **对抗性**：Challenger 的 KPI 是"找到问题"，不是"确认没问题"
3. **并行执行**：3 个 Agent 同时启动，通过 Agent tool 并行调用
4. **结果可追溯**：每个发现记录到 `meta.json` 的 `challengerReview` 字段

---

## 三个 Challenger 角色

### 1. 覆盖率挑战者（Coverage Challenger）

**职责**：找出测试没有覆盖到的场景

**审查维度**：

| 维度 | 检查内容 |
|------|----------|
| 分支覆盖 | 每个 if/else/switch/三元表达式是否都有对应测试 |
| 异常路径 | throw/reject/error return 是否都被测试 |
| 边界值 | 空数组、空字符串、null、undefined、0、负数、MAX_SAFE_INTEGER |
| 参数组合 | 可选参数的有/无组合是否充分 |
| 状态转换 | 状态机的每条边（transition）是否被覆盖 |
| 并发/竞态 | 是否需要并发测试（多次快速调用、重入） |
| 依赖交互 | 外部依赖的各种返回场景（成功/失败/超时/空数据） |

**输出格式**：

```json
{
  "role": "coverage-challenger",
  "findings": [
    {
      "severity": "high | medium | low",
      "category": "missing-branch | missing-edge-case | missing-error-path | missing-boundary | missing-combination",
      "description": "saveRecording 未测试磁盘写入失败（writeFileSync 抛异常）的场景",
      "suggestion": "新增测试：mock writeFileSync 抛 ENOSPC 错误，验证函数行为",
      "affectedFunction": "saveRecording",
      "action": "add",
      "proposedCase": {
        "name": "should handle disk full error on save",
        "type": "unit"
      }
    }
  ],
  "summary": { "total": 5, "high": 2, "medium": 2, "low": 1 }
}
```

---

### 2. 质量挑战者（Quality Challenger）

**职责**：找出测试本身的质量问题（测试写得不好、断言不充分、mock 不正确）

**审查维度**：

| 维度 | 检查内容 |
|------|----------|
| 断言充分性 | 是否只检查了返回值而忽略了副作用（文件写入、状态变更） |
| 断言精确性 | 是否用了 `toBeTruthy()` 等模糊断言而非 `toBe(true)` |
| Mock 正确性 | Mock 行为是否与真实实现一致（参数顺序、返回类型、异常类型） |
| 测试隔离 | 测试之间是否共享可变状态、执行顺序是否影响结果 |
| 测试命名 | 测试名是否清晰描述被测行为（而非实现细节） |
| 测试独立性 | 每个 it() 是否只测试一件事 |
| 误报风险 | 测试是否可能在代码有 bug 时仍然通过（假阳性） |
| Fixture 质量 | 测试数据是否有意义、是否覆盖了真实场景 |

**输出格式**：

```json
{
  "role": "quality-challenger",
  "findings": [
    {
      "severity": "high | medium | low",
      "category": "weak-assertion | mock-mismatch | test-coupling | false-positive-risk | poor-naming | poor-fixture",
      "description": "TC-009 updateIndex 测试只验证了 writeFileSync 被调用，未验证写入的 JSON 内容是否正确",
      "suggestion": "补充断言：解析 writeFileSync 的第二个参数，验证 index 包含新记录的 id 和 name",
      "affectedCase": "TC-009",
      "action": "modify"
    }
  ],
  "summary": { "total": 3, "high": 1, "medium": 1, "low": 1 }
}
```

---

### 3. 对抗挑战者（Adversarial Challenger）

**职责**：从攻击者视角审查——尝试构造能让测试通过但代码其实有 bug 的场景

**审查维度**：

| 维度 | 检查内容 |
|------|----------|
| 实现耦合 | 测试是否过度依赖内部实现（改了实现但功能没变，测试却挂了） |
| 突变存活 | 如果源码中某行被删除/修改，现有测试是否能检测到 |
| 逻辑冗余 | 多个测试是否在测同一件事（浪费但不增加覆盖） |
| 硬编码假设 | 测试中是否硬编码了不稳定的值（时间、路径、序列号） |
| 安全盲区 | 是否缺少安全相关测试（路径遍历、注入、越权） |
| 回归价值 | 测试是否能捕获真实的回归 bug（而非只验证当前实现） |

**思维模型**：对每个测试用例，假设你是一个"懒开发者"——你会怎样写出一个通过所有测试但其实有 bug 的实现？如果能构造出这样的实现，说明测试不够好。

**输出格式**：

```json
{
  "role": "adversarial-challenger",
  "findings": [
    {
      "severity": "high | medium | low",
      "category": "implementation-coupling | mutation-survives | redundant-test | hardcoded-assumption | security-gap | low-regression-value",
      "description": "generateRecordingId 的 3 个测试都依赖日期格式 YYYYMMDD，但如果实现改为 YYYY-MM-DD 格式并同时修改 ID 校验正则，所有测试都会挂但功能其实没问题",
      "suggestion": "测试应验证 ID 的唯一性和单调递增性，而非绑定具体格式",
      "affectedCase": "TC-004, TC-005, TC-006",
      "action": "modify"
    }
  ],
  "summary": { "total": 2, "high": 1, "medium": 1, "low": 0 }
}
```

---

## 执行流程

```
generate 生成初始用例（draft）
  |
  |--- 1. Coverage Challenger ---\
  |--- 2. Quality Challenger  ----+-- 并行执行（Agent tool x 3）
  \--- 3. Adversarial Challenger-/
                |
         收集 3 份审查报告
                |
         整合 + 去重 + 冲突仲裁
                |
         自动修正用例（新增/修改/删除）
                |
         更新 meta.json（challengerReview 字段）
                |
         输出用例列表 + 审查摘要 → 等待用户确认
```

---

## Agent tool 调用规范

3 个 Challenger **必须**通过 Agent tool 并行调用，**禁止**主 Claude 扮演 Challenger 角色。

**每个 Challenger 的 prompt 必须包含**：

1. **角色声明**：`你是 [角色名]，你的唯一职责是找出测试用例的不足`
2. **被测源码**：完整内联（不可让 Agent 自己去读）
3. **当前测试用例**：完整内联
4. **审查维度清单**：从上方对应角色的表格中内联
5. **输出格式要求**：JSON 格式（上方模板）
6. **对抗性提示**：`你的目标是找到问题，不是确认没问题。如果你没有发现任何问题，说明你审查得不够仔细。`

**调用示例**：

```
description: "Coverage Challenger: review recorder-store tests"
prompt: |
  你是覆盖率挑战者（Coverage Challenger）。你的唯一职责是找出以下测试用例中缺失的测试场景。
  你的目标是找到问题，不是确认没问题。如果你没有发现任何问题，说明你审查得不够仔细。

  ## 被测源码
  [内联完整源码]

  ## 当前测试用例
  [内联完整测试文件]

  ## 审查维度
  - 分支覆盖：每个 if/else/switch 是否都有对应测试
  - 异常路径：throw/reject/error return 是否都被测试
  - 边界值：空数组、空字符串、null、undefined、0
  - 参数组合：可选参数的有/无组合
  - 状态转换：状态机的每条边是否被覆盖
  - 并发/竞态：多次快速调用、重入
  - 依赖交互：外部依赖的各种返回场景

  ## 输出格式
  返回 JSON（格式见上方模板），每个 finding 包含 severity/category/description/suggestion/action
```

---

## 整合与冲突仲裁

收集 3 个 Challenger 的结果后，主 Claude 负责整合：

1. **去重**：不同 Challenger 可能指出同一个问题 → 合并，保留最高 severity
2. **冲突仲裁**：
   - Quality 说"断言太少" + Adversarial 说"测试耦合实现" → 补充行为断言而非实现断言
   - Coverage 说"缺少并发测试" + 实际代码无并发场景 → 标记为 low，不新增
3. **severity 阈值**：
   - `high` → 必须处理（新增/修改/删除用例）
   - `medium` → 默认处理，用户可在确认时跳过
   - `low` → 记录但不自动处理，展示给用户决定
4. **自动修正**：根据 findings 直接修改测试文件，然后在确认列表中标注哪些是 Challenger 驱动的变更

---

## 跳过 Challenger 审查

以下场景可跳过（但必须在 meta.json 中记录 `"challengerReview": { "skipped": true, "reason": "..." }`）：

1. 用户明确要求跳过：`生成测试 --skip-review`
2. 用例总数 <= 3：审查成本大于收益
3. 重新生成时仅微调了个别用例（非全量生成）
