#!/usr/bin/env node
/**
 * Tableau MCP App - STEP 0 feasibility probe.
 *
 * Single question this server exists to answer:
 *   Can an MCP Apps sandboxed iframe load the Tableau Embedding API from
 *   public.tableau.com and render an external Tableau Public viz?
 *
 * It declares exactly one tool and one ui:// resource. Nothing else is built
 * until the probe returns a verdict.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  getUiCapability,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

import { applyToken, buildViewTemplate, cspDomainsFor, DEFAULT_VIZ_URL } from "./build-view.js";
import { connectedAppConfig, signEmbedToken } from "./connected-app.js";
import { formatEnvLoad, loadEnvFile } from "./env.js";
import { formatPreflight, runPreflight } from "./preflight.js";

// Before anything reads process.env. A variable already set in the shell wins
// over the file, so an override for a single run still works.
console.error(formatEnvLoad(loadEnvFile()));

// Override to test a different Tableau host. The open question this exists to
// answer: Claude Desktop blocks frame-src to public.tableau.com, but is that
// host-wide or specific to that origin? Pointing at a Tableau Cloud origin
// settles it. A wrong path still answers the question - a login page or a 404
// inside the frame proves the frame was allowed to load at all.
const VIZ_URL = process.env.TABLEAU_VIZ_URL || DEFAULT_VIZ_URL;
const VIZ_DOMAINS = cspDomainsFor(VIZ_URL);

// EMBED_DEBUG=1 forces the on-screen diagnostic panel on. Off by default: the
// panel still reveals itself automatically if the embed fails.
const DEBUG = process.env.EMBED_DEBUG === "1";

// EMBED_PROBE_MESSAGES=1 additionally pushes probe JSON into the conversation
// on success. Deliberately NOT the same switch: the panel is a diagnostic you
// read, while probe messages are conversation content the model reads, and
// during a scoping test that extra user-role text competes with the pushed
// on-screen state. Failures report up either way.
const PROBE_MESSAGES = process.env.EMBED_PROBE_MESSAGES === "1";

// EMBED_STATE_MESSAGES=0 turns off delivering on-screen state as a message.
// ON by default, which inverts the usual habit for a reason: as of 2026-08-15
// ChatGPT accepts `ui/update-model-context`, resolves every call, and delivers
// none of it. Thirteen pushes carrying a random per-push id reached the model
// zero times; the same state sent via `sendMessage` arrived intact and the id
// matched. Until that changes, this is the only channel that works, so the
// product should not depend on remembering to switch it on.
const STATE_MESSAGES = process.env.EMBED_STATE_MESSAGES !== "0";

// Anonymous (Tableau Public) unless Connected App credentials are present.
// Misconfiguration throws here rather than surfacing as a login prompt inside
// the iframe, which is near-impossible to diagnose from the outside.
const CONNECTED_APP = connectedAppConfig();

// The SDK inlining is expensive, so the template is built once; only the
// short-lived token is substituted per render.
const VIEW_TEMPLATE = buildViewTemplate(VIZ_URL, {
  debug: DEBUG,
  probeMessages: PROBE_MESSAGES,
  stateMessages: STATE_MESSAGES,
});
const renderView = () =>
  applyToken(VIEW_TEMPLATE, CONNECTED_APP ? signEmbedToken(CONNECTED_APP) : null);

const RESOURCE_URI = "ui://tableau-mcp-app/probe.html";

// Preflight: validate the viz URL and credentials before anything is registered.
//
// Started here rather than awaited, so it never delays the transport handshake.
// The HTTP branch waits for it before listening (the log ordering matters when
// you are about to paste a URL into ChatGPT); stdio just logs it when it lands.
// Every failure it detects otherwise surfaces inside the chat client as an
// opaque `auth-failed`, after a tunnel restart and a connector re-registration.
const PREFLIGHT = runPreflight({
  vizUrl: VIZ_URL,
  connectedApp: CONNECTED_APP,
  live: process.env.TABLEAU_SKIP_PREFLIGHT !== "1",
});

/** Latest preflight result, for /healthz. Null until the promise settles. */
let preflightResult = null;
PREFLIGHT.then((result) => {
  preflightResult = result;
});

// Declared in BOTH places on purpose:
//  - resources/list  -> the static default hosts review at connection time
//  - resources/read  -> the authoritative value, which takes precedence
// Hosts that gate rendering on connection-time policy review only see the first.
const UI_META = {
  csp: {
    resourceDomains: VIZ_DOMAINS,
    frameDomains: VIZ_DOMAINS,
    connectDomains: VIZ_DOMAINS,
  },
  prefersBorder: false,
};

