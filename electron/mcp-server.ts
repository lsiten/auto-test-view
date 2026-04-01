/**
 * MCP Server implementation using @modelcontextprotocol/sdk.
 * Exposes tools for browser automation via page-agent.
 */

import * as http from "http";
import * as crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { logger } from "./logger";
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
} from "./ipc-handlers";

const SERVER_NAME = "auto-test-view";
const SERVER_VERSION = "1.0.0";

const MCP_PORT = 3399;

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
    "Execute a natural language task via page-agent AI",
    { task: z.string().describe("Natural language description of the task to perform") },
    async ({ task }) => wrapHandler("Task execution", () => executeTask(task))()
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
