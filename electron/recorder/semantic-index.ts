/**
 * Semantic index for recordings using PageIndex source-code integration.
 *
 * Architecture:
 *   - Python HTTP service (`lib/pageindex-service.py`) wraps PageIndexClient
 *   - Electron lazy-starts the service on first use, communicates via HTTP
 *   - Each recording is converted to Markdown and indexed as a separate document
 *   - Retrieval uses PageIndex tree-based approach (structure + content)
 *
 * Storage layout under ~/.auto-test-view/:
 *   docs/       - Markdown versions of recordings (named {scope}_{id}.md)
 *   pageindex/  - PageIndex workspace (JSON index files)
 *   pageindex/doc-map.json - mapping: recordingId -> { docId, scope }
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { type ChildProcess, execSync, spawn } from "child_process";
import { logger } from "../core/logger";
import { ensureLlmService, resolvePythonPath } from "../core/llm-service";
import type { Recording, RecordingScope } from "./store";
import { listRecordings, getRecording } from "./store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

interface PageIndexDocument {
  readonly doc_id: string;
  readonly doc_name: string;
  readonly doc_description: string;
  readonly type: string;
  readonly path: string;
}

interface DocMapEntry {
  readonly docId: string;
  readonly scope: RecordingScope;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PAGEINDEX_SERVICE_SCRIPT = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "lib",
  "pageindex-service.py"
);

const PAGEINDEX_PORT = 3397;
const PAGEINDEX_BASE_URL = `http://127.0.0.1:${PAGEINDEX_PORT}`;

const getBaseDir = (): string =>
  path.join(os.homedir(), ".auto-test-view");

const getDocsDir = (): string =>
  path.join(getBaseDir(), "docs");

const getWorkspaceDir = (): string =>
  path.join(getBaseDir(), "pageindex");

const ensureDirs = (): void => {
  for (const dir of [getDocsDir(), getWorkspaceDir()]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
};

// ---------------------------------------------------------------------------
// LLM client (for matching prompts - uses shared litellm service)
// ---------------------------------------------------------------------------

export const callLlm = async (
  messages: ReadonlyArray<{ readonly role: string; readonly content: string }>,
  _config: LlmConfig
): Promise<string> => {
  // Use the shared litellm service
  const llmResolved = await ensureLlmService();
  const url = `${llmResolved.baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${llmResolved.apiKey}`,
    },
    body: JSON.stringify({
      model: _config.model,
      messages,
      max_tokens: 4096,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM call failed: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as {
    readonly choices: ReadonlyArray<{
      readonly message: { readonly content: string };
    }>;
  };
  return data.choices[0].message.content;
};

// ---------------------------------------------------------------------------
// PageIndex service lifecycle (lazy start)
// ---------------------------------------------------------------------------

let serviceProcess: ChildProcess | null = null;
let serviceReady = false;
let pageIndexConfig: LlmConfig | null = null;

/** Store config without starting any service */
export const setPageIndexConfig = (config: LlmConfig): void => {
  pageIndexConfig = config;
};

/**
 * Spawn the PageIndex Python HTTP service process.
 */
/**
 * Kill any existing process listening on the given port.
 * Prevents zombie processes from accumulating across restarts.
 */
const killProcessOnPort = (port: number): void => {
  try {
    const output = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
    if (output) {
      const pids = output.split("\n").map((p) => p.trim()).filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGTERM");
          logger.info(`Killed stale process on port ${port}: PID ${pid}`);
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // lsof returns non-zero when no process found — expected
  }
};

const startPageIndexProcess = (llmBaseUrl: string, llmApiKey: string): void => {
  if (serviceProcess) return;

  ensureDirs();

  if (!fs.existsSync(PAGEINDEX_SERVICE_SCRIPT)) {
    logger.error(`[PageIndex] Service script not found: ${PAGEINDEX_SERVICE_SCRIPT}`);
    return;
  }

  // Kill any stale process from a previous run
  killProcessOnPort(PAGEINDEX_PORT);

  // Map app's LLM config to PageIndex environment variables.
  // PageIndex uses HTTP calls to the shared litellm service via OPENAI_API_BASE.
  const pageindexModel = (pageIndexConfig?.model ?? "").includes("/")
    ? pageIndexConfig!.model
    : `openai/${pageIndexConfig!.model}`;

  const env = {
    ...process.env,
    OPENAI_API_KEY: llmApiKey,
    OPENAI_API_BASE: llmBaseUrl,
    PAGEINDEX_MODEL: pageindexModel,
  };

  const workspaceDir = getWorkspaceDir();

  const pythonBin = resolvePythonPath();
  logger.info(`[PageIndex] Using Python at ${pythonBin}`);
  serviceProcess = spawn(
    pythonBin,
    [PAGEINDEX_SERVICE_SCRIPT, String(PAGEINDEX_PORT), workspaceDir],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );

  serviceProcess.stdout?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      logger.info(text);
    }
    if (text.includes("Service ready")) {
      serviceReady = true;
      logger.info("[PageIndex] Service is ready");
    }
  });

  serviceProcess.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      logger.warn(`[PageIndex stderr] ${text}`);
    }
  });

  serviceProcess.on("exit", (code) => {
    logger.info(`[PageIndex] Service exited with code ${code}`);
    serviceProcess = null;
    serviceReady = false;
  });

  serviceProcess.on("error", (err) => {
    logger.error("[PageIndex] Service spawn error", err);
    serviceProcess = null;
    serviceReady = false;
  });

  logger.info(`[PageIndex] Spawning service on port ${PAGEINDEX_PORT}`);
};

