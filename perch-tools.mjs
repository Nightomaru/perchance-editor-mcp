// perch-tools.mjs — shared tool schemas + dispatch table for the perch MCP
// server entries. perch-mcp.mjs (modern 2026-07-28 discover flow) and
// perch-mcp-legacy.mjs (legacy initialize/tools-list/tools-call handshake)
// both serve this exact set, so the two entries can never drift.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PerchSession } = require("./perch-core.js");

export const session = new PerchSession();

const PANE = { type: "string", enum: ["model", "output"] };
const FRAME = { type: "string", enum: ["preview", "editor"] };

// ----------------------------- tool schemas -----------------------------
export const TOOLS = [
  {
    name: "perch_start",
    description:
      "Start the Perchance editor session: launch the browser and load the given generator with its collab key, ready to edit — one call. Handles Cloudflare automatically (4-step escalation ladder). Re-calling with the same generator/collabKey is a fast no-op. Omit collabKey for a non-collab edit (must own the generator).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Generator name, e.g. 'minimal'" },
        collabKey: { type: "string", description: "Collab key from the editor URL hash (#edit:collab=KEY)" },
        headed: { type: "boolean", description: "Show a visible browser window. Default false" },
        engine: { type: "string", enum: ["firefox", "chromium"], description: "Browser engine. 'firefox' = plain playwright firefox (DEFAULT; clears Cloudflare on perchance.org subdomains where chromium is flagged; falls back to chromium when the firefox binary is absent). 'chromium' = plain playwright chromium escape hatch" },
        width: { type: "integer", description: "Viewport width. Default 1500" },
        height: { type: "integer", description: "Viewport height. Default 950" },
        force: { type: "boolean", description: "Reload even if already on this generator" },
      },
      required: ["name"],
    },
  },
  {
    name: "perch_status",
    description: "Report live editor state: save state, syntax errors, collab sync, line counts, engine, CF status, buffered console/error counts.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_pull",
    description:
      "BROWSER-FREE code access. Fetch the authoritative modelText (main.pjs) and outputTemplate (index.html) from Perchance's public API in ~1.2s — no browser, no Cloudflare, no collab key needed — and write them to local files. Grep/read those files directly for full-speed, full-text search of a 40k-line generator. Works without perch_start.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Generator name. Defaults to the current session generator" },
        dir: { type: "string", description: "Output directory. Default <perch dir>/.perch-mirror/<name>" },
      },
      required: [],
    },
  },
  {
    name: "perch_read",
    description: "Read a pane (model=main.pjs, output=index.html) from the LIVE editor as 1-indexed numbered lines.",
    inputSchema: {
      type: "object",
      properties: {
        pane: { ...PANE, description: "Default output" },
        offset: { type: "integer", description: "First line (1-indexed). Default 1" },
        limit: { type: "integer", description: "Max lines. Default 2000" },
      },
      required: [],
    },
  },
  {
    name: "perch_grep",
    description: "Regex search across one pane (or both if pane omitted). Returns matching lines with optional context.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JS regex pattern" },
        pane: { ...PANE, description: "Omit to search both" },
        contextLines: { type: "integer", description: "Lines of context around each hit. Default 0" },
        limit: { type: "integer", description: "Max matches returned. Default 200" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "perch_edit",
    description: "Surgical find/replace in a pane. Yjs settle runs by default so the edit survives a reload.",
    inputSchema: {
      type: "object",
      properties: {
        pane: { ...PANE, description: "Default output" },
        oldString: { type: "string", description: "Exact text to find" },
        newString: { type: "string", description: "Replacement text" },
        replaceAll: { type: "boolean", description: "Replace all occurrences. Default false" },
        nth: { type: "integer", description: "Replace only the Nth occurrence (1-indexed)" },
        settle: { type: "boolean", description: "Settle Yjs sync after edit. Default true" },
      },
      required: ["oldString", "newString"],
    },
  },
  {
    name: "perch_patch",
    description: "Apply multiple surgical changes in one call. Each change: {pane, oldString, newString, replaceAll?, nth?}.",
    inputSchema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pane: PANE,
              oldString: { type: "string" },
              newString: { type: "string" },
              replaceAll: { type: "boolean" },
              nth: { type: "integer" },
            },
            required: ["oldString", "newString"],
          },
        },
        settle: { type: "boolean", description: "Settle Yjs sync after all changes. Default true" },
      },
      required: ["changes"],
    },
  },
  {
    name: "perch_write",
    description: "Replace an entire pane's document with new content.",
    inputSchema: {
      type: "object",
      properties: {
        pane: { ...PANE, description: "Default output" },
        content: { type: "string", description: "Full new document text" },
        settle: { type: "boolean", description: "Settle Yjs sync after write. Default true" },
      },
      required: ["content"],
    },
  },
  {
    name: "perch_outline",
    description: "Line map of function/class/const declarations — orient in a 40k-line file without reading it all.",
    inputSchema: {
      type: "object",
      properties: {
        pane: { ...PANE, description: "Default output" },
        limit: { type: "integer", description: "Max entries. Default 400" },
      },
      required: [],
    },
  },
  {
    name: "perch_copy_lines",
    description: "Byte-exact copy of source lines into a destination pane (after a target line, or append).",
    inputSchema: {
      type: "object",
      properties: {
        fromPane: PANE,
        startLine: { type: "integer", description: "First line to copy (1-indexed)" },
        endLine: { type: "integer", description: "Last line to copy (inclusive). Default startLine" },
        toPane: { ...PANE, description: "Default fromPane" },
        afterLine: { type: "integer", description: "Insert after this line. Omit to append" },
      },
      required: ["startLine"],
    },
  },
  {
    name: "perch_refresh",
    description: "Hard-reload the live preview and report syntax errors, runtime errors and new console lines.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_console",
    description: "Read the console: Perchance's #console-output panel plus the buffered console + runtime errors captured from every frame.",
    inputSchema: {
      type: "object",
      properties: { clear: { type: "boolean", description: "Clear the buffers after reading. Default false" } },
      required: [],
    },
  },
  {
    name: "perch_errors",
    description: "Error triage in one call: editor syntax errors (window.getEditorSyntaxErrors) + buffered runtime/page errors + console tail. Use clear:true to reset buffers after a fix.",
    inputSchema: {
      type: "object",
      properties: { clear: { type: "boolean", description: "Clear buffers after reading. Default false" } },
      required: [],
    },
  },
  {
    name: "perch_eval",
    description: "Run a JS expression and return its value. Default frame is the running generator ('preview'); use frame:'editor' for the editor page.",
    inputSchema: {
      type: "object",
      properties: {
        js: { type: "string", description: "JS expression to evaluate" },
        frame: { ...FRAME, description: "Default preview" },
      },
      required: ["js"],
    },
  },
  {
    name: "perch_snapshot",
    description: "Text-first UI testing: list the visible interactive elements (buttons/inputs/links) in the live preview with a ready-to-use CSS selector each. Use this instead of screenshots to find what to click.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { ...FRAME, description: "Default preview" },
        filter: { type: "string", description: "Only elements whose label/tag contains this text" },
        limit: { type: "integer", description: "Max elements. Default 250" },
      },
      required: [],
    },
  },
  {
    name: "perch_wait",
    description: "Wait for a selector or visible text to appear (or vanish with gone:true) in the preview. Use after a click/edit before asserting.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector or 'text=Visible Text'" },
        text: { type: "string", description: "Visible text to wait for" },
        gone: { type: "boolean", description: "Wait for it to DISAPPEAR instead. Default false" },
        frame: { ...FRAME, description: "Default preview" },
        timeout: { type: "integer", description: "ms. Default 15000" },
      },
      required: [],
    },
  },
  {
    name: "perch_click",
    description: "Click an element in the live preview (or editor chrome). selector: CSS selector or 'text=Visible Text'.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector or 'text=...'" },
        frame: { ...FRAME, description: "Default preview" },
        nth: { type: "integer", description: "Click the Nth match instead of the first" },
        timeout: { type: "integer", description: "ms. Default 10000" },
      },
      required: ["selector"],
    },
  },
  {
    name: "perch_type",
    description: "Type text into an element in the live preview (or editor chrome).",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector or 'text=...'" },
        text: { type: "string", description: "Text to type" },
        frame: { ...FRAME, description: "Default preview" },
        submit: { type: "boolean", description: "Press Enter after typing. Default false" },
        timeout: { type: "integer", description: "ms. Default 10000" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "perch_press",
    description: "Press a key (Enter, Tab, Escape, ...) on the focused element.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name, e.g. 'Enter'" },
        frame: { ...FRAME, description: "Default editor" },
      },
      required: ["key"],
    },
  },
  {
    name: "perch_shot",
    description: "Screenshot. what: 'editor' (default) = whole editor page; 'preview' = the running generator iframe.",
    inputSchema: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["editor", "preview"], description: "Default editor" },
        path: { type: "string", description: "Output file path" },
      },
      required: [],
    },
  },
  {
    name: "perch_src",
    description: "Read a src/ file (from the generator's srcManifest) via the CDN.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "src path, e.g. AGENTS.md" } },
      required: ["path"],
    },
  },
  {
    name: "perch_list_src",
    description: "List all src/ files in the generator's srcManifest with sizes.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_set_viewport",
    description: "Resize the live preview and report the iframe rect.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "integer", description: "Default 1500" },
        height: { type: "integer", description: "Default 950" },
      },
      required: [],
    },
  },
  {
    name: "perch_fetch_generator",
    description: "Fetch a public generator's source (modelText + outputTemplate) to local files. Alias of perch_pull.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Generator name" },
        path: { type: "string", description: "Output directory hint" },
      },
      required: ["name"],
    },
  },
  {
    name: "perch_stop",
    description: "Close the browser session. Call perch_start again to resume.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_navigate",
    description: "Navigate the whole editor PAGE to any https:// URL (top-level). Recovery tool: a Cloudflare interstitial can never render inside iframes, so when an embed/subframe (e.g. text-generation.perchance.org under the ai-text-plugin) is CF-blocked, visit that URL top-level once, let the challenge clear, then perch_start with force:true to reload the editor. Also loads arbitrary pages for inspection. Waits for a CF challenge to clear.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https:// URL to open top-level" },
        timeout: { type: "integer", description: "ms to wait for a CF challenge to clear. Default 30000" },
      },
      required: ["url"],
    },
  },
  {
    name: "perch_upload_src",
    description: "Upload a file into the generator's src/ via the editor's file panel. Source the bytes WITHOUT passing them through the conversation: prefer filePath (absolute local path, read server-side, byte-exact) or url (https, fetched server-side); inline content still works for small text. name may carry a virtual folder path (emoji/icon.svg) — the src store is flat string keys and the tree groups '/' keys into folders. overwrite:true deletes an existing file at that path first (the editor otherwise renames colliding uploads to name-2.ext instead of replacing). Lands in the editor src store ('saved'); goes public when the generator's owner saves.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name or path, e.g. README.md or emoji/icon.svg (folders are virtual)" },
        content: { type: "string", description: "Inline file content — small text only; it transits the model's context (transcription risk on big/dense files). Prefer filePath or url." },
        filePath: { type: "string", description: "ABSOLUTE local path read server-side, e.g. C:/Users/you/Workspace/app/src/emoji/x.svg — byte-exact, nothing transits the conversation" },
        url: { type: "string", description: "https URL fetched server-side (e.g. a raw.githubusercontent.com file) — nothing transits the conversation" },
        binary: { type: "boolean", description: "Force binary (base64 → real bytes page-side) or text handling. Default: inferred from the CONTENT (NUL-byte + strict-UTF-8 sniff), so unknown extensions like .onnx upload byte-exact" },
        timeout: { type: "integer", description: "ms to wait for the panel's 'saved' marker. Default 25000" },
        overwrite: { type: "boolean", description: "Delete an existing file at this path first, so the upload replaces it instead of being renamed. Default false" },
      },
      required: ["name"],
    },
  },
  {
    name: "perch_delete_src",
    description: "Delete a file from the generator's src/ via the editor's file tree (⋯ → 🗑️ delete → confirm). Staged in the editor store; the deletion goes public when the generator's owner saves. Pass the path the file lives under, e.g. AGENTS.md or emoji/old.svg.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "src path, e.g. AGENTS.md or emoji/old.svg" },
        timeout: { type: "integer", description: "ms to wait for the row to disappear. Default 20000" },
      },
      required: ["path"],
    },
  },
];

