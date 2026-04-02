# SESSION-20260402-002 Conversation

## Round 1 - 需求接收
- 用户需求：基于 auto-test-view 工具生成测试用例的 skills
- 需要覆盖：单元测试、端到端测试、浏览器测试
- 浏览器测试使用该工具本身
- 当前阶段：investigating

## Round 2 - 调查 + 方案设计
- 分析项目现有测试结构：vitest 单元测试 + JSON suite E2E 测试
- 多轮需求细化：
  - 通用 skill（非 auto-test-view 专属）
  - 测试存放 .auto-test-view/tests/<task-name>/，按任务名组织
  - 输入源：CSV/MD/JSON 测试文件 + 需求文档 + 技术方案 + 代码
  - 完整生命周期：generate → confirm → run → report
  - 确认后修改需记录变更原因
  - 失败用例必须包含原因分析

## Round 3 - Skill 文件创建
- 轻量模式，直接写 skill 文件
- 创建 ~/.claude/skills/test-generator/SKILL.md
- 包含 10 个章节：输入源、输出目录、生命周期、操作指令、数据 Schema、报告模板、MCP 工具参考、单元测试规则、失败分析规则、注意事项
- 状态：completed