/**
 * Stop the PageIndex service.
 */
export const stopPageIndexService = (): void => {
  if (serviceProcess) {
    serviceProcess.kill("SIGTERM");
    serviceProcess = null;
    serviceReady = false;
    logger.info("[PageIndex] Service stopped");
  }
};

// ---------------------------------------------------------------------------
// HTTP helpers for PageIndex service
// ---------------------------------------------------------------------------

const serviceRequest = async (
  endpoint: string,
  method: "GET" | "POST" = "POST",
  body?: Record<string, unknown>
): Promise<unknown> => {
  const url = `${PAGEINDEX_BASE_URL}${endpoint}`;
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body && method === "POST") {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    const errMsg = (data as { error?: string }).error ?? `HTTP ${response.status}`;
    throw new Error(`PageIndex service error: ${errMsg}`);
  }

  return data;
};

/**
 * Wait for the service to become ready (poll /status).
 */
const waitForService = async (timeoutMs: number = 30_000): Promise<boolean> => {
  if (serviceReady) return true;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await serviceRequest("/status", "GET");
      serviceReady = true;
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
};

/**
 * Ensure the PageIndex service is running and ready.
 * Lazy-starts the service on first call.
 */
const ensurePageIndexService = async (): Promise<boolean> => {
  if (serviceReady) return true;

  if (serviceProcess) {
    // Already spawning, wait for it
    return waitForService();
  }

  if (!pageIndexConfig) {
    logger.warn("[PageIndex] Config not set, cannot start service");
    return false;
  }

  // Ensure litellm service is up first (PageIndex needs it for LLM calls)
  const llmResolved = await ensureLlmService();

  // Now spawn PageIndex with litellm service URL as OPENAI_API_BASE
  startPageIndexProcess(llmResolved.baseUrl, llmResolved.apiKey);
  return waitForService();
};

// ---------------------------------------------------------------------------
// Recording -> Markdown conversion
// ---------------------------------------------------------------------------

