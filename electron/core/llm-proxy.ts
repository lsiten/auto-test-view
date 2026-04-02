/**
 * Built-in LLM proxy that converts OpenAI-format requests to Anthropic Claude API format.
 * Runs a local HTTP server that page-agent can use as its LLM endpoint.
 * This eliminates the need for external proxy tools like LiteLLM.
 */

import * as http from "http";
import { logger } from "./logger";

const PROXY_PORT = 3398;
const ANTHROPIC_API_VERSION = "2023-06-01";
const MAX_TOKENS_DEFAULT = 4096;

let anthropicApiUrl = "https://api.anthropic.com/v1/messages";
let anthropicApiKey = "";

interface OpenAiMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | ReadonlyArray<unknown>;
  readonly tool_call_id?: string;
  readonly tool_calls?: ReadonlyArray<unknown>;
}

interface OpenAiRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<OpenAiMessage>;
  readonly tools?: ReadonlyArray<unknown>;
  readonly tool_choice?: unknown;
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
}

interface AnthropicContent {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

interface AnthropicResponse {
  readonly id: string;
  readonly type: string;
  readonly role: string;
  readonly content: ReadonlyArray<AnthropicContent>;
  readonly model: string;
  readonly stop_reason: string | null;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}

const convertMessagesToAnthropic = (
  messages: ReadonlyArray<OpenAiMessage>
): { system: string | undefined; messages: ReadonlyArray<{ role: string; content: unknown }> } => {
  let system: string | undefined;
  const converted: Array<{ role: string; content: unknown }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      continue;
    }

    if (msg.role === "tool") {
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      const content: Array<unknown> = [];
      if (msg.content) {
        content.push({ type: "text", text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) });
      }
      for (const tc of msg.tool_calls) {
        const toolCall = tc as { id: string; function: { name: string; arguments: string } };
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments),
        });
      }
      converted.push({ role: "assistant", content });
      continue;
    }

    converted.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    });
  }

  return { system, messages: converted };
};

const convertToolsToAnthropic = (
  tools: ReadonlyArray<unknown> | undefined
): ReadonlyArray<unknown> | undefined => {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => {
    const t = tool as { type: string; function: { name: string; description: string; parameters: unknown } };
    return {
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    };
  });
};

