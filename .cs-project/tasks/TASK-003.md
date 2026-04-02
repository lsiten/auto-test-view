# TASK-003: PageIndex 语义索引集成

## 需求
集成 PageIndex 思路（语义索引 + LLM 推理匹配），当 page-agent 收到 execute_task 指令时，优先匹配已有录制，准确判断后回放，无匹配时回退 AI 探索。

## 方案

### 核心文件（重构后路径）
1. `electron/recorder/semantic-index.ts` - 语义索引器：PageIndex tree-based 索引 + LLM 推理检索
2. `electron/playback/matcher.ts` - 意图匹配器：3 阶段 PageIndex 检索（文档选择→结构分析→内容验证）
3. `electron/core/ipc-handlers.ts` - 修改 execute_task 流程，插入"先查录制"逻辑
4. `electron/preload.ts` - 暴露索引管理 API
5. `electron/ui/recorder-ui.html` - 索引状态、重建按钮
6. `lib/pageindex-service.py` - Python HTTP 服务包装 PageIndexClient

### 语义索引结构
每条录制生成 semantic profile：
- intentTags: 意图标签
- actionFlow: 操作流摘要
- scenarios: 适用场景
- pagePatterns: 页面 URL 模式
- inputFields: 涉及的输入字段
- fullDescription: 综合描述

### 匹配流程
1. 预筛选：LLM 对比指令 vs 语义摘要 → 候选
2. 精细判断：加载完整步骤 + 当前页面上下文 → LLM 综合评分
3. 高置信度 → 回放录制；否则 → 正常 AI 探索

### 综合判断维度
- name, summary, group
- startUrl, urls (页面范围)
- stepGroups labels (操作阶段)
- steps: tool, text, args, url (每步详情)

## 验收标准
1. [x] 录制保存时自动生成语义索引（通过 PageIndex service 索引 Markdown 文档）
2. [x] execute_task 时优先匹配已有录制（MCP server 中 execute_task 先调用 matchRecording）
3. [x] 匹配判断综合所有字段（3 阶段 PageIndex 检索：文档选择→结构分析→内容验证）
4. [x] 高置信度匹配时自动回放录制步骤（confidence >= 0.75 触发 replayRecording）
5. [x] 无匹配或低置信度时回退正常 page-agent
6. [x] 支持手动重建索引（rebuildAllProfiles API）
7. [x] 使用现有 LLM 配置（LLM_BASE_URL/KEY/MODEL → litellm OPENAI_API_BASE/KEY）

## 测试覆盖
- `tests/recording-semantic-index.test.ts`: 25 个单元测试
- `tests/recording-matcher.test.ts`: 22 个单元测试（3 阶段匹配 + 回放）
- `tests/pageindex-service.test.ts`: 8 个集成测试（Python 服务依赖可选）
- 总计: 47 通过 / 8 跳过

## 状态
- [x] 方案设计
- [x] 开发
- [x] 测试
- [x] 完成

## 完成记录
- PageIndex 集成完成: 2026-04-01
- 自动化测试编写完成: 2026-04-02
- 文件路径已随 TASK-004 目录重构更新: 2026-04-02
