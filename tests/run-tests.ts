/**
 * Test runner for auto-test-view MCP test suites.
 * Reads JSON test suite files, executes steps via MCP, validates assertions.
 *
 * Supports parallel execution: each suite gets its own MCP session (and thus
 * its own Electron instance via the proxy pool). Concurrency is controlled by
 * --concurrency N (default: 4, capped by available pool instances).
 *
 * Usage:
 *   npx ts-node tests/run-tests.ts                           # run all suites (parallel)
 *   npx ts-node tests/run-tests.ts navigation                # run specific suite
 *   npx ts-node tests/run-tests.ts navigation,scroll-viewport  # run multiple
 *   npx ts-node tests/run-tests.ts --concurrency 2           # limit to 2 parallel workers
 *   npx ts-node tests/run-tests.ts --serial                  # force serial execution
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { ChildProcess, spawn } from "child_process";

const MCP_HOST = "127.0.0.1";
const MCP_PORT = 3399;
const MCP_PATH = "/mcp";
const MCP_BASE = `http://${MCP_HOST}:${MCP_PORT}${MCP_PATH}`;

/** Track pool process so we can clean up on exit. */
let poolProcess: ChildProcess | null = null;

/** Check if the proxy pool is already listening. */
const isPoolRunning = (): Promise<boolean> => {
  return new Promise((resolve) => {
    const req = http.get(`http://${MCP_HOST}:${MCP_PORT}/mcp`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
};

/**
 * Ensure the Electron pool proxy server is running.
 * If not, build (if needed) and spawn it as a child process.
 * Waits until the pool is healthy before returning.
 */
const ensurePoolRunning = async (): Promise<void> => {
  if (await isPoolRunning()) {
    console.log("  Pool already running on port " + MCP_PORT);
    return;
  }

  console.log("  Pool not running. Starting proxy pool...");

  // Build first if dist doesn't exist
  const proxyJsPath = path.resolve(__dirname, "..", "dist", "electron", "pool", "proxy-server.js");
  if (!fs.existsSync(proxyJsPath)) {
    console.log("  Building project first (dist not found)...");
    const esbuildScript = path.resolve(__dirname, "..", "esbuild.dev.mjs");
    const buildProcess = spawn("node", [esbuildScript], {
      cwd: path.resolve(__dirname, ".."),
      stdio: "inherit",
    });
    await new Promise<void>((resolve, reject) => {
      buildProcess.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Build failed with exit code ${code}`));
      });
      buildProcess.on("error", reject);
    });
    console.log("  Build complete.");
  }

  // Spawn the pool proxy server
  poolProcess = spawn("node", [proxyJsPath], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "pipe",
    env: { ...process.env, POOL_PORT: String(MCP_PORT) },
  });

  poolProcess.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString().trimEnd();
    if (msg) console.log(`  [pool] ${msg}`);
  });
  poolProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trimEnd();
    if (msg) console.error(`  [pool:err] ${msg}`);
  });
  poolProcess.on("exit", (code, signal) => {
    if (poolProcess) {
      console.log(`  [pool] Process exited (code=${code}, signal=${signal})`);
      poolProcess = null;
    }
  });

  // Wait for pool to become healthy (up to 60s for Electron startup)
  const startTime = Date.now();
  const timeoutMs = 60_000;
  const pollMs = 1000;

  while (Date.now() - startTime < timeoutMs) {
    if (await isPoolRunning()) {
      console.log(`  Pool started successfully (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
      return;
    }
    // Check if process died
    if (poolProcess === null) {
      throw new Error("Pool process exited before becoming healthy");
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(`Pool did not become healthy within ${timeoutMs / 1000}s`);
};

/** Stop the pool process if we started it. */
const stopPool = (): void => {
  if (poolProcess) {
    console.log("\n  Stopping pool process...");
    poolProcess.kill("SIGTERM");
    poolProcess = null;
  }
};

/**
 * Send an HTTP POST to MCP and read the SSE response until a JSON-RPC result
 * or error is found. Uses raw http.request so we can consume the stream
 * incrementally and close it as soon as the result arrives.
 */
const mcpPost = (
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ data: unknown; responseHeaders: http.IncomingHttpHeaders }> => {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`MCP request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = http.request(
      {
        hostname: MCP_HOST,
        port: MCP_PORT,
        path: MCP_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let buffer = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          // Scan for SSE data lines containing JSON-RPC result/error
          const lines = buffer.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const parsed = JSON.parse(line.substring(6));
                if (parsed.result || parsed.error) {
                  clearTimeout(timer);
                  res.destroy(); // close the stream immediately
                  resolve({ data: parsed, responseHeaders: res.headers });
                  return;
                }
              } catch {
                // incomplete JSON, keep reading
              }
            }
          }
        });
        res.on("end", () => {
          clearTimeout(timer);
          reject(new Error(`SSE stream ended without result. Buffer: ${buffer.substring(0, 200)}`));
        });
        res.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      }
    );
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.write(payload);
    req.end();
  });
};
const EXECUTE_TASK_TIMEOUT = 480_000;
const DEFAULT_TIMEOUT = 120_000;

interface TestStep {
  readonly tool: string;
  readonly args?: Record<string, unknown>;
  readonly assert?: Record<string, unknown>;
  readonly note?: string;
}

interface TestCase {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly steps: ReadonlyArray<TestStep>;
}

interface TestSuite {
  readonly suite: string;
  readonly description: string;
  readonly cases: ReadonlyArray<TestCase>;
}

interface SuiteEntry {
  readonly file: string;
  readonly suite: string;
  readonly cases: number;
  readonly description: string;
}

interface TestIndex {
  readonly suites: ReadonlyArray<SuiteEntry>;
}

interface CaseResult {
  readonly id: string;
  readonly name: string;
  readonly status: "pass" | "fail" | "skip";
  readonly duration: number;
  readonly error?: string;
  readonly stepResults: ReadonlyArray<StepResult>;
}

interface StepResult {
  readonly tool: string;
  readonly status: "pass" | "fail" | "skip";
  readonly response?: string;
  readonly assertionError?: string;
}

interface SuiteResult {
  readonly suite: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly cases: ReadonlyArray<CaseResult>;
  readonly duration: number;
}

/** Per-session state: each worker gets its own isolated context. */
interface SessionContext {
  readonly sessionId: string;
  readonly workerId: number;
  requestId: number;
  previousUrl: string;
}

const nextId = (ctx: SessionContext): number => ++ctx.requestId;

const initSession = async (workerId: number): Promise<SessionContext> => {
  const ctx: SessionContext = {
    sessionId: "",
    workerId,
    requestId: workerId * 100_000, // offset to avoid ID collisions across workers
    previousUrl: "",
  };

  const { responseHeaders } = await mcpPost(
    {
      jsonrpc: "2.0",
      id: nextId(ctx),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: `test-runner-worker-${workerId}`, version: "1.0" },
      },
    },
    {},
    30_000
  );

  const sessionId = responseHeaders["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    throw new Error(`Worker ${workerId}: Failed to get MCP session ID`);
  }
  return { ...ctx, sessionId };
};

const callTool = async (
  ctx: SessionContext,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT
): Promise<unknown> => {
  const { data } = await mcpPost(
    {
      jsonrpc: "2.0",
      id: nextId(ctx),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
    { "mcp-session-id": ctx.sessionId },
    timeoutMs
  );
  const rpc = data as { result?: unknown; error?: { message?: string } };
  if (rpc.error) {
    throw new Error(rpc.error.message || JSON.stringify(rpc.error));
  }
  return rpc.result;
};

const extractText = (result: unknown): string => {
  const r = result as { content?: ReadonlyArray<{ text?: string }> };
  return r.content?.[0]?.text ?? "";
};

const isError = (result: unknown): boolean => {
  const r = result as { isError?: boolean; content?: ReadonlyArray<{ text?: string }> };
  if (r.isError) return true;
  const text = r.content?.[0]?.text ?? "";
  try {
    const parsed = JSON.parse(text);
    if (parsed.success === false) return true;
    if (parsed.error) return true;
  } catch {
    // not JSON
  }
  return text.includes("failed:") && !text.includes('"success": true');
};

const validateAssertions = (
  result: unknown,
  assertions: Record<string, unknown>,
  prevUrl: string
): string | null => {
  const text = extractText(result);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON response
  }

  for (const [key, expected] of Object.entries(assertions)) {
    switch (key) {
      case "url_contains": {
        const url = parsed.url as string | undefined;
        if (!url || !url.includes(expected as string)) {
          return `Expected URL to contain "${expected}", got "${url}"`;
        }
        break;
      }
      case "url_changed": {
        const currentUrl = parsed.url as string | undefined;
        if (expected === true && currentUrl && currentUrl === prevUrl) {
          return `Expected URL to change from "${prevUrl}", but it didn't`;
        }
        break;
      }
      case "has_url":
        if (expected === true && !parsed.url) {
          return `Expected response to contain url`;
        }
        break;
      case "has_title":
        if (expected === true && !parsed.title) {
          return `Expected response to contain title`;
        }
        break;
      case "has_content":
        if (expected === true && !text) {
          return `Expected response to contain content`;
        }
        break;
      case "has_status":
        if (expected === true && !parsed.status) {
          return `Expected response to contain status`;
        }
        break;
      case "not_busy":
        if (expected === true) {
          const s = parsed.status as string | undefined;
          if (s === "running" || s === "busy") {
            return `Expected agent not busy, got status "${s}"`;
          }
        }
        break;
      case "agent_available":
        if (expected === true && !parsed.status) {
          return `Expected agent to be available`;
        }
        break;
      case "returns_path":
        if (expected === true && !parsed.path) {
          return `Expected response to contain path`;
        }
        break;
      case "file_exists":
        if (expected === true && parsed.path) {
          if (!fs.existsSync(parsed.path as string)) {
            return `Expected file to exist at "${parsed.path}"`;
          }
        }
        break;
      case "path_equals":
        if (parsed.path !== expected) {
          return `Expected path "${expected}", got "${parsed.path}"`;
        }
        break;
      case "url_starts_with": {
        const url = parsed.url as string | undefined;
        if (!url || !url.startsWith(expected as string)) {
          return `Expected URL to start with "${expected}", got "${url}"`;
        }
        break;
      }
      case "has_id":
        if (expected === true && !parsed.id) {
          return `Expected response to contain id`;
        }
        break;
      case "has_field": {
        const fieldName = expected as string;
        if (!(fieldName in parsed)) {
          return `Expected response to contain field "${fieldName}"`;
        }
        break;
      }
      case "field_equals": {
        const spec = expected as { field: string; value: unknown };
        const actual = parsed[spec.field];
        if (actual !== spec.value) {
          return `Expected ${spec.field} = ${JSON.stringify(spec.value)}, got ${JSON.stringify(actual)}`;
        }
        break;
      }
      case "field_gte": {
        const spec = expected as { field: string; value: number };
        const actual = parsed[spec.field] as number;
        if (typeof actual !== "number" || actual < spec.value) {
          return `Expected ${spec.field} >= ${spec.value}, got ${actual}`;
        }
        break;
      }
      case "field_lte": {
        const spec = expected as { field: string; value: number };
        const actual = parsed[spec.field] as number;
        if (typeof actual !== "number" || actual > spec.value) {
          return `Expected ${spec.field} <= ${spec.value}, got ${actual}`;
        }
        break;
      }
      case "is_array":
        if (expected === true && !Array.isArray(parsed)) {
          // Check if the top-level parse is an array
          try {
            const arr = JSON.parse(text);
            if (!Array.isArray(arr)) {
              return `Expected response to be an array`;
            }
          } catch {
            return `Expected response to be an array`;
          }
        }
        break;
      case "array_length_gte": {
        let arr: unknown[];
        try { arr = JSON.parse(text); } catch { arr = []; }
        if (!Array.isArray(arr) || arr.length < (expected as number)) {
          return `Expected array length >= ${expected}, got ${Array.isArray(arr) ? arr.length : "not array"}`;
        }
        break;
      }
      case "is_error":
        if (expected === true) {
          const isErr = text.includes("failed:") || parsed.error;
          if (!isErr) {
            return `Expected an error response`;
          }
        }
        break;
      case "has_deleted":
        if (expected === true && !parsed.deleted) {
          return `Expected response to contain deleted: true`;
        }
        break;
      case "has_suite":
        if (expected === true && !parsed.suite) {
          return `Expected response to contain suite field`;
        }
        break;
      case "has_cases":
        if (expected === true && !parsed.cases) {
          return `Expected response to contain cases field`;
        }
        break;
      case "text_contains": {
        if (!text.includes(expected as string)) {
          return `Expected response to contain "${expected}"`;
        }
        break;
      }
      case "step_groups_gte": {
        const sg = parsed.stepGroups as unknown[];
        if (!Array.isArray(sg) || sg.length < (expected as number)) {
          return `Expected stepGroups length >= ${expected}, got ${Array.isArray(sg) ? sg.length : "missing"}`;
        }
        break;
      }
      default:
        // Unknown assertion type, skip
        break;
    }
  }
  return null;
};

const getToolTimeout = (toolName: string): number => {
  return toolName === "execute_task" ? EXECUTE_TASK_TIMEOUT : DEFAULT_TIMEOUT;
};

const runStep = async (
  ctx: SessionContext,
  step: TestStep,
  prevUrl: string
): Promise<StepResult & { url?: string }> => {
  const args = step.args ?? {};
  const timeout = getToolTimeout(step.tool);

  try {
    const result = await callTool(ctx, step.tool, args, timeout);

    // Track URL changes
    const text = extractText(result);
    let currentUrl = prevUrl;
    try {
      const parsed = JSON.parse(text);
      if (parsed.url) {
        currentUrl = parsed.url;
      }
    } catch {
      // ignore
    }

    // Check for error in result
    // If the step asserts is_error, we EXPECT an error — skip the error check
    const expectsError = step.assert && (step.assert as Record<string, unknown>).is_error === true;

    if (isError(result) && !expectsError) {
      // For some tools/steps, errors are acceptable:
      // - stop_task/get_status: may have no running task
      // - execute_task without assertions: LLM output is non-deterministic
      // - steps with "验证" in note: validation-only steps
      const isAcceptable =
        step.tool === "stop_task" ||
        step.tool === "get_status" ||
        step.tool === "stop_recording" ||
        (step.tool === "screenshot" && !step.assert) ||
        (step.tool === "execute_task" && !step.assert) ||
        (step.tool === "execute_js" && !step.assert) ||
        (step.tool === "click_element" && !step.assert) ||
        (step.tool === "input_text" && !step.assert) ||
        (step.note && step.note.includes("验证"));

      if (!isAcceptable) {
        return {
          tool: step.tool,
          status: "fail",
          response: text.substring(0, 200),
          assertionError: `Tool returned error: ${text.substring(0, 200)}`,
          url: currentUrl,
        };
      }
    }

    // Validate assertions
    if (step.assert) {
      const err = validateAssertions(result, step.assert, prevUrl);
      if (err) {
        return {
          tool: step.tool,
          status: "fail",
          response: text.substring(0, 200),
          assertionError: err,
          url: currentUrl,
        };
      }
    }

    return {
      tool: step.tool,
      status: "pass",
      response: text.substring(0, 100),
      url: currentUrl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      tool: step.tool,
      status: "fail",
      assertionError: message,
    };
  }
};

const runCase = async (
  ctx: SessionContext,
  testCase: TestCase
): Promise<CaseResult> => {
  const start = Date.now();
  const stepResults: Array<StepResult> = [];
  let currentUrl = ctx.previousUrl;
  let caseStatus: "pass" | "fail" = "pass";

  const tag = ctx.workerId >= 0 ? `[W${ctx.workerId}] ` : "";
  process.stdout.write(`    ${tag}${testCase.id}: ${testCase.name} ... `);

  for (const step of testCase.steps) {
    const result = await runStep(ctx, step, currentUrl);
    stepResults.push(result);

    if ("url" in result && result.url) {
      currentUrl = result.url;
    }

    if (result.status === "fail") {
      caseStatus = "fail";
      break; // Stop on first failure within a case
    }
  }

  ctx.previousUrl = currentUrl;
  const duration = Date.now() - start;

  if (caseStatus === "pass") {
    console.log(`PASS (${(duration / 1000).toFixed(1)}s)`);
  } else {
    const failedStep = stepResults.find((s) => s.status === "fail");
    console.log(`FAIL (${(duration / 1000).toFixed(1)}s)`);
    if (failedStep?.assertionError) {
      console.log(`      -> ${failedStep.assertionError}`);
    }
  }

  return {
    id: testCase.id,
    name: testCase.name,
    status: caseStatus,
    duration,
    error: caseStatus === "fail"
      ? stepResults.find((s) => s.status === "fail")?.assertionError
      : undefined,
    stepResults,
  };
};

const runSuite = async (
  ctx: SessionContext,
  suitePath: string
): Promise<SuiteResult> => {
  const suiteData = JSON.parse(
    fs.readFileSync(suitePath, "utf-8")
  ) as TestSuite;

  const tag = ctx.workerId >= 0 ? `[W${ctx.workerId}] ` : "";
  console.log(`\n  ${tag}Suite: ${suiteData.suite} (${suiteData.cases.length} cases)`);
  console.log(`  ${tag}${suiteData.description}`);
  console.log(`  ${tag}${"─".repeat(60)}`);

  const start = Date.now();
  const caseResults: Array<CaseResult> = [];
  let passed = 0;
  let failed = 0;

  for (const testCase of suiteData.cases) {
    const result = await runCase(ctx, testCase);
    caseResults.push(result);
    if (result.status === "pass") passed++;
    else failed++;
  }

  const duration = Date.now() - start;
  console.log(`  ${tag}${"─".repeat(60)}`);
  console.log(
    `  ${tag}Result: ${passed} passed, ${failed} failed (${(duration / 1000).toFixed(1)}s)`
  );

  return {
    suite: suiteData.suite,
    passed,
    failed,
    skipped: 0,
    cases: caseResults,
    duration,
  };
};

/** Parse CLI arguments for concurrency and suite filters. */
const parseArgs = (): { filters: ReadonlyArray<string> | null; concurrency: number } => {
  const args = process.argv.slice(2);
  let concurrency = 4;
  let filters: ReadonlyArray<string> | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--serial") {
      concurrency = 1;
    } else if (arg === "--concurrency" && i + 1 < args.length) {
      concurrency = Math.max(1, parseInt(args[++i], 10) || 4);
    } else if (!arg.startsWith("--")) {
      filters = arg.split(",").map((s) => s.trim());
    }
  }

  return { filters, concurrency };
};

/** Worker function: pulls suites from queue and runs them sequentially. */
const runWorker = async (
  ctx: SessionContext,
  queue: Array<SuiteEntry>,
  testsDir: string
): Promise<ReadonlyArray<SuiteResult>> => {
  const results: Array<SuiteResult> = [];

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) break;
    const suitePath = path.join(testsDir, entry.file);
    const result = await runSuite(ctx, suitePath);
    results.push(result);
  }

  return results;
};

