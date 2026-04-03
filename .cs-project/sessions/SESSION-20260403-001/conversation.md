# SESSION-20260403-001 对话记录

## Round 1 — 需求调查
- 用户：项目启动内存溢出原因
- 分析：Electron(300MB) + PageIndex Python 进程加载 litellm(150-300MB) 是主要原因
- litellm 仅用于 HTTP 调用 + token 计数，但 import 时加载 100+ provider 适配

## Round 2 — 方案设计
- 两个公共服务最小化改造：
  1. LLM 服务（llm-proxy.ts）→ lazy start + singleton
  2. PageIndex 服务 → lazy start + 去除 litellm/pymupdf/PyPDF2 依赖
- 拆分：TASK-007-01(LLM) → TASK-007-02(PageIndex)
- 用户确认方案

## Round 3 — Gate Check + 开发
- 创建 TASK-007 任务文档 + 子任务
- 创建分支 task/TASK-007
- 分配 Agent，启动开发
