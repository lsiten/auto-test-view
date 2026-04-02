/**
 * Recording matcher: matches user task instructions to existing recordings.
 *
 * Uses the PageIndex tree-based retrieval approach with dual-scope priority:
 *   1. Try matching against project-scope recordings first
 *   2. Fall back to global-scope recordings if no project match
 *
 * Each scope goes through a 3-phase matching pipeline:
 *   Phase 1: Get indexed documents, LLM picks best candidate from metadata
 *   Phase 2: Get document tree structure, LLM identifies relevant nodes
 *   Phase 3: Get full content for matched nodes, LLM verifies the match
 *
 * When a match is confirmed, the recording is replayed directly instead of
 * having page-agent explore from scratch.
 */

import { logger } from "../core/logger";
import type { Recording, RecordingScope } from "../recorder/store";
import { getRecording } from "../recorder/store";
import {
  type LlmConfig,
  callLlm,
  isPageIndexAvailable,
  getDocumentList,
  getDocumentStructure,
  getDocumentContent,
  getDocMap,
} from "../recorder/semantic-index";
import {
  navigateTo,
  clickElement,
  inputText,
  scrollPage,
  executeTask as sendTaskToAgent,
  goBack,
  goForward,
  reloadPage,
} from "../core/ipc-handlers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatchResult {
  readonly matched: boolean;
  readonly recordingId: string | null;
  readonly recordingName: string | null;
  readonly confidence: number;
  readonly reason: string;
  readonly recording: Recording | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIDENCE_THRESHOLD = 0.75;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * Phase 1: Pick the most relevant document from the indexed list.
 */
const buildDocSelectionPrompt = (
  task: string,
  currentUrl: string | null,
  documents: ReadonlyArray<{
    readonly doc_id: string;
    readonly doc_name: string;
    readonly doc_description: string;
    readonly path: string;
  }>
): string => {
  const docList = documents
    .map(
      (d, i) =>
        `${i + 1}. [${d.doc_id}] ${d.doc_name}\n   描述: ${d.doc_description}\n   来源: ${d.path}`
    )
    .join("\n");

  return `你是一个浏览器操作录制匹配器。根据用户指令，从已索引的录制文档列表中找出最可能匹配的录制。

用户指令: "${task}"
${currentUrl ? `当前页面URL: ${currentUrl}` : ""}

已索引的录制文档:
${docList}

推理要求:
1. 综合判断文档名称和描述
2. 描述中包含录制的摘要、访问页面、步骤概要等信息
3. 考虑页面URL模式是否与当前上下文匹配
4. 如果没有足够匹配的录制，matchDocId 返回 null

仅返回JSON（不要markdown格式）:
{
  "reasoning": "推理过程：分析了哪些文档，为什么选择或排除",
  "matchDocId": "doc_id值" 或 null,
  "confidence": 0.0-1.0,
  "reason": "选择原因"
}`;
};

/**
 * Phase 2: Identify relevant content nodes from the document structure.
 */
const buildNodeSelectionPrompt = (
  task: string,
  currentUrl: string | null,
  structure: unknown
): string => {
  return `你是一个录制内容检索器。根据用户指令，从录制文档的树结构中找出需要详细查看的节点。

用户指令: "${task}"
${currentUrl ? `当前页面URL: ${currentUrl}` : ""}

文档树结构（标题 + 摘要，无完整内容）:
${JSON.stringify(structure, null, 2)}

请找出与用户意图最相关的内容节点（通常是步骤组和步骤详情），返回需要查看完整内容的行范围。

仅返回JSON（不要markdown格式）:
{
  "reasoning": "需要查看哪些节点来验证匹配",
  "pages": "行范围（如 '1-50' 或 '10-30,40-60'）",
  "initialConfidence": 0.0-1.0
}`;
};

/**
 * Phase 3: Detailed verification with full recording content.
 */
const buildVerificationPrompt = (
  task: string,
  currentUrl: string | null,
  content: unknown,
  recording: Recording
): string => {
  return `你是一个录制验证器。根据录制的完整内容，详细检查是否能满足用户需求。

用户指令: "${task}"
${currentUrl ? `当前页面URL: ${currentUrl}` : ""}

录制完整内容（来自PageIndex索引）:
${JSON.stringify(content, null, 2)}

录制元数据:
- ID: ${recording.id}
- 名称: ${recording.name}
- 分组: ${recording.group}
- 起始URL: ${recording.startUrl}
- 访问页面: ${recording.urls.join(", ")}
- 总步骤: ${recording.totalSteps}

验证维度（必须逐项检查）:
1. 流程完整性: 录制操作流程能否完整完成用户指令的任务？
2. 页面一致性: 录制涉及的页面/系统是否与用户当前上下文一致？
3. 操作合理性: 每步具体操作（点击什么、输入什么、在哪个页面）是否合理？
4. 排除误匹配: 是否有明显不匹配（如用户要操作A系统但录制是B系统的）？
5. 输入数据: 录制中的输入值是否可以直接使用或通过占位符替换？

仅返回JSON（不要markdown格式）:
{
  "match": true或false,
  "confidence": 0.0-1.0,
  "reason": "详细的验证判断理由"
}`;
};

