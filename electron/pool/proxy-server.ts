/**
 * MCP proxy server for the Electron instance pool.
 * Runs as a plain Node.js process (not Electron).
 * Listens on POOL_PORT (default 3399) and routes MCP requests to pooled Electron instances.
 */

import * as http from "http";
import { InstanceManager } from "./instance-manager";
import { logger } from "../core/logger";

const POOL_PORT = parseInt(process.env.POOL_PORT ?? "3399", 10);

/** Maps MCP session IDs to instance IDs. */
const sessionMap = new Map<string, string>();

/** Maps instance IDs to sets of session IDs (for crash cleanup). */
const instanceSessions = new Map<string, Set<string>>();

const manager = new InstanceManager();

/**
 * Read the full request body into a Buffer.
 */
const readBody = (req: http.IncomingMessage): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
};

/**
 * Proxy an HTTP request to a target Electron instance port.
 * Streams the response back to the client without buffering.
 */
const proxyRequest = (
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  targetPort: number,
  bodyBuffer?: Buffer,
  sessionId?: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const headers = { ...clientReq.headers, host: `127.0.0.1:${targetPort}` };

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: targetPort,
        path: "/mcp",
        method: clientReq.method,
        headers,
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(clientRes, { end: true });
        proxyRes.on("end", resolve);
        proxyRes.on("error", reject);
      }
    );

    proxyReq.on("error", (err) => {
      logger.warn(`[proxy] Proxy request error: ${err.message}`);
      if (sessionId) {
        removeMapping(sessionId);
      }
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "application/json" });
        clientRes.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Backend unavailable" }, id: null }));
      }
      resolve();
    });

    if (bodyBuffer) {
      proxyReq.end(bodyBuffer);
    } else {
      proxyReq.end();
    }
  });
};

/**
 * Record a session-to-instance mapping.
 */
const recordMapping = (sessionId: string, instanceId: string): void => {
  sessionMap.set(sessionId, instanceId);
  let sessions = instanceSessions.get(instanceId);
  if (!sessions) {
    sessions = new Set();
    instanceSessions.set(instanceId, sessions);
  }
  sessions.add(sessionId);
  logger.info(`[proxy] Mapped session ${sessionId} -> instance ${instanceId}`);
};

/**
 * Remove a session mapping and release the instance back to the pool.
 */
const removeMapping = (sessionId: string): void => {
  const instanceId = sessionMap.get(sessionId);
  if (!instanceId) return;

  sessionMap.delete(sessionId);

  const sessions = instanceSessions.get(instanceId);
  if (sessions) {
    sessions.delete(sessionId);
    if (sessions.size === 0) {
      instanceSessions.delete(instanceId);
      manager.release(instanceId);
      logger.info(`[proxy] Released instance ${instanceId} (no remaining sessions)`);
    }
  }
};

/**
 * Clean up all sessions for a crashed/stopped instance.
 */
const cleanupInstance = (instanceId: string): void => {
  const sessions = instanceSessions.get(instanceId);
  if (!sessions) return;

  for (const sid of sessions) {
    sessionMap.delete(sid);
  }
  instanceSessions.delete(instanceId);
  logger.info(`[proxy] Cleaned up ${sessions.size} session(s) for instance ${instanceId}`);
};

/**
 * Find the target port for a given session ID.
 */
const resolvePort = (sessionId: string | undefined): number | null => {
  if (!sessionId) return null;
  const instanceId = sessionMap.get(sessionId);
  if (!instanceId) return null;

  const instances = manager.getInstances();
  const instance = instances.find((inst) => inst.id === instanceId);
  return instance?.port ?? null;
};

/**
 * Handle POST /mcp requests.
 */