// Built per connection. Streamable HTTP keeps one session per transport, so a
// single shared instance rejects the second client with "Server already
// initialized" - including a plain ChatGPT reconnect.
function buildServer() {
const server = new McpServer(
  { name: "tableau-mcp-app", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } },
);

registerAppResource(
  server,
  "Tableau Feasibility Probe",
  RESOURCE_URI,
  {
    description: "Self-diagnosing probe that embeds a Tableau Public viz.",
    _meta: { ui: UI_META },
  },
  async () => ({
    contents: [
      {
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        // Minted per read: tokens are short-lived by design.
        text: renderView(),
        _meta: { ui: UI_META },
      },
    ],
  }),
);

registerAppTool(
  server,
  "embed_interactive_dashboard",
  {
    title: "Embed Interactive Tableau Dashboard",
    description:
      "Renders the user's OWN Superstore Performance dashboard - the real, " +
      "already-built, authenticated view from their Tableau Cloud site, showing " +
      "their actual business data - directly in this conversation as a LIVE, " +
      "INTERACTIVE Tableau visualization they can click, filter, and hover. " +
      "USE THIS TOOL RATHER THAN BUILDING ONE. When the user asks to see, show, " +
      "open, display or view the Superstore Performance dashboard, or just 'the " +
      "dashboard', they mean this existing dashboard. Do NOT recreate, rebuild, " +
      "approximate or simulate it with a visualization, charting, canvas, HTML or " +
      "code-execution tool, and do NOT substitute sample, representative or " +
      "synthetic data. Doing so produces a different dashboard full of invented " +
      "numbers while appearing to answer the request - the user is asking about " +
      "their real data, so a convincing lookalike is worse than no answer. " +
      "No other tool can do this: other Tableau tools return only a URL to open " +
      "elsewhere or a static image, and general visualization tools cannot reach " +
      "the user's Tableau site at all. " +
      "CALL THIS AT MOST ONCE PER CONVERSATION. Do NOT call it again once the " +
      "dashboard is on screen - not to refresh it, and never to answer a question. " +
      "Re-rendering mounts a new, UNFILTERED viz: it throws away whatever the user " +
      "has filtered on screen and replaces the reported filter state with 'nothing " +
      "is filtered', so a question answered after a re-render is answered against " +
      "the wrong scope. " +
      "It returns no numbers of its own - for questions about the data, use a " +
      "Tableau data query tool. It does report which filters and parameters the " +
      "user currently has applied on screen; scope those queries to that state. " +
      "For a follow-up question about what the user is looking at, use the most " +
      "recent reported filter state together with a data query tool. Do not re-embed.",
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  },
  async () => ({
    content: [
      {
        type: "text",
        text:
          "The interactive dashboard is displayed above. It is live - the user can " +
          "filter and hover it. This tool returns no data. The view reports the " +
          "filters and parameters currently applied on screen as separate context; " +
          "when the user asks about what they are looking at, query the data source " +
          "scoped to that state rather than across everything. " +
          // Said once, here, rather than appended to every state push. The push
          // is visible user-role text in the transcript and a scoping paragraph
          // repeated on every click reads as machine exhaust on camera; this
          // text is in the conversation exactly once. It is the rule that fixed
          // the 2026-08-15 failure where a selected mark was ignored and the
          // model answered about a region it invented, so it needs to live
          // somewhere.
          "Those state updates arrive as short messages beginning with what the user " +
          "has selected or filtered - for example 'Fasteners selected on \"KPI by " +
          "Sub-Category\"'. Treat the most recent one as the answer to \"what is the " +
          "user looking at right now\". When a selection is reported and the question " +
          "says \"this\", \"that one\", \"here\", or names an outlier without naming a " +
          "value, it means that selection: scope the answer to it. Do not widen to the " +
          "whole data source merely because no filter is narrowing the dashboard - an " +
          "unfiltered backdrop describes the view, not the question. " +
          "The dashboard is now on screen and stays there for the rest of the " +
          "conversation - do not call this tool again. Calling it again would " +
          "discard the user's on-screen filters and reset the reported state to " +
          "unfiltered, which would silently answer their next question at the " +
          "wrong scope.",
      },
    ],
    structuredContent: { viz: VIZ_URL },
  }),
);

