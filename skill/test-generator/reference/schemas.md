# 数据 Schema

## meta.json

```json
{
  "taskName": "string — 任务名",
  "status": "draft | confirmed | running | completed",
  "sources": [
    {
      "type": "testcase | requirement | techspec | code",
      "path": "string — 文件路径",
      "format": "csv | markdown | json | typescript | javascript | pdf"
    }
  ],
  "createdAt": "ISO 8601 时间戳",
  "confirmedAt": "ISO 8601 | null",
  "executedAt": "ISO 8601 | null",
  "summary": {
    "total": "number",
    "unit": "number",
    "e2e": "number",
    "integration": "number"
  },
  "caseMapping": {
    "<source-case-id>": {
      "file": "string — 生成的测试文件路径",
      "test": "string — 测试名称或 case ID",
      "type": "unit | e2e | integration"
    }
  },
  "changelog": [
    {
      "caseId": "string",
      "file": "string",
      "action": "modified | added | removed",
      "reason": "string — 变更原因（必填）",
      "modifiedAt": "ISO 8601",
      "before": "string — 变更前摘要",
      "after": "string — 变更后摘要"
    }
  ],
  "challengerReview": {
    "executedAt": "ISO 8601 | null",
    "skipped": "boolean — 是否跳过审查",
    "skipReason": "string | undefined — 跳过原因",
    "challengers": [
      {
        "role": "coverage-challenger | quality-challenger | adversarial-challenger",
        "findings": "number — 发现总数",
        "high": "number",
        "medium": "number",
        "low": "number"
      }
    ],
    "totalFindings": "number",
    "actionsApplied": {
      "added": "number — 新增用例数",
      "modified": "number — 修改用例数",
      "removed": "number — 删除用例数"
    },
    "details": [
      {
        "role": "string — 角色",
        "severity": "high | medium | low",
        "category": "string — 问题分类",
        "description": "string — 问题描述",
        "action": "add | modify | remove | info",
        "result": "string — 处理结果"
      }
    ]
  }
}
```

## results.json

```json
{
  "taskName": "string",
  "executedAt": "ISO 8601",
  "duration": "number — 总耗时 ms",
  "summary": {
    "total": "number",
    "passed": "number",
    "failed": "number",
    "skipped": "number",
    "passRate": "string — 百分比"
  },
  "results": [
    {
      "caseId": "string — 来源用例 ID",
      "name": "string — 用例名称",
      "type": "unit | e2e | integration",
      "file": "string — 测试文件路径",
      "status": "pass | fail | skip",
      "duration": "number — ms",
      "error": "string | undefined — 错误信息（fail 时必填）",
      "failureReason": "string | undefined — 失败原因分析（fail 时必填）",
      "codeLocation": "string | undefined — 相关代码位置",
      "suggestion": "string | undefined — 修复建议",
      "skipReason": "string | undefined — 跳过原因（skip 时必填）",
      "screenshot": "string | undefined — 失败截图路径（e2e fail 时）"
    }
  ]
}
```

---

## report.md 生成模板

```markdown
# 测试报告: {taskName}

## 基本信息
| 项目 | 值 |
|------|-----|
| 任务名 | {taskName} |
| 执行时间 | {executedAt} |
| 总耗时 | {duration} |
| 来源文件 | {sources 列表} |

## 执行汇总
| 类型 | 总数 | 通过 | 失败 | 跳过 | 通过率 |
|------|------|------|------|------|--------|
| 单元测试 | {n} | {n} | {n} | {n} | {%} |
| E2E 浏览器 | {n} | {n} | {n} | {n} | {%} |
| 集成测试 | {n} | {n} | {n} | {n} | {%} |
| **合计** | **{n}** | **{n}** | **{n}** | **{n}** | **{%}** |

## 失败用例分析

（对每个 fail 用例生成如下段落）

### FAIL: {caseId} {name}
- **类型**: {type}
- **文件**: {file}
- **错误信息**: {error}
- **失败原因**: {failureReason}
- **代码位置**: {codeLocation}
- **修复建议**: {suggestion}
- **截图**: {screenshot}（仅 E2E）

## 跳过用例
| Case | 原因 |
|------|------|
| {caseId} {name} | {skipReason} |

## 变更记录
（如有 changelog 则展示）
| 时间 | Case | 操作 | 原因 |
|------|------|------|------|
| {modifiedAt} | {caseId} | {action} | {reason} |

## 全部用例明细
| # | Case ID | 名称 | 类型 | 状态 | 耗时 | 来源 |
|---|---------|------|------|------|------|------|
| {i} | {caseId} | {name} | {type} | {status} | {duration} | {source} |
```
