/**
 * IPC handlers for communication between main process and renderer (page-agent).
 * Each handler sends a command to the renderer and waits for the result.
 */

import { type BrowserWindow, ipcMain } from "electron";
import { logger } from "./logger";
import {
  startRecording,
  addStepGroup,
  onEvent as recorderOnEvent,
  stopRecording,
  getCurrentState as getRecorderState,
  isRecording,
} from "../recorder/recorder";
import {
  type RecordingScope,
  listRecordings,
  getRecording,
  updateRecording,
  deleteRecording,
  exportRecording,
  searchRecordings,
  batchDeleteRecordings,
  batchExportRecordings,
  batchMoveRecordings,
  deleteStep,
  updateStep,
} from "../recorder/store";
import {
  startTrialRun,
  trialControl,
  getTrialStatus,
} from "../playback/trial-runner";
import {
  type LlmConfig,
  indexRecording,
  removeProfile,
  rebuildAllProfiles,
  getIndexStatus,
} from "../recorder/semantic-index";

const DEFAULT_TIMEOUT_MS = 120_000;
const EXECUTE_TASK_TIMEOUT_MS = 300_000;

interface AgentCommand {
  readonly type: string;
  readonly payload?: unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

let pendingRequest: PendingRequest | null = null;
let mainWindow: BrowserWindow | null = null;
let llmConfig: LlmConfig | null = null;

/** Resolves when page-agent signals it's fully initialized in the renderer. */
let agentReadyResolve: (() => void) | null = null;
let agentReadyPromise: Promise<void> = new Promise((resolve) => {
  agentReadyResolve = resolve;
});

/**
 * Reset the readiness gate (call before navigation to a new page).
 */
export const resetAgentReady = (): void => {
  agentReadyPromise = new Promise((resolve) => {
    agentReadyResolve = resolve;
  });
};

/**
 * Wait for page-agent to be fully initialized after a navigation.
 * Resolves immediately if already ready, or times out after waitMs.
 */
export const waitForAgentReady = (waitMs: number = 30_000): Promise<void> => {
  return Promise.race([
    agentReadyPromise,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for page-agent readiness")), waitMs)
    ),
  ]);
};

export const setMainWindow = (win: BrowserWindow): void => {
  mainWindow = win;
};

export const setLlmConfig = (config: LlmConfig): void => {
  llmConfig = config;
};

export const getLlmConfig = (): LlmConfig | null => llmConfig;

export const getCurrentUrl = (): string | null => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const url = mainWindow.webContents.getURL();
  // Skip internal pages
  if (url.startsWith("file://")) return null;
  return url;
};

