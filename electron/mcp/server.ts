/**
 * MCP Server implementation using @modelcontextprotocol/sdk.
 * Exposes tools for browser automation via page-agent.
 */

import * as http from "http";
import * as crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { logger } from "../core/logger";
import {
  navigateTo,
  executeTask,
  getPageState,
  clickElement,
  inputText,
  scrollPage,
  getStatus,
  stopTask,
  takeScreenshot,
  executeJs,
  goBack,
  goForward,
  reloadPage,
  getLlmConfig,
  getCurrentUrl,
  executeCdp,
  uploadFile,
  dragFile,
  networkIntercept,
  networkLog,
} from "../core/ipc-handlers";
import {
  startRecording as recorderStart,
  addStepGroup as recorderAddStepGroup,
  stopRecording as recorderStop,
  getCurrentState as recorderGetState,
} from "../recorder/recorder";
import {
  type RecordingScope,
  listRecordings,
  getRecording,
  deleteRecording,
  updateRecording,
  exportRecording,
  searchRecordings,
  batchDeleteRecordings,
  batchExportRecordings,
  batchMoveRecordings,
} from "../recorder/store";
import { matchRecording, replayRecording } from "../playback/matcher";
import { indexRecording } from "../recorder/semantic-index";

const SERVER_NAME = "auto-test-view";
const SERVER_VERSION = "1.0.0";

const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3399", 10);

let httpServer: http.Server | null = null;
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

const wrapHandler = (
  label: string,
  handler: () => Promise<unknown>
) => {
  return async () => {
    try {
      const result = await handler();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `${label} failed: ${message}` }],
        isError: true as const,
      };
    }
  };
};

