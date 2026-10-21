#!/usr/bin/env node
// perch-mcp.mjs — MCP server for the Perchance live editor.
//
// Architecture (Playwright-MCP model): the browser lives IN this long-lived
// server process. No TCP daemon, no per-call spawn — every tool call is a
// direct in-process call into perch-core.js.
//
// Stdio transport; tools arrive namespaced by the client (e.g. mcp__perch_*).
//
// Tool set:
//   * perch_pull       — browser-FREE code access: fetch modelText +
//                        outputTemplate via the public API (~1.2s, no CF) and
//                        write main.pjs / index.html to a local mirror dir.
//   * perch_snapshot   — text-first UI testing: list interactive elements in
//                        the live preview with usable CSS selectors.
//   * perch_wait       — wait for a selector/text to appear or vanish.
//   * perch_errors     — syntax errors + buffered console/runtime errors.
//   * start.engine     — 'firefox' (DEFAULT; clears CF on perchance.org
//     subdomains) | 'chromium' (escape hatch / automatic fallback).
//   * preview-frame resolution that makes eval/click/type/shot all work.
//   * CF auto-escalation ladder inside perch_start.

import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { TOOLS, DISPATCH } from "./perch-tools.mjs";

const PANE = { type: "string", enum: ["model", "output"] };
const FRAME = { type: "string", enum: ["preview", "editor"] };

// ----------------------------- server factory (MCP v2) -----------------------------
function createServer() {
  const server = new McpServer({ name: "perch", version: "2.3.3" }, { capabilities: { tools: {} } });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema) },
      async (args) => {
        const fn = DISPATCH[tool.name];
        const t0 = Date.now();
        try {
          const result = await fn(args || {});
          result.ms = Date.now() - t0;
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 }) }] };
        }
      }
    );
  }
  return server;
}

// Modern-only (MCP 2026-07-28): legacy 'reject' makes a v1 client's initialize fail with
// -32022 (UnsupportedProtocolVersion), which Hermes 'auto' mode detects and falls back to
// server/discover (the modern path).
serveStdio(createServer, {
  legacy: "reject",
  onerror: (e) => { console.error("[perch] serveStdio error:", (e && e.message) || e); },
});

process.on("unhandledRejection", (e) => {
  console.error("[perch] unhandled rejection:", (e && e.message) || e);
});
process.on("uncaughtException", (e) => {
  console.error("[perch] uncaught:", (e && e.message) || e);
});