const convertAnthropicToOpenAi = (
  anthropicResp: AnthropicResponse
): unknown => {
  const choices: Array<unknown> = [];
  let finishReason = "stop";

  const assistantContent = anthropicResp.content;
  let textContent = "";
  const toolCalls: Array<unknown> = [];

  for (const block of assistantContent) {
    if (block.type === "text" && block.text) {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  if (anthropicResp.stop_reason === "tool_use") {
    finishReason = "tool_calls";
  } else if (anthropicResp.stop_reason === "end_turn") {
    finishReason = "stop";
  } else if (anthropicResp.stop_reason === "max_tokens") {
    finishReason = "length";
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: textContent || null,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  choices.push({
    index: 0,
    message,
    finish_reason: finishReason,
  });

  return {
    id: anthropicResp.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: anthropicResp.model,
    choices,
    usage: {
      prompt_tokens: anthropicResp.usage.input_tokens,
      completion_tokens: anthropicResp.usage.output_tokens,
      total_tokens: anthropicResp.usage.input_tokens + anthropicResp.usage.output_tokens,
    },
  };
};

/**
 * Convert tool_choice from various formats (OpenAI, Anthropic-native from page-agent Claude patch)
 * to the Anthropic API format.
 */
const convertToolChoice = (
  toolChoice: unknown
): { type: string; name?: string } | undefined => {
  if (toolChoice === "required") {
    return { type: "any" };
  }
  if (toolChoice === "auto") {
    return { type: "auto" };
  }
  if (toolChoice === "none") {
    return undefined;
  }
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const tc = toolChoice as { type?: string; function?: { name: string }; name?: string };
    // Anthropic-native format (from page-agent Claude patch): {type: "any"} or {type: "tool", name: "..."}
    if (tc.type === "any" || tc.type === "auto") {
      return { type: tc.type };
    }
    if (tc.type === "tool" && tc.name) {
      return { type: "tool", name: tc.name };
    }
    // OpenAI format: {type: "function", function: {name: "..."}}
    if (tc.function?.name) {
      return { type: "tool", name: tc.function.name };
    }
  }
  return undefined;
};

interface ProxyResult {
  readonly status: number;
  readonly body: unknown;
}

const handleChatCompletions = async (
  body: OpenAiRequest,
  apiKey: string
): Promise<ProxyResult> => {
  const { system, messages } = convertMessagesToAnthropic(body.messages);
  const tools = convertToolsToAnthropic(body.tools);

  const anthropicBody: Record<string, unknown> = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? MAX_TOKENS_DEFAULT,
  };

  if (system) {
    anthropicBody.system = system;
  }

  if (tools && tools.length > 0) {
    anthropicBody.tools = tools;
    const tc = convertToolChoice(body.tool_choice);
    if (tc) {
      anthropicBody.tool_choice = tc;
    }
  }

  if (body.temperature !== undefined) {
    anthropicBody.temperature = body.temperature;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_API_VERSION,
  };

  // Support both x-api-key (standard Anthropic) and Authorization header (proxies)
  headers["x-api-key"] = apiKey;
  if (!apiKey.startsWith("sk-ant-")) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  logger.info(`LLM Proxy -> ${anthropicApiUrl} [model=${body.model}, msgs=${body.messages.length}, tools=${tools?.length ?? 0}]`);

  const response = await fetch(anthropicApiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(anthropicBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`LLM Proxy upstream error: ${response.status} ${response.statusText} - ${errorText}`);
    // Pass through the upstream status code so page-agent sees the real error
    return {
      status: response.status,
      body: { error: { message: `Upstream API error (${response.status}): ${errorText}`, type: "upstream_error" } },
    };
  }

  const anthropicResp = (await response.json()) as AnthropicResponse;
  logger.info(`LLM Proxy <- OK [tokens: ${anthropicResp.usage.input_tokens}+${anthropicResp.usage.output_tokens}]`);
  return { status: 200, body: convertAnthropicToOpenAi(anthropicResp) };
};

const readRequestBody = (req: http.IncomingMessage): Promise<string> => {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
};

let proxyServer: http.Server | null = null;

export const startLlmProxy = async (apiKey: string, baseUrl?: string): Promise<string> => {
  if (proxyServer) {
    return `http://127.0.0.1:${PROXY_PORT}/v1`;
  }

  anthropicApiKey = apiKey;

  // Support custom Anthropic-compatible endpoints (e.g. company proxies)
  if (baseUrl) {
    const trimmed = baseUrl.replace(/\/+$/, "");
    // If baseUrl already ends with /messages, use as-is
    if (trimmed.endsWith("/messages")) {
      anthropicApiUrl = trimmed;
    } else if (trimmed.endsWith("/v1")) {
      anthropicApiUrl = `${trimmed}/messages`;
    } else {
      anthropicApiUrl = `${trimmed}/v1/messages`;
    }
  }

  logger.info(`LLM Proxy will forward to: ${anthropicApiUrl}`);

  proxyServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${PROXY_PORT}`);

    // Handle /v1/chat/completions
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        const bodyStr = await readRequestBody(req);
        const body = JSON.parse(bodyStr) as OpenAiRequest;

        const result = await handleChatCompletions(body, apiKey);

        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("LLM Proxy error", message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message, type: "proxy_error" } }));
      }
      return;
    }

    // Handle /v1/models (for compatibility)
    if (url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [
          { id: "claude-sonnet-4-20250514", object: "model", owned_by: "anthropic" },
          { id: "claude-opus-4-20250514", object: "model", owned_by: "anthropic" },
          { id: "claude-haiku-4-5-20251001", object: "model", owned_by: "anthropic" },
        ],
      }));
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  await new Promise<void>((resolve, reject) => {
    proxyServer!.listen(PROXY_PORT, "127.0.0.1", () => resolve());
    proxyServer!.on("error", reject);
  });

  const proxyUrl = `http://127.0.0.1:${PROXY_PORT}/v1`;
  logger.info(`LLM proxy started at ${proxyUrl} (Anthropic Claude adapter)`);
  return proxyUrl;
};

export const stopLlmProxy = async (): Promise<void> => {
  if (proxyServer) {
    await new Promise<void>((resolve) => {
      proxyServer!.close(() => resolve());
    });
    proxyServer = null;
    logger.info("LLM proxy stopped");
  }
};