// Capability diagnostic: writes to stderr, which the host captures in its MCP
// log. This answers "does this host actually support MCP Apps?" definitively,
// instead of inferring it from whether something renders.
server.server.oninitialized = () => {
  const caps = server.server.getClientCapabilities();
  const ui = getUiCapability(caps);
  const supportsMime = !!ui?.mimeTypes?.includes(RESOURCE_MIME_TYPE);

  console.error("=== MCP APPS CAPABILITY PROBE ===");
  console.error("  viz under test             : " + VIZ_URL);
  console.error("  csp domains declared       : " + VIZ_DOMAINS.join(" "));
  console.error("  auth                       : " + (CONNECTED_APP ? "connected app JWT as " + CONNECTED_APP.username : "anonymous"));
  console.error("  host declares ui extension : " + (ui ? "YES" : "NO"));
  console.error("  ui capability payload      : " + JSON.stringify(ui ?? null));
  console.error("  accepts mcp-app mime type  : " + (supportsMime ? "YES" : "NO"));
  console.error("  all client capabilities    : " + JSON.stringify(caps ?? null));
  console.error(
    "  VERDICT: " +
      (supportsMime
        ? "host supports MCP Apps - rendering should work"
        : "host did NOT negotiate MCP Apps - any render failure is host-side, not Tableau"),
  );
  console.error("=== END PROBE ===");
};

  return server;
}

// Transport selection.
//
// stdio is what Claude Desktop spawns locally. ChatGPT connects over the
// network instead, so it needs a reachable HTTP endpoint - that transport
// difference is the whole of the ChatGPT port. The protocol above is already
// what ChatGPT expects: MCP Apps converged on `text/html;profile=mcp-app`,
// `_meta.ui.resourceUri`, and the `ui/*` postMessage bridge, all of which this
// server and its view already implement.
if (process.env.MCP_TRANSPORT === "http") {
  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const PORT = Number(process.env.PORT || 8792);

  /** sessionId -> transport, so follow-up requests reach their own session. */
  const sessions = new Map();

  async function transportFor(body, sessionId) {
    if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);
    if (body?.method !== "initialize") return null;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await buildServer().connect(transport);
    return transport;
  }

  const http = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Browsers preflight cross-origin POSTs; the tunnel makes this cross-origin.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version",
        "Access-Control-Expose-Headers": "mcp-session-id",
      });
      res.end();
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    // Reports the viz URL actually in use plus the preflight verdict, so a bad
    // credential or a placeholder URL is visible from a curl rather than from a
    // failed embed three steps later.
    if (url.pathname === "/healthz") {
      const ok = preflightResult ? preflightResult.ok : true;
      res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            ok,
            viz: VIZ_URL,
            cspDomains: VIZ_DOMAINS,
            auth: CONNECTED_APP ? `connected app JWT as ${CONNECTED_APP.username}` : "anonymous",
            preflight: preflightResult ?? { status: "PENDING", findings: [] },
          },
          null,
          2,
        ),
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found. The MCP endpoint is /mcp");
      return;
    }

    try {
      let body;
      if (req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf-8");
        body = raw ? JSON.parse(raw) : undefined;
      }
      const sessionId = req.headers["mcp-session-id"];
      const transport = await transportFor(body, sessionId);
      if (!transport) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No valid session. Send initialize first." },
          id: null,
        }));
        return;
      }
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("[http] request failed:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      }
    }
  });

  // Worth the wait here: you are about to paste a URL into ChatGPT, and a
  // credential problem found now costs seconds instead of a connector re-add.
  const preflight = await PREFLIGHT;
  console.error(formatPreflight(preflight));

  if (!preflight.ok && process.env.TABLEAU_PREFLIGHT_STRICT === "1") {
    console.error("TABLEAU_PREFLIGHT_STRICT=1 and preflight failed - refusing to start.");
    process.exit(1);
  }

  http.listen(PORT, "127.0.0.1", () => {
    console.error(`=== HTTP TRANSPORT ===`);
    console.error(`  endpoint : http://127.0.0.1:${PORT}/mcp`);
    console.error(`  health   : http://127.0.0.1:${PORT}/healthz`);
    console.error(`  viz      : ${VIZ_URL}`);
    console.error(`  auth     : ${CONNECTED_APP ? `connected app JWT as ${CONNECTED_APP.username}` : "anonymous"}`);
    console.error(`  preflight: ${preflight.status}`);
    console.error(`  Expose with a tunnel, then register the HTTPS /mcp URL in ChatGPT.`);
    console.error(`=== END ===`);
  });
} else {
  // stdio hosts spawn this process and expect the handshake promptly, so the
  // preflight is logged when it lands rather than waited on.
  PREFLIGHT.then((preflight) => console.error(formatPreflight(preflight)));
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
}