const main = async (): Promise<void> => {
  const testsDir = path.resolve(__dirname);
  const indexPath = path.join(testsDir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as TestIndex;

  const { filters, concurrency } = parseArgs();

  const suitesToRun = filters
    ? index.suites.filter((s) => filters.includes(s.suite))
    : index.suites;

  if (suitesToRun.length === 0) {
    console.error(`No matching suites found. Available: ${index.suites.map((s) => s.suite).join(", ")}`);
    process.exit(1);
  }

  // Actual worker count = min(concurrency, suites)
  const workerCount = Math.min(concurrency, suitesToRun.length);
  const mode = workerCount === 1 ? "serial" : `parallel (${workerCount} workers)`;

  console.log("=".repeat(70));
  console.log("  auto-test-view Test Runner");
  console.log(`  Suites: ${suitesToRun.length}, Cases: ${suitesToRun.reduce((a, s) => a + s.cases, 0)}`);
  console.log(`  Mode: ${mode}`);
  console.log("=".repeat(70));

  // Ensure pool is running (auto-start Electron if needed)
  console.log("\n  Checking pool status...");
  await ensurePoolRunning();

  // Initialize worker sessions in parallel
  console.log(`\n  Initializing ${workerCount} MCP session(s)...`);
  const contexts = await Promise.all(
    Array.from({ length: workerCount }, (_, i) => initSession(i))
  );
  for (const ctx of contexts) {
    console.log(`  Worker ${ctx.workerId}: session ${ctx.sessionId}`);
  }

  // Shared mutable queue — workers pull from this as they finish suites
  const queue: Array<SuiteEntry> = [...suitesToRun];
  const totalStart = Date.now();

  // Launch all workers in parallel; each pulls suites from the shared queue
  const workerResults = await Promise.all(
    contexts.map((ctx) => runWorker(ctx, queue, testsDir))
  );
  const allResults = workerResults.flat();

  const totalDuration = Date.now() - totalStart;

  // Summary
  const totalPassed = allResults.reduce((a, r) => a + r.passed, 0);
  const totalFailed = allResults.reduce((a, r) => a + r.failed, 0);
  const totalCases = totalPassed + totalFailed;

  console.log("\n" + "=".repeat(70));
  console.log("  SUMMARY");
  console.log("=".repeat(70));

  for (const r of allResults) {
    const icon = r.failed === 0 ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${r.suite}: ${r.passed}/${r.passed + r.failed} passed`);
    if (r.failed > 0) {
      for (const c of r.cases) {
        if (c.status === "fail") {
          console.log(`         - ${c.id}: ${c.error?.substring(0, 80)}`);
        }
      }
    }
  }

  console.log(`\n  Total: ${totalPassed}/${totalCases} passed, ${totalFailed} failed`);
  console.log(`  Duration: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log(`  Workers: ${workerCount}`);
  console.log("=".repeat(70));

  // Write results to file
  const reportPath = path.join(testsDir, "results.json");
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    duration: totalDuration,
    workers: workerCount,
    summary: { total: totalCases, passed: totalPassed, failed: totalFailed },
    suites: allResults,
  }, null, 2));
  console.log(`\n  Results saved to ${reportPath}`);

  stopPool();
  process.exit(totalFailed > 0 ? 1 : 0);
};

// Clean up pool on unexpected exit
process.on("SIGINT", () => { stopPool(); process.exit(130); });
process.on("SIGTERM", () => { stopPool(); process.exit(143); });

main().catch((err) => {
  console.error("Test runner error:", err);
  stopPool();
  process.exit(1);
});