// ----------------------------- dispatch -----------------------------
export const DISPATCH = {
  perch_start: (a) => session.start(a),
  perch_status: () => session.status(),
  perch_pull: (a) => session.pull(a),
  perch_read: (a) => session.read(a),
  perch_grep: (a) => session.grep(a),
  perch_edit: (a) => session.edit(a),
  perch_patch: (a) => session.patch(a),
  perch_write: (a) => session.write(a),
  perch_outline: (a) => session.outline(a),
  perch_copy_lines: (a) => session.copyLines(a),
  perch_refresh: () => session.refresh(),
  perch_console: (a) => session.console(a),
  perch_errors: (a) => session.errors(a),
  perch_eval: (a) => session.eval(a),
  perch_snapshot: (a) => session.snapshot(a),
  perch_wait: (a) => session.wait(a),
  perch_click: (a) => session.click(a),
  perch_type: (a) => session.type(a),
  perch_press: (a) => session.press(a),
  perch_shot: (a) => session.shot(a),
  perch_src: (a) => session.src(a.path),
  perch_list_src: () => session.listSrc(),
  perch_set_viewport: (a) => session.setViewport(a),
  perch_fetch_generator: (a) => session.fetchGenerator(a),
  perch_stop: () => session.stop(),
  perch_navigate: (a) => session.navigate(a),
  perch_upload_src: (a) => session.uploadSrc(a),
  perch_delete_src: (a) => session.deleteSrc(a),
};
