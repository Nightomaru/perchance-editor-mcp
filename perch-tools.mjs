// perch-tools.mjs — shared tool schemas + dispatch table for the perch MCP
// server entries. perch-mcp.mjs (modern 2026-07-28 discover flow) and
// perch-mcp-legacy.mjs (legacy initialize/tools-list/tools-call handshake)
// both serve this exact set, so the two entries can never drift.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PerchSession } = require("./perch-core.js");
const { publicUploader } = require("./perch-upload.js");

export const session = new PerchSession();

const PANE = { type: "string", enum: ["model", "output"] };
const FRAME = { type: "string", enum: ["preview", "editor"] };

// ----------------------------- tool schemas -----------------------------
export const TOOLS = [
  {
    name: "perch_start",
    description:
      "Start the Perchance editor session: launch the browser and load the given generator with its collab key, ready to edit — one call. Handles Cloudflare automatically (steps inside an engine, then the next engine in engineChain). Re-calling with the same generator/collabKey is a fast no-op. Omit collabKey for a non-collab edit (must own the generator). Reports the PREVIEW's health too: the editor page can be fine while the generator frame never boots ('This generator could not start because its file loader did not become available') — in that case the ladder has already tried the other engines, and the result says previewDegraded.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Generator name, e.g. 'minimal'" },
        collabKey: { type: "string", description: "Collab key from the editor URL hash (#edit:collab=KEY)" },
        headed: { type: "boolean", description: "Show a visible browser window. Default false. Chromium-family engines cannot clear Cloudflare headless, so they only work with headed:true" },
        engine: { type: "string", enum: ["firefox", "chrome", "chromium", "patchright"], description: "Browser engine to start with. 'firefox' (DEFAULT) = plain playwright firefox: the only engine that clears Cloudflare on perchance.org subdomains AND the only one that can use Perchance's server-side generation plugins (ai-text replies, src uploads). 'chrome' = plain playwright chromium (no stealth): drives the editor and the preview when headed:true, but cannot reach the ai-text/upload embeds. 'chromium' = the same plus the legacy stealth args. 'patchright' = patched-playwright chromium: clears Cloudflare headed, but the platform's editor globals (window.outputTemplateEditor / window.modelTextEditor) never publish, so docs cannot be read or written." },
        engineChain: { type: "array", items: { type: "string", enum: ["firefox", "chrome", "chromium", "patchright"] }, description: "Engines to try IN ORDER when one cannot load the editor or its preview. Default: the recommended chain starting at `engine` (firefox -> chrome -> chromium -> patchright). Pass [\"firefox\"] (or false) to pin one engine and never switch." },
        width: { type: "integer", description: "Viewport width. Default 1500" },
        height: { type: "integer", description: "Viewport height. Default 950" },
        force: { type: "boolean", description: "Reload even if already on this generator" },
      },
      required: ["name"],
    },
  },
  {
    name: "perch_status",
    description: "Report live editor state: save state, syntax errors, collab sync, line counts, engine, CF status, buffered console/error counts, and the preview's health (preview.booted / preview.loaderError). preview.loaderError true means the generator frame reported 'its file loader did not become available' - the app never booted there, so every perch_eval/perch_click against the preview will hang. Fix: perch_start again (fresh context), then a different engine via engineChain.",
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
    name: "perch_write_file",
    description:
      "Replace an entire pane's document with a LOCAL file's contents, read server-side (byte-exact). " +
      "The large-document path: perch_write cannot carry a 2.6 MB outputTemplate through one MCP call, " +
      "and the editor page's CSP blocks fetching it from localhost. Same dispatch as perch_write.",
    inputSchema: {
      type: "object",
      properties: {
        pane: { ...PANE, description: "Default output" },
        filePath: { type: "string", description: "Absolute local path to the file to load" },
        settle: { type: "boolean", description: "Settle Yjs sync after write. Default true" },
      },
      required: ["filePath"],
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
    description:
      "Reload the live preview. mode:'hot' (default) = the platform's in-place hot-update (~0.7s, no navigation) - good for HTML/CSS/text-only changes, but a generator-SCRIPT change dies in the platform's script re-runner (top-level let redeclaration) and the previous code keeps running. " +
      "mode:'rebuild' = working-copy rebuild WITHOUT navigation: pre-wraps the room template's inline scripts in the re-execution-safe form and posts the platform's own updateOutput message, so the preview runs the editor's latest UNSAVED panes (collab rooms included) - the only mode that reliably applies script edits (main.pjs logic or inline JS in index.html). Does not touch saved state. " +
      "probeJs (rebuild only): a JS expression evaluated in the preview after the rebuild and returned as `probe` - one-call verification that the new code is live (e.g. \"typeof myNewGlobal === 'function'\"). Reports render confirmation, preview health, runtime errors and new console lines.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["hot", "rebuild"], description: "Default 'hot'. Use 'rebuild' after editing the generator's script, or whenever the preview must run the room's latest bytes (collab rooms included)." },
        probeJs: { type: "string", description: "JS expression evaluated in the preview after a rebuild, returned as probe. Ignored in hot mode." },
      },
      required: [],
    },
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
    name: "perch_hover",
    description: "Move the real mouse over an element so CSS :hover applies (hover-revealed controls, tooltips). JS clicks and evals cannot do this. Pair with perch_eval + getComputedStyle to assert hover styles.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector or 'text=...'" },
        frame: { ...FRAME, description: "Default preview" },
        nth: { type: "integer", description: "Hover the Nth match instead of the first" },
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
    description: "Screenshot. what: 'editor' (default) = whole editor page; 'preview' = the running generator iframe (clip-based — safe on apps with infinite animations, 15s hard timeout). selector: capture a single element instead (must be visible; frame picks where it lives, default preview). Finite animations are fast-forwarded and infinite ones frozen for a deterministic frame.",
    inputSchema: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["editor", "preview"], description: "Default editor. Ignored when selector is set." },
        selector: { type: "string", description: "CSS selector of one element to capture, e.g. '#csNav' or '.character'" },
        frame: { ...FRAME, description: "Where selector lives: 'preview' (default) or 'editor'" },
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
  {
    name: "perch_upload_file",
    description:
      "Upload a file to Perchance's PUBLIC uploader (perchance.org/upload) and get a public URL — NOT the editor src/ store: no generator, no collab key, no owner save. Files are anonymous and accessible to ANYONE with the link — never upload secrets or personal data. First call launches a dedicated visible patchright-chromium window (headed is mandatory to pass Cloudflare + Turnstile; keep it visible, not minimized/occluded) and keeps it warm ~20 min. Source precedence: filePath > url > content. filePath is read server-side byte-exact (nothing transits the conversation); url is fetched by Perchance's SERVER directly (no local download); content is small inline text only. expires raises the server's max size / daily quota (1d ~400x, 1y ~20x); deletion after expiry is not guaranteed instant. Identical bytes dedup to the same URL (fileAlreadyExisted:true). Returns {url, fileId, deletionKey, size, expiresAt, deleteExpiresAt, integrity:{status,bytes,sha256,match}} — integrity is a real readback of the public URL, hash-compared against the local bytes (match:null for url sources). Delete rights last 3 days (perch_delete_file); after that storage is permanent unless an expiry was set. WebP is much smaller than PNG for transparency — convert big PNGs before uploading.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute local path, read server-side byte-exact — preferred for images/binaries; nothing transits the conversation" },
        url: { type: "string", description: "https URL — Perchance's server fetches and stores it directly (no local download; integrity.match will be null)" },
        content: { type: "string", description: "Small inline text content (transits the conversation — prefer filePath/url for anything big or binary)" },
        name: { type: "string", description: "Stored file name. Default: basename of filePath, last URL segment, or upload.txt" },
        expires: { type: "string", enum: ["never", "1h", "1d", "1w", "1mo", "3mo", "1y"], description: "File expiry. Default never (= permanent after the 3-day delete window). Setting an expiry raises max file size and daily allowance: 1d ~400x, 1y ~20x. The file MAY outlive the set expiry." },
      },
      required: [],
    },
  },
  {
    name: "perch_delete_file",
    description:
      "Delete a file uploaded via perch_upload_file (the PUBLIC uploader — not editor src/; that's perch_delete_src). Pass the fileId + deletionKey from the upload result. Delete rights expire 3 days after upload; afterwards the file is permanent unless an expiry was set. Deletion propagates through caches — fully gone within ~a day. Deleting also clears the content-hash dedup entry, so re-uploading the same bytes afterwards creates a fresh file with fresh delete rights.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "fileId from perch_upload_file's result (the content hash in the URL)" },
        deletionKey: { type: "string", description: "deletionKey from perch_upload_file's result" },
      },
      required: ["fileId", "deletionKey"],
    },
  },
  {
    name: "perch_batch",
    description:
      "Chain multiple UI actions in ONE call. Each step runs in-process (no per-step agent round-trip - that round-trip, not the click itself, is where the latency lives). steps: [{action, ...that tool's args FLAT}], e.g. [{action:'eval', js:'window.csPagerGoTo(2)'},{action:'wait', selector:'#starterCharacterList .character'},{action:'click', selector:'#starterCharacterList .character', nth:0},{action:'wait', selector:'#messageInput'},{action:'eval', js:'(async()=>{const c=await window.db.characters.toArray();return c.map(x=>x.name)})()'}]. Chainable actions: click, hover, type, press, eval, wait, shot, snapshot, errors, console, status, grep, read, refresh. Lifecycle (start/stop/navigate) and pane-write/asset tools stay solo. The whole chain is validated BEFORE anything executes. Stops at the first failed step unless continueOnError:true. stepDelayMs pauses between steps (default 0; use it or wait steps for UI transitions - perch_wait has no plain ms sleep). Each step result is truncated to maxResultChars (default 4000). timeoutMs is the whole-chain budget (default 120000); a timed-out step's underlying browser action may still complete, so probe state before retrying. Returns {ok, completed, total, steps:[{i, action, ok, ms, result|error}], ms}.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description:
            "Ordered steps, max 50. Each: {action: <name without perch_ prefix>, ...args of that tool flat (selector/js/text/key/frame/nth/timeout/...)}",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["click", "hover", "type", "press", "eval", "wait", "shot", "snapshot", "errors", "console", "status", "grep", "read", "refresh"],
              },
            },
            required: ["action"],
            additionalProperties: true,
          },
        },
        continueOnError: { type: "boolean", description: "Keep going after a failed step. Default false (stop at first failure)" },
        stepDelayMs: { type: "integer", description: "Pause between steps. Default 0" },
        maxResultChars: { type: "integer", description: "Truncate each step's result JSON to this many chars. Default 4000" },
        timeoutMs: { type: "integer", description: "Whole-chain budget in ms. Default 120000" },
      },
      required: ["steps"],
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
  perch_write_file: (a) => session.writeFile(a),
  perch_outline: (a) => session.outline(a),
  perch_copy_lines: (a) => session.copyLines(a),
  perch_refresh: (a) => session.refresh(a),
  perch_console: (a) => session.console(a),
  perch_errors: (a) => session.errors(a),
  perch_eval: (a) => session.eval(a),
  perch_snapshot: (a) => session.snapshot(a),
  perch_wait: (a) => session.wait(a),
  perch_click: (a) => session.click(a),
  perch_hover: (a) => session.hover(a),
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
  perch_upload_file: (a) => publicUploader.upload(a),
  perch_delete_file: (a) => publicUploader.delete(a),
};

