# TASK-007: 公共服务最小化改造（LLM + PageIndex 懒加载）

## 需求
启动时内存过高（~700MB），原因是 PageIndex Python 进程无条件加载 litellm（150-300MB）。
将 LLM 代理和 PageIndex 改为两个独立的公共服务：
- 按需懒加载（首次调用时启动）
- 多消费方共享同一实例
- 最小化依赖（仅保留本项目实际用到的能力）

## 子任务
- TASK-007-01: LLM Service 懒加载改造
- TASK-007-02: PageIndex Service 懒加载 + 去除 litellm

## 执行方案
TASK-007-01 → TASK-007-02（串行，PageIndex 依赖 LLM Service）

## 验收标准
1. 启动时不启动 LLM 代理和 PageIndex Python 进程
2. 首次 LLM 调用时自动启动 llm-proxy，后续调用复用
3. 首次索引/查询时自动启动 PageIndex 服务，后续调用复用
4. PageIndex Python 进程不再 import litellm/pymupdf/PyPDF2
5. page-agent LLM 调用链路不变（仍走 OpenAI 兼容格式）
6. 录制匹配（matcher）功能正常
7. 应用关闭时正确清理两个服务进程
8. TypeScript 编译通过

## 状态
- [x] 方案设计
- [x] 拆分确认
- [ ] 开发
- [ ] 验证
- [ ] 完成
