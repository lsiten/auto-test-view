#!/usr/bin/env python3
"""
LLM proxy service: OpenAI-compatible API -> Anthropic Messages API.

Receives OpenAI-format requests from page-agent, converts to Anthropic
Messages API format, forwards to backend, converts response back to
OpenAI format.

No litellm dependency — manual format conversion for full control.

Usage: python3 litellm-proxy.py <port>

Environment variables:
  LLM_API_KEY    - API key for the backend
  LLM_BASE_URL   - Backend API base URL (Anthropic-compatible)
  LLM_MODEL      - Default model name
"""
import json
import os
import sys
import time
import traceback
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

_api_key = ""
_api_base = ""
_default_model = ""

MAX_RETRIES = 2
RETRY_DELAY = 1.0


# ---------------------------------------------------------------------------
# OpenAI -> Anthropic request conversion
# ---------------------------------------------------------------------------

def _convert_tools_to_anthropic(tools):
    """Convert OpenAI tools to Anthropic tool format."""
    if not tools:
        return []
    result = []
    for tool in tools:
        if tool.get("type") == "function":
            fn = tool["function"]
            result.append({
                "name": fn["name"],
                "description": fn.get("description", ""),
                "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
            })
    return result


def _convert_tool_choice_to_anthropic(tc):
    """Convert OpenAI tool_choice to Anthropic format."""
    if tc is None:
        return None
    if isinstance(tc, str):
        if tc == "auto":
            return {"type": "auto"}
        if tc == "none":
            return None
        if tc == "required":
            return {"type": "any"}
        return {"type": "auto"}
    if isinstance(tc, dict):
        # {"type": "function", "function": {"name": "X"}} -> {"type": "tool", "name": "X"}
        if tc.get("type") == "function" and "function" in tc:
            return {"type": "tool", "name": tc["function"]["name"]}
        # Already {"type": "tool", "name": "X"} (from page-agent)
        if tc.get("type") == "tool" and "name" in tc:
            return tc
    return {"type": "auto"}


def _convert_messages_to_anthropic(messages):
    """Convert OpenAI messages to Anthropic format.

    Returns (system_prompt, anthropic_messages).
    """
    system_parts = []
    anthropic_msgs = []

    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content")

        if role == "system":
            if isinstance(content, str):
                system_parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        system_parts.append(block["text"])
                    elif isinstance(block, str):
                        system_parts.append(block)
            continue

        if role == "assistant":
            blocks = []
            # Text content
            if isinstance(content, str) and content:
                blocks.append({"type": "text", "text": content})
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        blocks.append(block)

            # Tool calls
            tool_calls = msg.get("tool_calls", [])
            for tc in tool_calls:
                fn = tc.get("function", {})
                args = fn.get("arguments", "{}")
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = {}
                blocks.append({
                    "type": "tool_use",
                    "id": tc.get("id", f"toolu_{uuid.uuid4().hex[:24]}"),
                    "name": fn.get("name", ""),
                    "input": args,
                })

            if blocks:
                anthropic_msgs.append({"role": "assistant", "content": blocks})
            continue

        if role == "tool":
            # Tool result -> Anthropic tool_result
            anthropic_msgs.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": msg.get("tool_call_id", ""),
                    "content": content if isinstance(content, str) else json.dumps(content),
                }],
            })
            continue

        if role == "user":
            if isinstance(content, str):
                anthropic_msgs.append({"role": "user", "content": content})
            elif isinstance(content, list):
                anthropic_msgs.append({"role": "user", "content": content})
            continue

    system_prompt = "\n\n".join(system_parts) if system_parts else None
    return system_prompt, anthropic_msgs


def build_anthropic_request(body):
    """Convert OpenAI request body to Anthropic Messages API request."""
    system_prompt, messages = _convert_messages_to_anthropic(body.get("messages", []))

    req = {
        "model": body.get("model", _default_model),
        "messages": messages,
        "max_tokens": body.get("max_tokens", 4096),
    }

    if body.get("temperature") is not None:
        req["temperature"] = body["temperature"]

    if system_prompt:
        req["system"] = system_prompt

    tools = _convert_tools_to_anthropic(body.get("tools"))
    if tools:
        req["tools"] = tools

    tc = body.get("tool_choice")
    # Normalize page-agent format first
    if isinstance(tc, dict) and tc.get("type") == "tool" and "name" in tc:
        pass  # Already Anthropic format
    elif isinstance(tc, dict) and tc.get("type") == "function" and "function" in tc:
        tc = {"type": "tool", "name": tc["function"]["name"]}
    if tc:
        converted = _convert_tool_choice_to_anthropic(tc)
        if converted:
            req["tool_choice"] = converted

    return req


# ---------------------------------------------------------------------------
# Anthropic -> OpenAI response conversion
# ---------------------------------------------------------------------------