// ---------------------------------------------------------------------------
// JSON response parsing
// ---------------------------------------------------------------------------

const parseJsonResponse = (text: string): unknown => {
  const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
};

// ---------------------------------------------------------------------------
// Reverse doc map lookup: doc_id -> recording_id (within a scope)
// ---------------------------------------------------------------------------

const findRecordingIdByDocId = (docId: string, scope?: RecordingScope): string | null => {
  const docMap = getDocMap(scope);
  for (const [recId, entry] of Object.entries(docMap)) {
    if (entry.docId === docId) return recId;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Matching (PageIndex tree-based retrieval) - single scope
// ---------------------------------------------------------------------------

const matchInScope = async (
  task: string,
  currentUrl: string | null,
  config: LlmConfig,
  scope: RecordingScope
): Promise<MatchResult> => {
  const noMatch = (reason: string, partial?: Partial<MatchResult>): MatchResult => ({
    matched: false,
    recordingId: null,
    recordingName: null,
    confidence: 0,
    reason,
    recording: null,
    ...partial,
  });

  // Phase 1: Get document list for this scope and LLM selection
  let documents: ReadonlyArray<{
    doc_id: string;
    doc_name: string;
    doc_description: string;
    path: string;
  }>;
  try {
    documents = await getDocumentList(scope);
  } catch (err) {
    logger.warn(`[Matcher] Failed to get document list for scope ${scope}`, err);
    return noMatch(`Failed to get document list from PageIndex service (scope: ${scope})`);
  }

  if (documents.length === 0) {
    return noMatch(`No recordings indexed for scope: ${scope}`);
  }

  logger.info(`[Matcher] Phase 1 (${scope}): Selecting from ${documents.length} documents for "${task}"`);

  let selectionResult: {
    reasoning: string;
    matchDocId: string | null;
    confidence: number;
    reason: string;
  };
  try {
    const prompt = buildDocSelectionPrompt(task, currentUrl, documents);
    const response = await callLlm([{ role: "user", content: prompt }], config);
    selectionResult = parseJsonResponse(response) as typeof selectionResult;
  } catch (err) {
    logger.error(`[Matcher] Phase 1 (${scope}) document selection failed`, err);
    return noMatch(`Document selection error: ${err instanceof Error ? err.message : String(err)}`);
  }

  logger.info(
    `[Matcher] Phase 1 (${scope}) result: docId=${selectionResult.matchDocId}, confidence=${selectionResult.confidence}`
  );

  if (!selectionResult.matchDocId || selectionResult.confidence < CONFIDENCE_THRESHOLD) {
    return noMatch(selectionResult.reason, {
      confidence: selectionResult.confidence,
    });
  }

  const matchedDocId = selectionResult.matchDocId;

  // Resolve recording ID from doc map
  const recordingId = findRecordingIdByDocId(matchedDocId, scope);
  if (!recordingId) {
    return noMatch(`No recording mapping found for doc ${matchedDocId} (scope: ${scope})`);
  }

  const recording = getRecording(recordingId, scope);
  if (!recording) {
    return noMatch("Recording not found on disk", { recordingId });
  }

  // Phase 2: Get document structure and identify content nodes
  logger.info(`[Matcher] Phase 2 (${scope}): Analyzing structure of doc ${matchedDocId}`);

  let structure: unknown;
  try {
    structure = await getDocumentStructure(matchedDocId);
  } catch (err) {
    logger.error(`[Matcher] Failed to get document structure (${scope})`, err);
    return noMatch(`Structure retrieval error: ${err instanceof Error ? err.message : String(err)}`, {
      recordingId,
      recordingName: recording.name,
      confidence: selectionResult.confidence,
    });
  }

  let nodeResult: {
    reasoning: string;
    pages: string;
    initialConfidence: number;
  };
  try {
    const prompt = buildNodeSelectionPrompt(task, currentUrl, structure);
    const response = await callLlm([{ role: "user", content: prompt }], config);
    nodeResult = parseJsonResponse(response) as typeof nodeResult;
  } catch (err) {
    logger.error(`[Matcher] Phase 2 (${scope}) node selection failed`, err);
    return noMatch(`Node selection error: ${err instanceof Error ? err.message : String(err)}`, {
      recordingId,
      recordingName: recording.name,
      confidence: selectionResult.confidence,
    });
  }

  // Phase 3: Get full content and verify
  logger.info(`[Matcher] Phase 3 (${scope}): Verifying with content (pages: ${nodeResult.pages})`);

  let content: unknown;
  try {
    content = await getDocumentContent(matchedDocId, nodeResult.pages);
  } catch (err) {
    logger.error(`[Matcher] Failed to get document content (${scope})`, err);
    return noMatch(`Content retrieval error: ${err instanceof Error ? err.message : String(err)}`, {
      recordingId,
      recordingName: recording.name,
      confidence: nodeResult.initialConfidence,
    });
  }

  let verifyResult: { match: boolean; confidence: number; reason: string };
  try {
    const prompt = buildVerificationPrompt(task, currentUrl, content, recording);
    const response = await callLlm([{ role: "user", content: prompt }], config);
    verifyResult = parseJsonResponse(response) as typeof verifyResult;
  } catch (err) {
    logger.error(`[Matcher] Phase 3 (${scope}) verification failed`, err);
    return noMatch(`Verification error: ${err instanceof Error ? err.message : String(err)}`, {
      recordingId,
      recordingName: recording.name,
      confidence: nodeResult.initialConfidence,
    });
  }

  const finalMatch = verifyResult.match && verifyResult.confidence >= CONFIDENCE_THRESHOLD;
  logger.info(
    `[Matcher] Final (${scope}): ${finalMatch ? "MATCH" : "NO MATCH"} ` +
    `(confidence=${verifyResult.confidence}) - ${verifyResult.reason}`
  );

  return {
    matched: finalMatch,
    recordingId: recording.id,
    recordingName: recording.name,
    confidence: verifyResult.confidence,
    reason: verifyResult.reason,
    recording: finalMatch ? recording : null,
  };
};

// ---------------------------------------------------------------------------
// Matching (public API) - project first, then global
// ---------------------------------------------------------------------------

export const matchRecording = async (
  task: string,
  currentUrl: string | null,
  config: LlmConfig
): Promise<MatchResult> => {
  if (!isPageIndexAvailable()) {
    logger.warn("[Matcher] PageIndex service not available");
    return {
      matched: false,
      recordingId: null,
      recordingName: null,
      confidence: 0,
      reason: "PageIndex service not available",
      recording: null,
    };
  }

  // Round 1: Try project scope first
  logger.info("[Matcher] Round 1: searching project scope");
  const projectResult = await matchInScope(task, currentUrl, config, "project");
  if (projectResult.matched) {
    logger.info("[Matcher] Matched in project scope");
    return projectResult;
  }

  // Round 2: Fall back to global scope
  logger.info("[Matcher] Round 2: searching global scope");
  const globalResult = await matchInScope(task, currentUrl, config, "global");
  if (globalResult.matched) {
    logger.info("[Matcher] Matched in global scope");
    return globalResult;
  }

  // Neither scope matched - return the result with higher confidence
  logger.info("[Matcher] No match in either scope");
  if (globalResult.confidence > projectResult.confidence) {
    return globalResult;
  }
  return projectResult;
};

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isPlaceholder = (text: string): boolean => {
  if (!text) return false;
  return (
    /^\{\{.*\}\}$/.test(text) ||
    /^\[.*\]$/.test(text) ||
    /^<.*>$/.test(text)
  );
};

/**
 * Replay a matched recording by executing its steps sequentially.
 * For placeholder input fields, delegates to page-agent AI.
 */
export const replayRecording = async (
  recording: Recording
): Promise<{
  readonly success: boolean;
  readonly stepsExecuted: number;
  readonly totalSteps: number;
  readonly errors: ReadonlyArray<string>;
}> => {
  const errors: Array<string> = [];
  let stepsExecuted = 0;

  logger.info(
    `[Matcher] Replaying ${recording.id} "${recording.name}" (${recording.totalSteps} steps)`
  );

  for (const sg of recording.stepGroups) {
    for (const step of sg.steps) {
      try {
        switch (step.tool) {
          case "navigate": {
            const url = (step.args.url as string) || "";
            if (url) {
              await navigateTo(url);
              await delay(500);
            }
            break;
          }
          case "click_element": {
            const index = step.args.index as number;
            if (typeof index === "number" && index >= 0) {
              await clickElement(index);
            }
            break;
          }
          case "input_text": {
            const index = step.args.index as number;
            const text = (step.args.text as string) || "";
            if (isPlaceholder(text)) {
              const placeholder = (step.args.placeholder as string) || text;
              await sendTaskToAgent(
                `In the current input field, enter appropriate content. Field description: ${placeholder}`
              );
            } else if (typeof index === "number" && index >= 0 && text) {
              await inputText(index, text);
            }
            break;
          }
          case "scroll": {
            const dir = step.args.direction as
              | "up"
              | "down"
              | "left"
              | "right";
            const pages = (step.args.pages as number) || 1;
            await scrollPage(dir, pages);
            break;
          }
          case "go_back":
            await goBack();
            await delay(300);
            break;
          case "go_forward":
            await goForward();
            await delay(300);
            break;
          case "refresh":
            await reloadPage();
            await delay(300);
            break;
          default:
            logger.warn(`[Matcher] Unknown tool "${step.tool}", skipping`);
            break;
        }
        stepsExecuted++;
        await delay(300);
      } catch (err) {
        const msg = `Step ${step.seq} [${step.tool}] failed: ${err instanceof Error ? err.message : String(err)}`;
        logger.warn(`[Matcher] ${msg}`);
        errors.push(msg);
      }
    }
  }

  const success = errors.length === 0;
  logger.info(
    `[Matcher] Replay ${success ? "completed" : "finished with errors"}: ` +
    `${stepsExecuted}/${recording.totalSteps} steps, ${errors.length} errors`
  );

  return { success, stepsExecuted, totalSteps: recording.totalSteps, errors };
};