const registerTools = (server: McpServer): void => {
  server.tool(
    "navigate",
    "Navigate the browser to a specified URL",
    { url: z.string().describe("The URL to navigate to") },
    async ({ url }) => wrapHandler("Navigation", () => navigateTo(url))()
  );

  server.tool(
    "execute_task",
    "Execute a natural language task via page-agent AI. Automatically checks for matching recorded sequences first.",
    { task: z.string().describe("Natural language description of the task to perform") },
    async ({ task }) =>
      wrapHandler("Task execution", async () => {
        // Try to match a recorded sequence before using page-agent
        const config = getLlmConfig();
        if (config) {
          try {
            const currentUrl = getCurrentUrl();
            const match = await matchRecording(task, currentUrl, config);
            if (match.matched && match.recording) {
              logger.info(
                `[MCP] Matched recording ${match.recordingId} (confidence=${match.confidence}): ${match.reason}`
              );
              const result = await replayRecording(match.recording);
              return {
                source: "recording",
                recordingId: match.recordingId,
                recordingName: match.recordingName,
                confidence: match.confidence,
                matchReason: match.reason,
                ...result,
              };
            }
            if (match.recordingId) {
              logger.info(
                `[MCP] Recording ${match.recordingId} considered but not confident enough ` +
                `(${match.confidence}): ${match.reason}`
              );
            }
          } catch (err) {
            logger.warn("[MCP] Recording matching failed, falling back to page-agent", err);
          }
        }

        // No match or matching disabled — use page-agent
        const result = await executeTask(task);
        return { source: "page-agent", result };
      })()
  );

  server.tool(
    "get_page_state",
    "Get the current page DOM state (simplified HTML structure)",
    {},
    wrapHandler("Get page state", () => getPageState())
  );

  server.tool(
    "screenshot",
    "Take a screenshot of the current page and return the file path",
    { path: z.string().optional().describe("Optional file path to save the screenshot") },
    async ({ path: savePath }) =>
      wrapHandler("Screenshot", async () => ({ path: await takeScreenshot(savePath) }))()
  );

  server.tool(
    "click_element",
    "Click an element on the page by its index (from page-agent's element tree)",
    { index: z.number().describe("The element index to click") },
    async ({ index }) =>
      wrapHandler("Click", async () => (await clickElement(index)) ?? { success: true })()
  );

  server.tool(
    "input_text",
    "Input text into an element on the page by its index",
    {
      index: z.number().describe("The element index to type into"),
      text: z.string().describe("The text to input"),
    },
    async ({ index, text }) =>
      wrapHandler("Input", async () => (await inputText(index, text)) ?? { success: true })()
  );

  server.tool(
    "scroll",
    "Scroll the page in a given direction",
    {
      direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
      pages: z.number().optional().default(1).describe("Number of pages to scroll (default 1)"),
    },
    async ({ direction, pages }) =>
      wrapHandler("Scroll", async () => (await scrollPage(direction, pages)) ?? { success: true })()
  );

  server.tool(
    "get_status",
    "Get the current page-agent execution status",
    {},
    wrapHandler("Get status", () => getStatus())
  );

  server.tool(
    "stop_task",
    "Stop the currently running page-agent task",
    {},
    wrapHandler("Stop task", async () => (await stopTask()) ?? { stopped: true })
  );

  // -- Browser navigation controls --

  server.tool(
    "go_back",
    "Navigate back in browser history",
    {},
    wrapHandler("Go back", () => goBack())
  );

  server.tool(
    "go_forward",
    "Navigate forward in browser history",
    {},
    wrapHandler("Go forward", () => goForward())
  );

  server.tool(
    "refresh",
    "Reload the current page",
    {},
    wrapHandler("Refresh", () => reloadPage())
  );

  // -- JavaScript execution --

  server.tool(
    "execute_js",
    "Execute JavaScript code in the page and return the result",
    { code: z.string().describe("JavaScript code to execute in the page context") },
    async ({ code }) =>
      wrapHandler("Execute JS", async () => {
        const result = await executeJs(code);
        return { result };
      })()
  );

  // -- Recording tools --

  server.tool(
    "start_recording",
    "Start recording user interactions. Returns the recording ID.",
    {
      name: z.string().describe("Name for the recording"),
      group: z.string().optional().describe("Group/category for the recording"),
    },
    async ({ name, group }) =>
      wrapHandler("Start recording", async () => {
        const id = recorderStart(name, group);
        return { id, state: recorderGetState() };
      })()
  );

  server.tool(
    "stop_recording",
    "Stop the current recording and save it. Returns the full recording data.",
    {
      scope: z.enum(["project", "global"]).optional().describe("Recording scope: project or global (default: project)"),
    },
    async ({ scope }) =>
      wrapHandler("Stop recording", async () => {
        const recording = recorderStop(scope as RecordingScope | undefined);
        const config = getLlmConfig();
        if (config) {
          indexRecording(recording, config, scope as RecordingScope | undefined).catch((err) => {
            logger.warn("[SemanticIndex] Background indexing failed", err);
          });
        }
        return recording;
      })()
  );

  server.tool(
    "add_step_group",
    "Add a new step group to the current recording",
    { label: z.string().describe("Label for the step group") },
    async ({ label }) =>
      wrapHandler("Add step group", async () => {
        recorderAddStepGroup(label);
        return { success: true, label };
      })()
  );

  server.tool(
    "list_recordings",
    "List all recordings, optionally filtered by group and scope",
    {
      group: z.string().optional().describe("Filter by group name"),
      scope: z.enum(["project", "global"]).optional().describe("Recording scope: project or global"),
    },
    async ({ group, scope }) =>
      wrapHandler("List recordings", async () => listRecordings(group, scope as RecordingScope | undefined))()
  );

  server.tool(
    "get_recording",
    "Get a single recording by ID with full step details",
    {
      id: z.string().describe("Recording ID"),
      scope: z.enum(["project", "global"]).optional().describe("Recording scope: project or global"),
    },
    async ({ id, scope }) =>
      wrapHandler("Get recording", async () => {
        const rec = getRecording(id, scope as RecordingScope | undefined);
        if (!rec) throw new Error(`Recording not found: ${id}`);
        return rec;
      })()
  );

  server.tool(
    "delete_recording",
    "Delete a recording by ID",
    {
      id: z.string().describe("Recording ID"),
      scope: z.enum(["project", "global"]).optional().describe("Recording scope: project or global"),
    },
    async ({ id, scope }) =>
      wrapHandler("Delete recording", async () => {
        const ok = deleteRecording(id, scope as RecordingScope | undefined);
        if (!ok) throw new Error(`Recording not found: ${id}`);
        return { deleted: true, id };
      })()
  );

  server.tool(
    "update_recording",
    "Update a recording's name or group",
    {
      id: z.string().describe("Recording ID"),
      name: z.string().optional().describe("New name"),
      group: z.string().optional().describe("New group"),
      scope: z.enum(["project", "global"]).optional().describe("Recording scope: project or global"),
    },
    async ({ id, name, group, scope }) =>
      wrapHandler("Update recording", async () => {
        const updated = updateRecording(id, { name, group }, scope as RecordingScope | undefined);
        if (!updated) throw new Error(`Recording not found: ${id}`);
        return updated;
      })()
  );

  server.tool(
    "export_recording",
    "Export a recording as a test suite JSON compatible with tests/suites/*.json",
    {
      id: z.string().describe("Recording ID"),
      scope: z.enum(["project", "global"]).optional().describe("Recording scope: project or global"),
    },
    async ({ id, scope }) =>
      wrapHandler("Export recording", async () => {
        const suite = exportRecording(id, scope as RecordingScope | undefined);
        if (!suite) throw new Error(`Recording not found: ${id}`);
        return suite;
      })()
  );

  server.tool(
    "search_recordings",
    "Search recordings by name, group, URL, or summary",
    {
      query: z.string().describe("Search query string"),
      scope: z.enum(["project", "global"]).optional().describe("Recording scope: project or global"),
    },
    async ({ query, scope }) =>
      wrapHandler("Search recordings", async () => searchRecordings(query, scope as RecordingScope | undefined))()
  );

  server.tool(
    "batch_delete_recordings",
    "Delete multiple recordings by IDs",
    {
      ids: z.array(z.string()).describe("Array of recording IDs to delete"),
      scope: z.enum(["project", "global"]).optional().describe("Recording scope: project or global"),
    },
    async ({ ids, scope }) =>
      wrapHandler("Batch delete", async () => {
        const count = batchDeleteRecordings(ids, scope as RecordingScope | undefined);
        return { deleted: count, ids };
      })()
  );

  server.tool(
    "batch_export_recordings",
    "Export multiple recordings as test suites",
    {
      ids: z.array(z.string()).describe("Array of recording IDs to export"),
      scope: z.enum(["project", "global"]).optional().describe("Recording scope: project or global"),
    },
    async ({ ids, scope }) =>
      wrapHandler("Batch export", async () => batchExportRecordings(ids, scope as RecordingScope | undefined))()
  );

  server.tool(
    "execute_cdp",
    "Execute a Chrome DevTools Protocol command directly",
    {
      method: z.string().describe("CDP method name (e.g. 'DOM.getDocument', 'Network.enable')"),
      params: z.record(z.unknown()).optional().describe("CDP method parameters"),
    },
    async ({ method, params }) =>
      wrapHandler("CDP command", async () => {
        const result = await executeCdp(method, params);
        return { method, result };
      })()
  );

  server.tool(
    "upload_file",
    "Upload files to a file input element automatically (no dialog, fully automated)",
    {
      filePaths: z.array(z.string()).describe("Absolute paths to local files"),
      selector: z.string().optional().describe("CSS selector for the file input (auto-detect if omitted)"),
    },
    async ({ filePaths, selector }) =>
      wrapHandler("Upload file", () => uploadFile(filePaths, selector))()
  );

  server.tool(
    "drag_file",
    "Drag and drop files onto a drop zone element automatically (fully automated)",
    {
      filePaths: z.array(z.string()).describe("Absolute paths to local files"),
      selector: z.string().describe("CSS selector for the drop zone element"),
    },
    async ({ filePaths, selector }) =>
      wrapHandler("Drag file", () => dragFile(filePaths, selector))()
  );

  // -- Network interception and logging --

  server.tool(
    "network_intercept",
    "Manage network request interception rules (mock, block, modify, delay, fail)",
    {
      action: z.enum(["add", "remove", "list", "clear"]).describe("Action to perform"),
      rule: z.object({
        id: z.string().optional().describe("Rule ID (required for remove)"),
        urlPattern: z.string().optional().describe("URL glob pattern to match (e.g. '*/api/*')"),
        resourceType: z.string().optional().describe("Resource type filter (Document, Script, XHR, Fetch, Image, etc.)"),
        method: z.string().optional().describe("HTTP method filter (GET, POST, etc.)"),
        action: z.enum(["mock", "block", "modify", "delay", "fail"]).optional().describe("Interception action"),
        responseCode: z.number().optional().describe("Mock response status code"),
        responseHeaders: z.record(z.string()).optional().describe("Mock response headers"),
        responseBody: z.string().optional().describe("Mock response body"),
        requestHeaders: z.record(z.string()).optional().describe("Headers to add/override (modify action)"),
        delayMs: z.number().optional().describe("Delay in milliseconds (delay action)"),
        errorReason: z.string().optional().describe("Error reason (fail action): Failed, Aborted, TimedOut, etc."),
      }).optional().describe("Interception rule (required for add/remove)"),
    },
    async ({ action, rule }) =>
      wrapHandler("Network intercept", () => networkIntercept(action, rule))()
  );

  server.tool(
    "network_log",
    "Capture and inspect network traffic",
    {
      action: z.enum(["start", "stop", "get", "clear"]).describe("Action: start/stop capturing, get logs, or clear"),
      filter: z.object({
        urlPattern: z.string().optional().describe("URL pattern to filter"),
        method: z.string().optional().describe("HTTP method to filter"),
        statusCode: z.number().optional().describe("Status code to filter"),
      }).optional().describe("Filter criteria (only for 'get' action)"),
    },
    async ({ action, filter }) =>
      wrapHandler("Network log", () => networkLog(action, filter))()
  );

  server.tool(
    "batch_move_recordings",
    "Move multiple recordings to a new group",
    {
      ids: z.array(z.string()).describe("Array of recording IDs to move"),
      group: z.string().describe("Target group name"),
      scope: z.enum(["project", "global"]).optional().describe("Recording scope: project or global"),
    },
    async ({ ids, group, scope }) =>
      wrapHandler("Batch move", async () => {
        const count = batchMoveRecordings(ids, group, scope as RecordingScope | undefined);
        return { moved: count, group, ids };
      })()
  );
};