def convert_anthropic_response(resp):
    """Convert Anthropic Messages API response to OpenAI format."""
    content_blocks = resp.get("content", [])

    text_parts = []
    tool_calls = []

    for block in content_blocks:
        btype = block.get("type", "")
        if btype == "text":
            text_parts.append(block.get("text", ""))
        elif btype == "tool_use":
            tool_calls.append({
                "id": block.get("id", f"call_{uuid.uuid4().hex[:24]}"),
                "type": "function",
                "function": {
                    "name": block.get("name", ""),
                    "arguments": json.dumps(block.get("input", {}), ensure_ascii=False),
                },
            })

    message = {
        "role": "assistant",
        "content": "\n".join(text_parts) if text_parts else None,
    }
    if tool_calls:
        message["tool_calls"] = tool_calls

    # Map stop_reason
    stop_reason = resp.get("stop_reason", "end_turn")
    finish_reason = "stop"
    if stop_reason == "tool_use":
        finish_reason = "tool_calls"
    elif stop_reason == "max_tokens":
        finish_reason = "length"

    # Usage
    usage = resp.get("usage", {})
    openai_usage = {
        "prompt_tokens": usage.get("input_tokens", 0),
        "completion_tokens": usage.get("output_tokens", 0),
        "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
    }

    return {
        "id": f"chatcmpl-{resp.get('id', uuid.uuid4().hex[:24])}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": resp.get("model", _default_model),
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason,
        }],
        "usage": openai_usage,
    }


# ---------------------------------------------------------------------------
# HTTP Server
# ---------------------------------------------------------------------------

class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[llm-proxy] {format % args}", flush=True)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw)

    def _respond(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = 500):
        self._respond({"error": {"message": message, "type": "proxy_error"}}, status)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._respond({"status": "ok"})
            return
        if self.path == "/v1/models":
            self._respond({
                "object": "list",
                "data": [{"id": _default_model, "object": "model", "owned_by": "proxy"}]
            })
            return
        self._error("Not found", 404)

    def do_POST(self):
        try:
            if self.path == "/v1/chat/completions":
                body = self._read_body()

                if not body.get("model"):
                    body["model"] = _default_model

                model = body.get("model", _default_model)
                msg_count = len(body.get("messages", []))
                print(f"[llm-proxy] -> {model} msgs={msg_count}", flush=True)

                # Convert OpenAI -> Anthropic
                anthropic_body = build_anthropic_request(body)
                target_url = _api_base.rstrip("/") + "/v1/messages"
                payload = json.dumps(anthropic_body, ensure_ascii=False).encode("utf-8")

                headers = {
                    "Content-Type": "application/json",
                    "x-api-key": _api_key,
                    "anthropic-version": "2023-06-01",
                }

                # Retry on transient errors
                last_error = None
                for attempt in range(MAX_RETRIES + 1):
                    try:
                        req = Request(target_url, data=payload, headers=headers, method="POST")
                        resp = urlopen(req, timeout=300)
                        resp_body = resp.read().decode("utf-8")
                        anthropic_resp = json.loads(resp_body)

                        # Convert Anthropic -> OpenAI
                        openai_resp = convert_anthropic_response(anthropic_resp)
                        tokens = openai_resp.get("usage", {}).get("total_tokens", "?")
                        print(f"[llm-proxy] <- OK tokens={tokens}", flush=True)
                        self._respond(openai_resp)
                        return
                    except HTTPError as e:
                        error_body = e.read().decode("utf-8", errors="replace")
                        last_error = e
                        if attempt < MAX_RETRIES and e.code >= 500:
                            print(f"[llm-proxy] Attempt {attempt + 1} backend HTTP {e.code}, retrying...", flush=True)
                            time.sleep(RETRY_DELAY)
                        else:
                            print(f"[llm-proxy] Backend HTTP {e.code}: {error_body[:500]}", flush=True)
                            self._error(f"Backend error {e.code}: {error_body[:200]}", status=e.code)
                            return
                    except URLError as e:
                        last_error = e
                        if attempt < MAX_RETRIES:
                            print(f"[llm-proxy] Attempt {attempt + 1} connection error: {e.reason}, retrying...", flush=True)
                            time.sleep(RETRY_DELAY)
                        else:
                            print(f"[llm-proxy] Backend connection error: {e.reason}", flush=True)
                            self._error(f"Backend connection error: {e.reason}")
                            return

                # Should not reach here, but just in case
                if last_error:
                    self._error(str(last_error))
                return

            self._error("Not found", 404)
        except Exception as e:
            traceback.print_exc()
            self._error(str(e)[:500])


def main():
    global _api_key, _api_base, _default_model

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3398
    _api_key = os.environ.get("LLM_API_KEY", "")
    _api_base = os.environ.get("LLM_BASE_URL", "")
    _default_model = os.environ.get("LLM_MODEL", "")

    print(f"[llm-proxy] Starting on port {port}", flush=True)
    print(f"[llm-proxy] Backend: {_api_base}", flush=True)
    print(f"[llm-proxy] Model: {_default_model}", flush=True)

    server = HTTPServer(("127.0.0.1", port), ProxyHandler)
    print(f"[llm-proxy] Service ready on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
