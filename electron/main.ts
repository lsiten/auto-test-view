/**
 * Electron main process entry point.
 * Sets up the BrowserWindow, CSP bypass, page-agent injection, IPC, and MCP server.
 */

import { app, BrowserWindow, session, dialog } from "electron";
import * as os from "os";
import * as path from "path";
import * as dotenv from "dotenv";
import { logger } from "./logger";
import { injectPageAgent } from "./agent-injector";
import { setupIpcHandlers, setMainWindow } from "./ipc-handlers";
import { startMcpServer } from "./mcp-server";
import { startLlmProxy } from "./llm-proxy";

dotenv.config();


const WELCOME_PAGE = path.join(__dirname, "..", "..", "electron", "welcome.html");
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 900;

const ANTHROPIC_HOSTS = ["api.anthropic.com", "anthropic"];

const isAnthropicUrl = (baseUrl: string): boolean => {
  const lower = baseUrl.toLowerCase();
  // Check full URL (hostname + path) for anthropic markers
  return ANTHROPIC_HOSTS.some((host) => lower.includes(host));
};

const resolveLlmConfig = async (): Promise<{
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}> => {
  const rawBaseUrl = process.env.LLM_BASE_URL ?? "";
  const apiKey = process.env.LLM_API_KEY ?? "";
  const model = process.env.LLM_MODEL ?? "";

  if (isAnthropicUrl(rawBaseUrl)) {
    logger.info("Detected Anthropic-compatible API URL, starting built-in LLM proxy...");
    const proxyBaseUrl = await startLlmProxy(apiKey, rawBaseUrl);
    return { baseUrl: proxyBaseUrl, apiKey: "proxy-internal", model } as const;
  }

  return { baseUrl: rawBaseUrl, apiKey, model } as const;
};

let llmConfig: { readonly baseUrl: string; readonly apiKey: string; readonly model: string };

/**
 * Remove CSP headers from all responses so injected scripts can run.
 */
const setupCspBypass = (): void => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };

    // Remove CSP headers (case-insensitive key search)
    const keysToRemove = Object.keys(headers).filter(
      (key) =>
        key.toLowerCase() === "content-security-policy" ||
        key.toLowerCase() === "content-security-policy-report-only"
    );
    for (const key of keysToRemove) {
      delete headers[key];
    }

    callback({ responseHeaders: headers });
  });

  logger.info("CSP bypass configured");
};

/**
 * Suppress download dialogs by auto-saving to a temp directory.
 * Downloads are saved silently without user interaction so they don't
 * block automated test flows.
 */
const setupDownloadHandler = (): void => {
  session.defaultSession.on("will-download", (_event, item) => {
    const filename = item.getFilename();
    const savePath = path.join(os.tmpdir(), "auto-test-downloads", filename);

    logger.info(`Download intercepted: ${filename} -> ${savePath}`);
    item.setSavePath(savePath);

    item.on("done", (_e, state) => {
      if (state === "completed") {
        logger.info(`Download completed: ${savePath}`);
      } else {
        logger.warn(`Download ${state}: ${filename}`);
      }
    });
  });

  // Override showSaveDialog / showOpenDialog to prevent any file dialogs
  // from blocking the automated flow.
  const originalShowSaveDialog = dialog.showSaveDialog;
  const originalShowOpenDialog = dialog.showOpenDialog;

  dialog.showSaveDialog = async (...args: Parameters<typeof dialog.showSaveDialog>) => {
    logger.info("Suppressed showSaveDialog");
    return { canceled: true, filePath: "" } as Awaited<ReturnType<typeof originalShowSaveDialog>>;
  };

  dialog.showOpenDialog = async (...args: Parameters<typeof dialog.showOpenDialog>) => {
    logger.info("Suppressed showOpenDialog");
    return { canceled: true, filePaths: [] } as Awaited<ReturnType<typeof originalShowOpenDialog>>;
  };

  logger.info("Download handler configured (auto-save to temp, dialogs suppressed)");
};

const createWindow = async (): Promise<BrowserWindow> => {
  const preloadPath = path.join(__dirname, "preload.js");

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  setMainWindow(win);

  // Redirect new window opens (target="_blank", window.open) to the main window
  // so page-agent is always available in the controlled window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    logger.info(`Intercepted new window open: ${url}`);
    win.loadURL(url);
    return { action: "deny" };
  });

  // Inject page-agent on every dom-ready (including after navigation)
  win.webContents.on("dom-ready", () => {
    logger.info(`dom-ready: ${win.webContents.getURL()}`);
    injectPageAgent(win, llmConfig).catch((err) => {
      logger.error("page-agent injection failed on dom-ready", err);
    });
  });

  win.on("closed", () => {
    logger.info("Main window closed");
  });

  const welcomeUrl = `file://${WELCOME_PAGE}`;
  logger.info(`Loading welcome page: ${welcomeUrl}`);
  try {
    await win.loadURL(welcomeUrl);
  } catch (err) {
    // External pages may reject loadURL due to redirects or sub-resource errors.
    // The page typically still renders, so we log and continue.
    logger.warn("loadURL completed with error (page may still be usable)", err);
  }

  return win;
};

const bootstrap = async (): Promise<void> => {
  llmConfig = await resolveLlmConfig();

  setupCspBypass();
  setupDownloadHandler();
  setupIpcHandlers();

  await createWindow();
  logger.info("Electron window created and page loaded");

  await startMcpServer();
  logger.info("Application bootstrap complete");
};

app.whenReady().then(() => {
  bootstrap().catch((err) => {
    logger.error("Bootstrap failed", err);
    app.quit();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    bootstrap().catch((err) => {
      logger.error("Re-bootstrap failed", err);
    });
  }
});
