/**
 * Local reproduction of the MCP Apps sandbox, so the Tableau question can be
 * answered without depending on any host client being installed or working.
 *
 * It serves view.html under:
 *   - the same iframe sandbox attributes the spec mandates
 *     (allow-scripts allow-same-origin)
 *   - a Content-Security-Policy built from the same _meta.ui.csp the server
 *     declares, using the host's documented directive mapping
 *
 * If the viz renders here, the browser-level question is answered yes.
 */
import { createServer } from "node:http";

import { buildViewHtml, cspDomainsFor, DEFAULT_VIZ_URL } from "../src/build-view.js";
import { connectedAppConfig, signEmbedToken } from "../src/connected-app.js";
import { loadEnvFile } from "../src/env.js";

// Defaults to the published Tableau Public viz so the suite runs with no setup.
// Point it at an authenticated Cloud view by setting TABLEAU_VIZ_URL plus the
// Connected App credentials - the same .env the server reads. That is how the
// *actual* payload a live dashboard produces can be inspected as ground truth,
// rather than asking the model what it thinks it received.
loadEnvFile();
const VIZ_URL = process.env.TABLEAU_VIZ_URL || DEFAULT_VIZ_URL;
const CONNECTED_APP = connectedAppConfig();

// Built exactly as the server delivers it, SDK inlined. Serving src/view.html
// raw is what let the missing-handshake bug pass STEP 0.
const VIEW_HTML = buildViewHtml(VIZ_URL, {
  token: CONNECTED_APP ? signEmbedToken(CONNECTED_APP) : null,
});

// The CSP has to follow the viz: a Cloud origin embedded under a CSP that only
// names public.tableau.com is blocked, and the failure looks like the host bug
// this harness exists to rule out.
const TABLEAU = cspDomainsFor(VIZ_URL).join(" ");

// Mirrors the spec's documented mapping of _meta.ui.csp -> CSP directives:
//   resourceDomains -> script-src / style-src / img-src / font-src / media-src
//   frameDomains    -> frame-src
//   connectDomains  -> connect-src
const APP_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${TABLEAU}`,
  `style-src 'unsafe-inline' ${TABLEAU}`,
  `img-src data: blob: ${TABLEAU}`,
  `font-src data: ${TABLEAU}`,
  `media-src ${TABLEAU}`,
  `connect-src ${TABLEAU}`,
  `frame-src ${TABLEAU}`,
  "base-uri 'none'",
].join("; ");

// Minimal host implementation. The iframe deliberately starts at height 0 and
// only grows when the view reports its size, which is how a real host behaves.
// A view that never completes the handshake therefore stays invisible here too,
// instead of being silently rescued by a hard-coded height:100%.
const PARENT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>MCP Apps sandbox harness</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:0;display:block}</style>
</head><body>
<iframe id="sandbox" sandbox="allow-scripts allow-same-origin" src="/app"></iframe>
<script>
  // Observable by the test runner, so a blank frame can be attributed.
  window.__host = {
    initialized: false,
    sizeReports: 0,
    lastHeight: 0,
    methods: [],
    // Every ui/update-model-context payload, in order. The runner asserts on
    // these: the model context push is invisible on screen, so without a record
    // here a silently-broken push looks identical to a working one.
    contextUpdates: [],
    // Every ui/message payload, in order. Recorded for the same reason and one
    // stronger: as of 2026-08-15 this is the channel that actually reaches the
    // model in ChatGPT, so asserting only on contextUpdates would be checking
    // the copy of the payload the model never sees.
    messages: [],
  };

  const frame = document.getElementById("sandbox");

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0" || !msg.method) return;
    window.__host.methods.push(msg.method);

    if (msg.method === "ui/initialize") {
      event.source.postMessage(
        {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "sandbox-harness", version: "1.0.0" },
            // Reports back the domains it approved, as a real host does. These
            // match the CSP header actually served, so the view's on-screen
            // report and the enforced policy cannot silently disagree.
            hostCapabilities: {
              resources: {
                csp: {
                  resourceDomains: ${JSON.stringify(TABLEAU.split(" "))},
                  frameDomains: ${JSON.stringify(TABLEAU.split(" "))},
                  connectDomains: ${JSON.stringify(TABLEAU.split(" "))},
                },
              },
              message: {},
              // Matches what ChatGPT advertises. The view checks this before
              // pushing filter state and stays quiet if it is absent, so a
              // harness that omitted it would test the wrong branch.
              updateModelContext: { text: {}, structuredContent: {} },
            },
            hostContext: {},
          },
        },
        "*"
      );
      return;
    }

    if (msg.method === "ui/notifications/initialized") {
      window.__host.initialized = true;
      return;
    }

    // A request, not a notification: the SDK awaits the reply and rejects on
    // timeout, so ignoring it would fail the view rather than merely drop data.
    if (msg.method === "ui/update-model-context") {
      window.__host.contextUpdates.push(msg.params || {});
      event.source.postMessage({ jsonrpc: "2.0", id: msg.id, result: {} }, "*");
      return;
    }

    // Also a request. Leaving it unanswered - which this harness did until
    // 2026-08-16 - makes the view's sendMessage reject on timeout, so the
    // delivery path the demo depends on was never actually exercised here
    // despite a panel row claiming it was.
    if (msg.method === "ui/message") {
      window.__host.messages.push(msg.params || {});
      event.source.postMessage({ jsonrpc: "2.0", id: msg.id, result: {} }, "*");
      return;
    }

    if (msg.method === "ui/notifications/size-changed") {
      const h = Math.ceil(msg.params?.height ?? 0);
      window.__host.sizeReports++;
      window.__host.lastHeight = h;
      frame.style.height = h + "px";
    }
  });
</script>
</body></html>`;

export function startHarness(port = 8791) {
  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/app") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": APP_CSP,
      });
      res.end(VIEW_HTML);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PARENT_HTML);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port, csp: APP_CSP }));
  });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const { port, csp } = await startHarness();
  console.log(`harness on http://127.0.0.1:${port}`);
  console.log(`CSP applied to /app:\n  ${csp.replace(/; /g, "\n  ")}`);
}