const recordingToMarkdown = (rec: Recording): string => {
  const lines: Array<string> = [];

  lines.push(`# ${rec.id}: ${rec.name}`);
  lines.push("");
  lines.push(`- 分组: ${rec.group || "未分组"}`);
  lines.push(`- 摘要: ${rec.summary}`);
  lines.push(`- 起始URL: ${rec.startUrl}`);
  lines.push(`- 访问页面: ${rec.urls.join(", ")}`);
  lines.push(`- 步骤数: ${rec.totalSteps}`);
  lines.push(`- 时长: ${Math.round(rec.duration / 1000)}秒`);
  lines.push(`- 创建时间: ${rec.createdAt}`);
  lines.push("");

  for (const sg of rec.stepGroups) {
    lines.push(`## 步骤组: ${sg.label}`);
    lines.push("");

    for (const step of sg.steps) {
      lines.push(`### 步骤${step.seq}: ${step.tool}`);
      lines.push("");
      lines.push(`- 描述: ${step.text}`);
      lines.push(`- 页面: ${step.url}`);

      const relevantArgs = Object.entries(step.args).filter(
        ([, v]) => v !== undefined && v !== ""
      );
      if (relevantArgs.length > 0) {
        for (const [key, value] of relevantArgs) {
          lines.push(`- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
};

const writeRecordingDoc = (recording: Recording, scope: RecordingScope): string => {
  ensureDirs();
  const docPath = path.join(getDocsDir(), `${scope}_${recording.id}.md`);
  fs.writeFileSync(docPath, recordingToMarkdown(recording), "utf-8");
  return docPath;
};

const removeRecordingDoc = (recordingId: string, scope: RecordingScope): void => {
  const docPath = path.join(getDocsDir(), `${scope}_${recordingId}.md`);
  if (fs.existsSync(docPath)) {
    fs.unlinkSync(docPath);
  }
};

// ---------------------------------------------------------------------------
// Mapping: recording ID <-> PageIndex doc_id (with scope)
// ---------------------------------------------------------------------------

const DOC_MAP_FILE = "doc-map.json";

const getDocMapPath = (): string =>
  path.join(getWorkspaceDir(), DOC_MAP_FILE);

const loadDocMap = (): Record<string, DocMapEntry> => {
  const mapPath = getDocMapPath();
  if (!fs.existsSync(mapPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(mapPath, "utf-8"));
  } catch {
    return {};
  }
};

const saveDocMap = (map: Record<string, DocMapEntry>): void => {
  ensureDirs();
  fs.writeFileSync(getDocMapPath(), JSON.stringify(map, null, 2), "utf-8");
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Index a single recording via the PageIndex service.
 * Writes Markdown doc, sends to service for tree indexing.
 */
export const indexRecording = async (
  recording: Recording,
  _config: LlmConfig,
  scope: RecordingScope = "global"
): Promise<void> => {
  logger.info(`[PageIndex] Indexing recording ${recording.id} (scope: ${scope})`);

  const docPath = writeRecordingDoc(recording, scope);

  const ready = await ensurePageIndexService();
  if (!ready) {
    logger.error("[PageIndex] Service not available, skipping indexing");
    return;
  }

  try {
    const result = (await serviceRequest("/index", "POST", {
      file_path: docPath,
      mode: "md",
    })) as { doc_id: string };

    // Save recording ID -> { docId, scope } mapping
    const docMap = loadDocMap();
    const updated = { ...docMap, [recording.id]: { docId: result.doc_id, scope } };
    saveDocMap(updated);

    logger.info(
      `[PageIndex] Recording ${recording.id} indexed as doc ${result.doc_id} (scope: ${scope})`
    );
  } catch (err) {
    logger.error(`[PageIndex] Failed to index recording ${recording.id}`, err);
  }
};

/**
 * Remove a recording from the PageIndex service.
 */
export const removeProfile = async (
  recordingId: string,
  scope?: RecordingScope
): Promise<void> => {
  const docMap = loadDocMap();
  const entry = docMap[recordingId];

  // If scope is specified, only remove if it matches; otherwise use the stored scope
  const effectiveScope = scope ?? entry?.scope ?? "global";
  removeRecordingDoc(recordingId, effectiveScope);

  if (!entry) {
    logger.info(`[PageIndex] No doc mapping for ${recordingId}`);
    return;
  }

  // If scope filter is given and does not match, skip
  if (scope && entry.scope !== scope) {
    logger.info(`[PageIndex] Scope mismatch for ${recordingId}: stored=${entry.scope}, requested=${scope}`);
    return;
  }

  try {
    const ready = await ensurePageIndexService();
    if (ready) {
      await serviceRequest("/remove", "POST", { doc_id: entry.docId });
    }
  } catch (err) {
    logger.warn(`[PageIndex] Failed to remove doc ${entry.docId} from service`, err);
  }

  const { [recordingId]: _removed, ...rest } = docMap;
  saveDocMap(rest);
  logger.info(`[PageIndex] Removed doc for ${recordingId} (scope: ${effectiveScope})`);
};

/**
 * Rebuild the entire index: write all recording docs and re-index via service.
 */
export const rebuildAllProfiles = async (
  config: LlmConfig
): Promise<number> => {
  logger.info("[PageIndex] Rebuilding all recording indexes");

  const ready = await ensurePageIndexService();
  if (!ready) {
    throw new Error("PageIndex service not available");
  }

  // Clear existing docs
  const docsDir = getDocsDir();
  ensureDirs();
  const existingDocs = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"));
  for (const doc of existingDocs) {
    fs.unlinkSync(path.join(docsDir, doc));
  }

  // Remove all existing documents from service
  try {
    const listResult = (await serviceRequest("/list", "POST")) as {
      documents: ReadonlyArray<PageIndexDocument>;
    };
    for (const doc of listResult.documents) {
      await serviceRequest("/remove", "POST", { doc_id: doc.doc_id });
    }
  } catch (err) {
    logger.warn("[PageIndex] Failed to clear existing service docs", err);
  }

  // Write and index all recordings (from all scopes)
  const recordings = listRecordings();
  const docMap: Record<string, DocMapEntry> = {};
  let count = 0;

  for (const entry of recordings) {
    const rec = getRecording(entry.id, entry.scope);
    if (!rec) continue;

    const recScope = entry.scope;
    const docPath = writeRecordingDoc(rec, recScope);
    try {
      const result = (await serviceRequest("/index", "POST", {
        file_path: docPath,
        mode: "md",
      })) as { doc_id: string };
      docMap[rec.id] = { docId: result.doc_id, scope: recScope };
      count++;
      logger.info(`[PageIndex] Indexed ${rec.id} as ${result.doc_id} (scope: ${recScope})`);
    } catch (err) {
      logger.error(`[PageIndex] Failed to index ${rec.id}`, err);
    }
  }

  saveDocMap(docMap);
  logger.info(`[PageIndex] Rebuilt index for ${count} recordings`);
  return count;
};

/**
 * Get the list of all indexed documents from the service.
 * When scope is provided, only documents matching that scope are returned.
 */
export const getDocumentList = async (
  scope?: RecordingScope
): Promise<ReadonlyArray<PageIndexDocument>> => {
  const ready = await ensurePageIndexService();
  if (!ready) return [];

  const result = (await serviceRequest("/list", "POST")) as {
    documents: ReadonlyArray<PageIndexDocument>;
  };

  if (!scope) {
    return result.documents;
  }

  // Filter by scope using doc-map
  const docMap = loadDocMap();
  const docIdsForScope = new Set(
    Object.values(docMap)
      .filter((entry) => entry.scope === scope)
      .map((entry) => entry.docId)
  );

  return result.documents.filter((doc) => docIdsForScope.has(doc.doc_id));
};

/**
 * Get document structure (tree without text) for LLM reasoning.
 */
export const getDocumentStructure = async (
  docId: string
): Promise<unknown> => {
  const ready = await ensurePageIndexService();
  if (!ready) throw new Error("PageIndex service not available");
  return serviceRequest("/structure", "POST", { doc_id: docId });
};

/**
 * Get document content for specific pages/lines.
 */
export const getDocumentContent = async (
  docId: string,
  pages: string
): Promise<unknown> => {
  const ready = await ensurePageIndexService();
  if (!ready) throw new Error("PageIndex service not available");
  return serviceRequest("/content", "POST", { doc_id: docId, pages });
};

/**
 * Get document metadata.
 */
export const getDocumentMeta = async (
  docId: string
): Promise<unknown> => {
  const ready = await ensurePageIndexService();
  if (!ready) throw new Error("PageIndex service not available");
  return serviceRequest("/document", "POST", { doc_id: docId });
};

/**
 * Get index status.
 * When scope is provided, only counts recordings/docs for that scope.
 */
export const getIndexStatus = (scope?: RecordingScope): {
  readonly serviceRunning: boolean;
  readonly totalDocs: number;
  readonly totalRecordings: number;
  readonly unindexed: ReadonlyArray<string>;
} => {
  const recordings = listRecordings(undefined, scope);
  const docMap = loadDocMap();

  // Filter doc-map entries by scope if specified
  const indexedIds = new Set(
    Object.entries(docMap)
      .filter(([, entry]) => !scope || entry.scope === scope)
      .map(([recId]) => recId)
  );

  const unindexed = recordings.filter((r) => !indexedIds.has(r.id)).map((r) => r.id);

  return {
    serviceRunning: serviceReady,
    totalDocs: indexedIds.size,
    totalRecordings: recordings.length,
    unindexed,
  };
};

/**
 * Check if PageIndex service is available.
 */
export const isPageIndexAvailable = (): boolean => {
  return pageIndexConfig !== null && fs.existsSync(PAGEINDEX_SERVICE_SCRIPT);
};

/**
 * Get the recording ID -> doc map.
 * When scope is provided, only entries matching that scope are returned.
 */
export const getDocMap = (scope?: RecordingScope): Readonly<Record<string, DocMapEntry>> => {
  const fullMap = loadDocMap();
  if (!scope) return fullMap;

  const filtered: Record<string, DocMapEntry> = {};
  for (const [recId, entry] of Object.entries(fullMap)) {
    if (entry.scope === scope) {
      filtered[recId] = entry;
    }
  }
  return filtered;
};
