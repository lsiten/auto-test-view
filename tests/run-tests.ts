/**
 * Test runner for auto-test-view MCP test suites.
 * Reads JSON test suite files, executes steps via MCP, validates assertions.
 *
 * Usage:
 *   npx ts-node tests/run-tests.ts                    # run all suites
 *   npx ts-node tests/run-tests.ts navigation          # run specific suite
 *   npx ts-node tests/run-tests.ts navigation,scroll-viewport  # run multiple
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";

const MCP_HOST = "127.0.0.1";
const MCP_PORT = 3399;
const MCP_PATH = "/mcp";
const MCP_BASE = `http://${MCP_HOST}:${MCP_PORT}${MCP_PATH}`;

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

let requestId = 0;
let previousUrl = "";

const nextId = (): number => ++requestId;

const initSession = async (): Promise<string> => {
  const { responseHeaders } = await mcpPost(
    {
      jsonrpc: "2.0",
      id: nextId(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-runner", version: "1.0" },
      },
    },
    {},
    30_000
  );

  const sessionId = responseHeaders["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    throw new Error("Failed to get MCP session ID");
  }
  return sessionId;
};

const callTool = async (
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT
): Promise<unknown> => {
  const { data } = await mcpPost(
    {
      jsonrpc: "2.0",
      id: nextId(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
    { "mcp-session-id": sessionId },
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
  sessionId: string,
  step: TestStep,
  prevUrl: string
): Promise<StepResult & { url?: string }> => {
  const args = step.args ?? {};
  const timeout = getToolTimeout(step.tool);

  try {
    const result = await callTool(sessionId, step.tool, args, timeout);

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
  sessionId: string,
  testCase: TestCase
): Promise<CaseResult> => {
  const start = Date.now();
  const stepResults: Array<StepResult> = [];
  let currentUrl = previousUrl;
  let caseStatus: "pass" | "fail" = "pass";

  process.stdout.write(`    ${testCase.id}: ${testCase.name} ... `);

  for (const step of testCase.steps) {
    const result = await runStep(sessionId, step, currentUrl);
    stepResults.push(result);

    if ("url" in result && result.url) {
      currentUrl = result.url;
    }

    if (result.status === "fail") {
      caseStatus = "fail";
      break; // Stop on first failure within a case
    }
  }

  previousUrl = currentUrl;
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
  sessionId: string,
  suitePath: string
): Promise<SuiteResult> => {
  const suiteData = JSON.parse(
    fs.readFileSync(suitePath, "utf-8")
  ) as TestSuite;

  console.log(`\n  Suite: ${suiteData.suite} (${suiteData.cases.length} cases)`);
  console.log(`  ${suiteData.description}`);
  console.log(`  ${"─".repeat(60)}`);

  const start = Date.now();
  const caseResults: Array<CaseResult> = [];
  let passed = 0;
  let failed = 0;

  for (const testCase of suiteData.cases) {
    const result = await runCase(sessionId, testCase);
    caseResults.push(result);
    if (result.status === "pass") passed++;
    else failed++;
  }

  const duration = Date.now() - start;
  console.log(`  ${"─".repeat(60)}`);
  console.log(
    `  Result: ${passed} passed, ${failed} failed (${(duration / 1000).toFixed(1)}s)`
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

const main = async (): Promise<void> => {
  const testsDir = path.resolve(__dirname);
  const indexPath = path.join(testsDir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as TestIndex;

  // Parse CLI args for suite filter
  const filterArg = process.argv[2];
  const filters = filterArg
    ? filterArg.split(",").map((s) => s.trim())
    : null;

  const suitesToRun = filters
    ? index.suites.filter((s) => filters.includes(s.suite))
    : index.suites;

  if (suitesToRun.length === 0) {
    console.error(`No matching suites found. Available: ${index.suites.map((s) => s.suite).join(", ")}`);
    process.exit(1);
  }

  console.log("=".repeat(70));
  console.log("  auto-test-view Test Runner");
  console.log(`  Suites: ${suitesToRun.length}, Cases: ${suitesToRun.reduce((a, s) => a + s.cases, 0)}`);
  console.log("=".repeat(70));

  // Init MCP session
  console.log("\n  Initializing MCP session...");
  const sessionId = await initSession();
  console.log(`  Session: ${sessionId}`);

  const allResults: Array<SuiteResult> = [];
  const totalStart = Date.now();

  for (const entry of suitesToRun) {
    const suitePath = path.join(testsDir, entry.file);
    const result = await runSuite(sessionId, suitePath);
    allResults.push(result);
  }

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
  console.log("=".repeat(70));

  // Write results to file
  const reportPath = path.join(testsDir, "results.json");
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    duration: totalDuration,
    summary: { total: totalCases, passed: totalPassed, failed: totalFailed },
    suites: allResults,
  }, null, 2));
  console.log(`\n  Results saved to ${reportPath}`);

  process.exit(totalFailed > 0 ? 1 : 0);
};

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