const sendCommandToRenderer = (
  command: AgentCommand,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<unknown> => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.reject(new Error("Browser window is not available"));
  }

  // Reject any existing pending request
  if (pendingRequest) {
    clearTimeout(pendingRequest.timer);
    pendingRequest.reject(new Error("Superseded by new command"));
    pendingRequest = null;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequest = null;
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command.type}`));
    }, timeoutMs);

    pendingRequest = { resolve, reject, timer };
    mainWindow!.webContents.send("agent-command", command);
  });
};

export const setupIpcHandlers = (): void => {
  ipcMain.handle("agent-result", (_event, result: unknown) => {
    if (pendingRequest) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.resolve(result);
      pendingRequest = null;
    }
    return undefined;
  });

  // Page-agent readiness signal from renderer
  ipcMain.on("page-agent-ready", () => {
    logger.info("page-agent ready signal received");
    if (agentReadyResolve) {
      agentReadyResolve();
    }
  });

  // -- Recorder IPC handlers --

  ipcMain.handle("record-event", (_event, recordEvent: { tool: string; args: Record<string, unknown>; url: string; text: string }) => {
    try {
      recorderOnEvent(recordEvent);
    } catch (err) {
      logger.error("record-event handler error", err);
    }
    return undefined;
  });

  ipcMain.handle("record-control", (_event, command: { type: string; label?: string; scope?: RecordingScope }) => {
    try {
      if (command.type === "add_step_group" && command.label) {
        addStepGroup(command.label);
        return { success: true };
      }
      if (command.type === "stop") {
        const recording = stopRecording(command.scope);
        // Trigger semantic indexing in background (non-blocking)
        if (llmConfig) {
          indexRecording(recording, llmConfig, command.scope).catch((err) => {
            logger.warn("[SemanticIndex] Background indexing failed", err);
          });
        }
        return recording;
      }
      return { error: `Unknown control command: ${command.type}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("record-control handler error", message);
      return { error: message };
    }
  });

  ipcMain.handle("get-recording-state", () => {
    return getRecorderState();
  });

  ipcMain.handle("recorder-list", (_event, group?: string, scope?: RecordingScope) => {
    return listRecordings(group, scope);
  });

  ipcMain.handle("recorder-get", (_event, id: string, scope?: RecordingScope) => {
    return getRecording(id, scope);
  });

  ipcMain.handle("recorder-update", (_event, id: string, data: { name?: string; group?: string }, scope?: RecordingScope) => {
    return updateRecording(id, data, scope);
  });

  ipcMain.handle("recorder-delete", async (_event, id: string, scope?: RecordingScope) => {
    await removeProfile(id, scope);
    return deleteRecording(id, scope);
  });

  ipcMain.handle("recorder-export", (_event, id: string, scope?: RecordingScope) => {
    return exportRecording(id, scope);
  });

  ipcMain.handle("recorder-search", (_event, query: string, scope?: RecordingScope) => {
    return searchRecordings(query, scope);
  });

  ipcMain.handle("recorder-delete-step", (_event, id: string, groupIndex: number, stepIndex: number, scope?: RecordingScope) => {
    return deleteStep(id, groupIndex, stepIndex, scope);
  });

  ipcMain.handle("recorder-update-step", (_event, id: string, groupIndex: number, stepIndex: number, data: { tool?: string; text?: string; args?: Record<string, unknown> }, scope?: RecordingScope) => {
    return updateStep(id, groupIndex, stepIndex, data, scope);
  });

  ipcMain.handle("recorder-batch-delete", (_event, ids: ReadonlyArray<string>, scope?: RecordingScope) => {
    return batchDeleteRecordings(ids, scope);
  });

  ipcMain.handle("recorder-batch-export", (_event, ids: ReadonlyArray<string>, scope?: RecordingScope) => {
    return batchExportRecordings(ids, scope);
  });

  ipcMain.handle("recorder-batch-move", (_event, ids: ReadonlyArray<string>, group: string, scope?: RecordingScope) => {
    return batchMoveRecordings(ids, group, scope);
  });

  // Trial run
  ipcMain.handle("trial-start", (_event, id: string) => {
    return startTrialRun(mainWindow!, id);
  });

  ipcMain.on("trial-control", (_event, command: string) => {
    trialControl(command);
  });

  ipcMain.handle("trial-status", () => {
    return getTrialStatus();
  });

  // -- Semantic index management --

  ipcMain.handle("semantic-index-status", () => {
    return getIndexStatus();
  });

  ipcMain.handle("semantic-index-rebuild", async () => {
    if (!llmConfig) {
      return { error: "LLM not configured" };
    }
    try {
      const count = await rebuildAllProfiles(llmConfig);
      return { success: true, indexed: count };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
  });

  // Proxy LLM fetch requests from renderer through the main process
  // to bypass mixed content (HTTPS page -> HTTP localhost) restrictions.
  ipcMain.handle(
    "llm-fetch",
    async (_event, url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      logger.info(`[IPC llm-fetch] ${init.method ?? "GET"} ${url}`);
      try {
        const response = await fetch(url, {
          method: init.method ?? "GET",
          headers: init.headers,
          body: init.body,
        });

        const bodyText = await response.text();
        logger.info(`[IPC llm-fetch] <- ${response.status}`);

        // Return a serializable response object that the renderer can use
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          bodyText,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[IPC llm-fetch] error: ${message}`);
        throw new Error(message);
      }
    }
  );
};

/**
 * Navigate to a URL. Waits for page-agent to be fully re-injected before returning.
 */
export const navigateTo = async (url: string): Promise<{ url: string; title: string }> => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Browser window is not available");
  }

  // Reset the readiness gate before navigation so we can wait for the new injection
  resetAgentReady();

  const loadPromise = new Promise<void>((resolve) => {
    mainWindow!.webContents.once("did-finish-load", () => resolve());
  });

  try {
    await mainWindow.loadURL(url);
  } catch {
    // External pages may reject loadURL due to redirects or sub-resource errors.
    // Wait for did-finish-load instead.
    await loadPromise;
  }

  // Wait for page-agent to signal readiness after injection
  try {
    await waitForAgentReady();
    logger.info("page-agent ready after navigation");
  } catch {
    logger.warn("page-agent readiness wait timed out, continuing anyway");
  }

  return {
    url: mainWindow.webContents.getURL(),
    title: mainWindow.webContents.getTitle(),
  };
};

/**
 * Execute a natural language task via page-agent.
 */
export const executeTask = async (task: string): Promise<unknown> => {
  return sendCommandToRenderer(
    { type: "execute_task", payload: { task } },
    EXECUTE_TASK_TIMEOUT_MS
  );
};

/**
 * Get the current browser/page state from page-agent.
 */
export const getPageState = async (): Promise<unknown> => {
  return sendCommandToRenderer({ type: "get_page_state" });
};

/**
 * Click an element by index.
 */
export const clickElement = async (index: number): Promise<unknown> => {
  return sendCommandToRenderer({ type: "click_element", payload: { index } });
};

/**
 * Input text into an element by index.
 */
export const inputText = async (index: number, text: string): Promise<unknown> => {
  return sendCommandToRenderer({ type: "input_text", payload: { index, text } });
};

/**
 * Scroll the page.
 */
export const scrollPage = async (
  direction: "up" | "down" | "left" | "right",
  pages: number = 1
): Promise<unknown> => {
  return sendCommandToRenderer({ type: "scroll", payload: { direction, pages } });
};

/**
 * Get agent execution status.
 */
export const getStatus = async (): Promise<unknown> => {
  return sendCommandToRenderer({ type: "get_status" });
};

/**
 * Stop the current task.
 */
export const stopTask = async (): Promise<unknown> => {
  return sendCommandToRenderer({ type: "stop_task" });
};

/**
 * Take a screenshot and return the file path.
 */
export const takeScreenshot = async (savePath?: string): Promise<string> => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Browser window is not available");
  }

  const image = await mainWindow.webContents.capturePage();
  const pngBuffer = image.toPNG();

  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");

  const outputPath = savePath ?? path.join(
    os.tmpdir(),
    `screenshot-${Date.now()}.png`
  );

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, pngBuffer);
  logger.info(`Screenshot saved to ${outputPath}`);
  return outputPath;
};

/**
 * Execute arbitrary JavaScript in the page and return the result.
 */
export const executeJs = async (code: string): Promise<unknown> => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Browser window is not available");
  }
  return mainWindow.webContents.executeJavaScript(code);
};

/**
 * Navigate back in browser history.
 */
export const goBack = async (): Promise<{ url: string; title: string }> => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Browser window is not available");
  }
  if (!mainWindow.webContents.canGoBack()) {
    throw new Error("No history to go back");
  }

  const loadPromise = new Promise<void>((resolve) => {
    mainWindow!.webContents.once("did-finish-load", () => resolve());
  });

  mainWindow.webContents.goBack();

  await Promise.race([
    loadPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);

  return {
    url: mainWindow.webContents.getURL(),
    title: mainWindow.webContents.getTitle(),
  };
};

/**
 * Navigate forward in browser history.
 */
export const goForward = async (): Promise<{ url: string; title: string }> => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Browser window is not available");
  }
  if (!mainWindow.webContents.canGoForward()) {
    throw new Error("No history to go forward");
  }

  const loadPromise = new Promise<void>((resolve) => {
    mainWindow!.webContents.once("did-finish-load", () => resolve());
  });

  mainWindow.webContents.goForward();

  await Promise.race([
    loadPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);

  return {
    url: mainWindow.webContents.getURL(),
    title: mainWindow.webContents.getTitle(),
  };
};

/**
 * Reload the current page.
 */
export const reloadPage = async (): Promise<{ url: string; title: string }> => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Browser window is not available");
  }

  const loadPromise = new Promise<void>((resolve) => {
    mainWindow!.webContents.once("did-finish-load", () => resolve());
  });

  mainWindow.webContents.reload();

  await Promise.race([
    loadPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);

  return {
    url: mainWindow.webContents.getURL(),
    title: mainWindow.webContents.getTitle(),
  };
};