const createSessionPair = async (): Promise<{ server: McpServer; transport: StreamableHTTPServerTransport }> => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  registerTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      sessions.delete(sid);
      logger.info(`MCP session closed: ${sid}`);
    }
  };

  await server.connect(transport);
  return { server, transport };
};

const parseBody = async (req: http.IncomingMessage): Promise<unknown> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
};

export const startMcpServer = async (): Promise<void> => {
  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${MCP_PORT}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        const body = await parseBody(req);
        const jsonrpc = body as { method?: string };

        if (jsonrpc.method === "initialize") {
          // New session: create fresh server + transport pair
          const pair = await createSessionPair();
          await pair.transport.handleRequest(req, res, body);
          // Session ID is assigned during handleRequest
          const sid = pair.transport.sessionId;
          if (sid) {
            sessions.set(sid, pair);
            logger.info(`MCP session created: ${sid}`);
          }
          return;
        }

        // Existing session
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.transport.handleRequest(req, res, body);
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session. Send initialize first." }, id: null }));
        return;
      }

      if (req.method === "GET") {
        // SSE stream for notifications
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.transport.handleRequest(req, res);
          return;
        }
        res.writeHead(400);
        res.end("Missing or invalid session ID");
        return;
      }

      if (req.method === "DELETE") {
        if (sessionId && sessions.has(sessionId)) {
          const pair = sessions.get(sessionId)!;
          await pair.transport.handleRequest(req, res);
          await pair.server.close();
          sessions.delete(sessionId);
          return;
        }
        res.writeHead(404);
        res.end("Session not found");
        return;
      }

      res.writeHead(405);
      res.end("Method Not Allowed");
    } catch (err) {
      logger.error("MCP transport request error", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer!.listen(MCP_PORT, "127.0.0.1", () => resolve());
    httpServer!.on("error", reject);
  });

  logger.info(`MCP server started on http://127.0.0.1:${MCP_PORT}/mcp`);
};

export const stopMcpServer = async (): Promise<void> => {
  for (const [, pair] of sessions) {
    await pair.server.close();
  }
  sessions.clear();
  if (httpServer) {
    await new Promise<void>((resolve) => {
      httpServer!.close(() => resolve());
    });
    httpServer = null;
  }
  logger.info("MCP server stopped");
};
