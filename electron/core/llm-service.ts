/**
 * Shared LLM service manager.
 * Lazy-starts a Python litellm proxy on first use; all consumers share one instance.
 * Uses the project .venv Python if available (system python3 may lack litellm).
 */
import * as fs from "fs";
import * as path from "path";
import { type ChildProcess, execSync, spawn } from "child_process";
import { logger } from "./logger";

const LITELLM_PROXY_SCRIPT = path.join(__dirname, "..", "..", "..", "lib", "litellm-proxy.py");
const LITELLM_PORT = parseInt(process.env.LLM_PROXY_PORT ?? "3398", 10);
const LITELLM_BASE_URL = `http://127.0.0.1:${LITELLM_PORT}/v1`;

/**
 * Resolve the Python executable path.
 * Prefers the project venv (which has litellm installed) over system python3.
 */
export const resolvePythonPath = (): string => {
  const projectRoot = path.join(__dirname, "..", "..", "..");
  const venvPython = path.join(projectRoot, ".venv", "bin", "python3");
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return "python3";
};

interface LlmServiceConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

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

let config: LlmServiceConfig | null = null;
let serviceProcess: ChildProcess | null = null;
let serviceReady = false;
let starting: Promise<string> | null = null;

/** Store config without starting any service */
export const setLlmServiceConfig = (cfg: LlmServiceConfig): void => {
  config = cfg;
};

/** Get the raw config */
export const getLlmServiceConfig = (): LlmServiceConfig | null => config;

/**
 * Spawn the Python litellm proxy process.
 * Returns the proxy base URL when ready.
 */
const spawnLitellmProxy = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (!config) {
      reject(new Error("LLM service config not set"));
      return;
    }

    if (!fs.existsSync(LITELLM_PROXY_SCRIPT)) {
      reject(new Error(`litellm proxy script not found: ${LITELLM_PROXY_SCRIPT}`));
      return;
    }

    // Kill any stale process from a previous run
    killProcessOnPort(LITELLM_PORT);

    const env = {
      ...process.env,
      LLM_API_KEY: config.apiKey,
      LLM_BASE_URL: config.baseUrl,
      LLM_MODEL: config.model,
    };

    const pythonBin = resolvePythonPath();
    logger.info(`LLM service: using Python at ${pythonBin}`);
    serviceProcess = spawn(pythonBin, [LITELLM_PROXY_SCRIPT, String(LITELLM_PORT)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    serviceProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) logger.info(text);
      if (text.includes("Service ready")) {
        serviceReady = true;
        resolve(LITELLM_BASE_URL);
      }
    });

    serviceProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) logger.warn(`[litellm-proxy stderr] ${text}`);
    });

    serviceProcess.on("exit", (code) => {
      logger.info(`[litellm-proxy] Process exited with code ${code}`);
      serviceProcess = null;
      serviceReady = false;
      starting = null;
    });

    serviceProcess.on("error", (err) => {
      logger.error("[litellm-proxy] Spawn error", err);
      serviceProcess = null;
      serviceReady = false;
      starting = null;
      reject(err);
    });

    // Timeout: kill zombie process before rejecting
    setTimeout(() => {
      if (!serviceReady) {
        if (serviceProcess) {
          serviceProcess.kill("SIGTERM");
          serviceProcess = null;
        }
        starting = null;
        reject(new Error("litellm proxy startup timed out"));
      }
    }, 30_000);
  });
};

/**
 * Ensure the LLM service is available and return resolved config.
 * Lazy-starts the litellm proxy on first call.
 */
export const ensureLlmService = async (): Promise<{
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}> => {
  if (!config) {
    throw new Error("LLM service config not set. Call setLlmServiceConfig first.");
  }

  if (serviceReady) {
    return { baseUrl: LITELLM_BASE_URL, apiKey: "proxy-internal", model: config.model };
  }

  // Prevent concurrent starts
  if (!starting) {
    logger.info("LLM service: lazy-starting litellm proxy...");
    starting = spawnLitellmProxy();
  }

  const url = await starting;
  return { baseUrl: url, apiKey: "proxy-internal", model: config.model };
};

/** Shut down the LLM service */
export const stopLlmService = (): void => {
  if (serviceProcess) {
    serviceProcess.kill("SIGTERM");
    serviceProcess = null;
    serviceReady = false;
    starting = null;
    logger.info("[litellm-proxy] Service stopped");
  }
};
