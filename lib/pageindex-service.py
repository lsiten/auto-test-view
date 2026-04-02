#!/usr/bin/env python3
"""
PageIndex HTTP service for Electron integration.
Wraps PageIndexClient as a local HTTP API so the Node.js main process can
index recordings (as Markdown) and retrieve their semantic tree structures.

Usage:
    python3 pageindex-service.py <port> <workspace_dir>

Environment variables (set by Electron before spawning):
    OPENAI_API_KEY   - LLM API key (or proxy token)
    OPENAI_API_BASE  - LLM base URL (e.g., http://127.0.0.1:3398/v1 for proxy)
    PAGEINDEX_MODEL  - Model name for indexing (e.g., openai/claude-sonnet-4-20250514)
"""

import json
import os
import sys
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler

# Add the pageindex package to the Python path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "pageindex"))

from pageindex import PageIndexClient


class PageIndexHandler(BaseHTTPRequestHandler):
    """HTTP request handler for PageIndex operations."""

    client: PageIndexClient = None  # type: ignore[assignment]

    # Suppress default access logging
    def log_message(self, format, *args):
        print(f"[PageIndex] {format % args}", flush=True)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw)

    def _respond(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = 500):
        self._respond({"error": message}, status)

    def do_GET(self):
        if self.path == "/status":
            docs = {
                doc_id: {
                    "doc_name": info.get("doc_name", ""),
                    "doc_description": info.get("doc_description", ""),
                    "type": info.get("type", ""),
                    "path": info.get("path", ""),
                }
                for doc_id, info in self.client.documents.items()
            }
            self._respond({"status": "ok", "document_count": len(docs), "documents": docs})
            return

        self._error("Not found", 404)

    def do_POST(self):
        try:
            body = self._read_body()

            if self.path == "/index":
                file_path = body.get("file_path", "")
                if not file_path or not os.path.exists(file_path):
                    self._error(f"File not found: {file_path}", 400)
                    return
                mode = body.get("mode", "md")
                doc_id = self.client.index(file_path, mode=mode)
                doc_meta = json.loads(self.client.get_document(doc_id))
                self._respond({"doc_id": doc_id, **doc_meta})
                return

            if self.path == "/structure":
                doc_id = body.get("doc_id", "")
                result = json.loads(self.client.get_document_structure(doc_id))
                self._respond(result)
                return

            if self.path == "/content":
                doc_id = body.get("doc_id", "")
                pages = body.get("pages", "")
                result = json.loads(self.client.get_page_content(doc_id, pages))
                self._respond({"content": result} if isinstance(result, list) else result)
                return

            if self.path == "/document":
                doc_id = body.get("doc_id", "")
                result = json.loads(self.client.get_document(doc_id))
                self._respond(result)
                return

            if self.path == "/remove":
                doc_id = body.get("doc_id", "")
                if doc_id in self.client.documents:
                    del self.client.documents[doc_id]
                    # Remove workspace file if exists
                    if self.client.workspace:
                        ws_file = self.client.workspace / f"{doc_id}.json"
                        if ws_file.exists():
                            ws_file.unlink()
                    self._respond({"removed": True, "doc_id": doc_id})
                else:
                    self._error(f"Document not found: {doc_id}", 404)
                return

            if self.path == "/list":
                docs = []
                for doc_id, info in self.client.documents.items():
                    docs.append({
                        "doc_id": doc_id,
                        "doc_name": info.get("doc_name", ""),
                        "doc_description": info.get("doc_description", ""),
                        "type": info.get("type", ""),
                        "path": info.get("path", ""),
                    })
                self._respond({"documents": docs})
                return

            self._error("Not found", 404)

        except Exception as e:
            traceback.print_exc()
            self._error(str(e))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3397
    workspace = sys.argv[2] if len(sys.argv) > 2 else None
    model = os.environ.get("PAGEINDEX_MODEL", "gpt-4o-2024-11-20")

    print(f"[PageIndex] Starting service on port {port}", flush=True)
    print(f"[PageIndex] Model: {model}", flush=True)
    print(f"[PageIndex] Workspace: {workspace or 'none'}", flush=True)
    print(f"[PageIndex] OPENAI_API_BASE: {os.environ.get('OPENAI_API_BASE', 'default')}", flush=True)

    PageIndexHandler.client = PageIndexClient(model=model, workspace=workspace)

    server = HTTPServer(("127.0.0.1", port), PageIndexHandler)
    print(f"[PageIndex] Service ready on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