const handlePost = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // If session header present, route to existing instance
  if (sessionId) {
    const port = resolvePort(sessionId);
    if (!port) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found" }, id: null }));
      return;
    }
    const bodyBuffer = await readBody(req);
    await proxyRequest(req, res, port, bodyBuffer, sessionId);
    return;
  }

  // No session header: read body to check if this is an initialize request
  const bodyBuffer = await readBody(req);

  let isInitialize = false;
  try {
    const parsed = JSON.parse(bodyBuffer.toString()) as { method?: string };
    isInitialize = parsed.method === "initialize";
  } catch {
    // Not valid JSON, let the backend handle the error
  }

  if (!isInitialize) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No session. Send initialize first." }, id: null }));
    return;
  }

  // Acquire an instance for the new session
  let instance;
  try {
    instance = await manager.acquire();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[proxy] Failed to acquire instance: ${message}`);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: `No instance available: ${message}` }, id: null }));
    return;
  }

  logger.info(`[proxy] Acquired instance ${instance.id} (port ${instance.port}) for initialize`);

  // Proxy the initialize request and capture the response session ID
  await new Promise<void>((resolve, reject) => {
    const clientRes = res;
    const headers = { ...req.headers, host: `127.0.0.1:${instance.port}` };

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: instance.port,
        path: "/mcp",
        method: "POST",
        headers,
      },
      (proxyRes) => {
        // Extract session ID from the backend response
        const backendSessionId = proxyRes.headers["mcp-session-id"] as string | undefined;
        if (backendSessionId) {
          recordMapping(backendSessionId, instance.id);
        } else {
          logger.warn(`[proxy] Backend did not return mcp-session-id, releasing instance ${instance.id}`);
          manager.release(instance.id);
        }

        clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(clientRes, { end: true });
        proxyRes.on("end", resolve);
        proxyRes.on("error", reject);
      }
    );

    proxyReq.on("error", (err) => {
      logger.warn(`[proxy] Initialize proxy error: ${err.message}`);
      manager.release(instance.id);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Backend unavailable" }, id: null }));
      }
      resolve();
    });

    proxyReq.end(bodyBuffer);
  });
};

/**
 * Handle GET /mcp (SSE stream).
 */
const handleGet = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const port = resolvePort(sessionId);

  if (!port) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing or invalid session ID" }));
    return;
  }

  await proxyRequest(req, res, port, undefined, sessionId);
};

/**
 * Handle DELETE /mcp.
 */
const handleDelete = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const port = resolvePort(sessionId);

  if (!port) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session not found" }));
    return;
  }

  await proxyRequest(req, res, port, undefined, sessionId);

  if (sessionId) {
    removeMapping(sessionId);
  }
};

/**
 * Main HTTP request handler.
 */
const requestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> => {
  const url = new URL(req.url ?? "/", `http://localhost:${POOL_PORT}`);

  if (url.pathname !== "/mcp") {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  try {
    if (req.method === "POST") {
      await handlePost(req, res);
      return;
    }

    if (req.method === "GET") {
      await handleGet(req, res);
      return;
    }

    if (req.method === "DELETE") {
      await handleDelete(req, res);
      return;
    }

    res.writeHead(405);
    res.end("Method Not Allowed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[proxy] Request error: ${message}`);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  }
};

const main = async (): Promise<void> => {
  logger.info("[proxy] Starting instance pool...");
  await manager.start();

  manager.on("instance-exit", (instanceId: string) => {
    cleanupInstance(instanceId);
  });

  const server = http.createServer(requestHandler);

  const shutdown = async (): Promise<void> => {
    logger.info("[proxy] Shutting down...");
    server.close();
    await manager.shutdown();
    logger.info("[proxy] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    shutdown().catch((err) => {
      logger.warn(`[proxy] Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  });

  process.on("SIGINT", () => {
    shutdown().catch((err) => {
      logger.warn(`[proxy] Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(POOL_PORT, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  logger.info(`[proxy] Proxy server listening on http://127.0.0.1:${POOL_PORT}/mcp`);
};

main().catch((err) => {
  logger.error(`[proxy] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