// ----------------------------- batch chaining -----------------------------
// One MCP call, many UI actions: steps dispatch in-process, so the per-step cost
// is milliseconds of Playwright work instead of a full agent round-trip. Only
// UI-driving + observation tools are chainable; lifecycle and pane-write/asset
// tools stay solo (a half-applied write chain is not a thing we want).
const BATCH_ACTIONS = new Set([
  "click", "hover", "type", "press", "eval", "wait", "shot", "snapshot",
  "errors", "console", "status", "grep", "read", "refresh",
]);

DISPATCH.perch_batch = async (a) => {
  const t0 = Date.now();
  const fail = (error) => ({ ok: false, error, ms: Date.now() - t0 });
  const stepsIn = a && a.steps;
  if (!Array.isArray(stepsIn) || stepsIn.length === 0) return fail("steps must be a non-empty array");
  if (stepsIn.length > 50) return fail("too many steps (max 50)");
  const continueOnError = a.continueOnError === true;
  const stepDelayMs = Number.isFinite(a.stepDelayMs) ? Math.max(0, a.stepDelayMs) : 0;
  const maxResultChars = Number.isFinite(a.maxResultChars) ? Math.max(200, a.maxResultChars) : 4000;
  const budgetMs = Number.isFinite(a.timeoutMs) ? Math.max(1000, a.timeoutMs) : 120000;

  // Validate the WHOLE chain before touching the browser: a malformed step 7
  // must not leave steps 1-6 half-applied.
  for (let i = 0; i < stepsIn.length; i++) {
    const s = stepsIn[i];
    if (!s || typeof s !== "object" || typeof s.action !== "string") return fail(`step ${i}: missing action`);
    if (!BATCH_ACTIONS.has(s.action)) {
      return fail(`step ${i}: action '${s.action}' is not chainable (allowed: ${[...BATCH_ACTIONS].join(", ")})`);
    }
  }

  const steps = [];
  let allOk = true;
  for (let i = 0; i < stepsIn.length; i++) {
    const { action, ...args } = stepsIn[i];
    const remaining = budgetMs - (Date.now() - t0);
    if (remaining <= 0) {
      steps.push({ i, action, ok: false, error: "batch timeout before step", ms: 0 });
      allOk = false;
      break;
    }
    const st0 = Date.now();
    let timer = null;
    let rec;
    try {
      const fn = DISPATCH["perch_" + action];
      const result = await Promise.race([
        fn(args),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`step timeout after ${remaining}ms (underlying browser action may still complete)`)), remaining);
        }),
      ]);
      const okStep = !(result && result.ok === false);
      let payload = result;
      const serialized = JSON.stringify(result);
      if (serialized && serialized.length > maxResultChars) {
        payload = serialized.slice(0, maxResultChars) + `...(truncated, ${serialized.length} chars total)`;
      }
      rec = { i, action, ok: okStep, ms: Date.now() - st0, result: payload };
      if (!okStep) allOk = false;
    } catch (e) {
      rec = { i, action, ok: false, ms: Date.now() - st0, error: String((e && e.message) || e) };
      allOk = false;
    } finally {
      if (timer) clearTimeout(timer);
    }
    steps.push(rec);
    if (!rec.ok && !continueOnError) break;
    if (stepDelayMs > 0 && i < stepsIn.length - 1) await new Promise((r) => setTimeout(r, stepDelayMs));
  }
  return { ok: allOk && steps.length === stepsIn.length, completed: steps.length, total: stepsIn.length, steps, ms: Date.now() - t0 };
};
