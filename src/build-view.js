/**
 * Builds the view HTML that is delivered to the host.
 *
 * Shared by the server and the test harness on purpose: the harness is only a
 * meaningful regression check if it serves byte-identical HTML to what a real
 * host receives. Reading view.html directly is what let the zero-height bug
 * pass STEP 0 undetected.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLACEHOLDER = "/*__MCP_APPS_SDK__*/";
const VIZ_URL_PLACEHOLDER = "__VIZ_URL__";
const DEBUG_PLACEHOLDER = "__EMBED_DEBUG__";
const PROBE_MESSAGES_PLACEHOLDER = "__EMBED_PROBE_MESSAGES__";
// Third switch, and it exists because the second one was doing two jobs.
// State-by-message and probe-JSON-by-message are both sendMessage traffic, but
// one is the product working and the other is diagnostic noise - a 2026-08-15
// run shipped a wall of probe JSON into the transcript purely to get the state
// there. On by default: as of that date updateModelContext delivers nothing in
// ChatGPT, so this is the only channel that reaches the model.
const STATE_MESSAGES_PLACEHOLDER = "__EMBED_STATE_MESSAGES__";
const TOKEN_ATTR_PLACEHOLDER = "__VIZ_TOKEN_ATTR__";

/** The viz this app renders when nothing overrides it. */
export const DEFAULT_VIZ_URL =
  "https://public.tableau.com/views/WOW2026W31MCPApps-ReadyDashboard/SuperstorePerformance";

/**
 * CSP domains a viz URL requires: its exact origin, plus a wildcard for the
 * parent domain. Tableau serves the embedding assets and the nested viz frame
 * from sibling hosts, so the exact origin alone is not enough.
 */
export function cspDomainsFor(vizUrl) {
  const u = new URL(vizUrl);
  const labels = u.hostname.split(".");
  const domains = [u.origin];
  if (labels.length > 2) {
    domains.push(`${u.protocol}//*.${labels.slice(1).join(".")}`);
  }
  return domains;
}

/**
 * Inline the MCP Apps client SDK into the view.
 *
 * The view travels to the host as a bare HTML string under a CSP whose
 * script-src allows only inline script and tableau.com. There is no origin to
 * serve the SDK from, so the bundle has to ride inside the document.
 *
 * `app-with-deps.js` is an ES module ending in a single `export{...}`
 * statement. Nothing can import it once inlined, so that statement is rewritten
 * into a global assignment. Both the placeholder and the export statement are
 * asserted: a silent failure here reproduces exactly the blank-widget symptom
 * this code exists to fix.
 */
export function buildViewTemplate(
  vizUrl = DEFAULT_VIZ_URL,
  { debug = false, probeMessages = false, stateMessages = true } = {},
) {
  const html = readFileSync(join(__dirname, "view.html"), "utf-8");
  const sdkPath = fileURLToPath(
    import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps"),
  );
  const bundle = readFileSync(sdkPath, "utf-8");

  const start = bundle.lastIndexOf("export{");
  const end = bundle.indexOf("};", start);
  if (start === -1 || end === -1) {
    throw new Error("ext-apps bundle: expected a trailing export{...}; statement");
  }

  const props = bundle
    .slice(start + "export{".length, end)
    .split(",")
    .map((entry) => {
      const [local, exported] = entry.split(" as ").map((s) => s.trim());
      return `${JSON.stringify(exported ?? local)}:${local}`;
    })
    .join(",");

  const globalized =
    bundle.slice(0, start) + `globalThis.__MCP_APPS_SDK__={${props}};`;

  if (!html.includes(PLACEHOLDER)) {
    throw new Error(`view.html: missing ${PLACEHOLDER} injection point`);
  }
  if (!html.includes(VIZ_URL_PLACEHOLDER)) {
    throw new Error(`view.html: missing ${VIZ_URL_PLACEHOLDER} injection point`);
  }
  if (!html.includes(DEBUG_PLACEHOLDER)) {
    throw new Error(`view.html: missing ${DEBUG_PLACEHOLDER} injection point`);
  }
  if (!html.includes(PROBE_MESSAGES_PLACEHOLDER)) {
    throw new Error(`view.html: missing ${PROBE_MESSAGES_PLACEHOLDER} injection point`);
  }
  if (!html.includes(STATE_MESSAGES_PLACEHOLDER)) {
    throw new Error(`view.html: missing ${STATE_MESSAGES_PLACEHOLDER} injection point`);
  }
  return (
    html
      .replace(PLACEHOLDER, () => globalized)
      .split(VIZ_URL_PLACEHOLDER)
      .join(vizUrl)
      // Order matters: __EMBED_DEBUG__ is a prefix of nothing, but
      // __EMBED_PROBE_MESSAGES__ must be substituted before a looser match
      // could ever clip it. Substituting the longer token first is the safe
      // habit even where the current names happen not to collide.
      .split(STATE_MESSAGES_PLACEHOLDER)
      .join(stateMessages ? "true" : "false")
      .split(PROBE_MESSAGES_PLACEHOLDER)
      .join(probeMessages ? "true" : "false")
      .split(DEBUG_PLACEHOLDER)
      .join(debug ? "true" : "false")
  );
}

/**
 * Substitutes the embed token into a built template.
 *
 * Split from the build so the 330KB SDK inlining happens once at startup while
 * a fresh, short-lived token can still be minted per render. The attribute is
 * omitted entirely when there is no token - an empty `token=""` makes the
 * Embedding API attempt authenticated embedding and fail.
 */
export function applyToken(html, token) {
  return html.split(TOKEN_ATTR_PLACEHOLDER).join(token ? `token="${token}"` : "");
}

/** Convenience wrapper: build and substitute in one step. */
export function buildViewHtml(
  vizUrl = DEFAULT_VIZ_URL,
  { debug = false, probeMessages = false, stateMessages = true, token = null } = {},
) {
  return applyToken(
    buildViewTemplate(vizUrl, { debug, probeMessages, stateMessages }),
    token,
  );
}
