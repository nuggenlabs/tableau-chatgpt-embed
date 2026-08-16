/**
 * Boot-time preflight for the viz URL and Connected App credentials.
 *
 * Why this exists: every credential and URL problem this project has hit
 * surfaced at *embed* time, inside ChatGPT, as an opaque `auth-failed` - after a
 * tunnel restart and a connector re-registration. On 2026-08-10 a stale
 * Connected App secret cost the longest detour of the session, and everything
 * checkable by hand looked correct while it did. A second failure the same night
 * was a template placeholder pasted verbatim into TABLEAU_VIZ_URL, which signs a
 * perfectly valid JWT and then 404s inside the frame, reading like an auth
 * failure.
 *
 * So: check what is checkable before a single round trip is spent, and name the
 * failing thing.
 *
 * Deliberately three-state. A live check against Tableau can come back PASS,
 * FAIL, or INCONCLUSIVE, and conflating the last two would be worse than having
 * no preflight at all - a false "your secret is bad" would send you regenerating
 * credentials that were fine. Only a definitive signature rejection is reported
 * as a credential failure; anything unrecognised is reported verbatim as
 * inconclusive.
 */
import { signEmbedToken } from "./connected-app.js";

/** Tableau Cloud 2026.2.5 speaks REST 3.29. Overridable for other deployments. */
const REST_API_VERSION = process.env.TABLEAU_REST_API_VERSION || "3.29";

/** A boot check must never become the reason the server is slow to start. */
const LIVE_CHECK_TIMEOUT_MS = Number(process.env.TABLEAU_PREFLIGHT_TIMEOUT_MS || 8000);

/**
 * JWT `iat`/`exp` are absolute, so a skewed local clock invalidates every token
 * this server mints. Tableau's own tolerance is not documented; 60s is well
 * inside anything plausible and still catches a genuinely wrong clock.
 */
const MAX_CLOCK_SKEW_SECONDS = 60;

const PASS = "PASS";
const FAIL = "FAIL";
const WARN = "WARN";
const INCONCLUSIVE = "INCONCLUSIVE";
const SKIPPED = "SKIPPED";

/**
 * Tableau error codes seen or documented on this project.
 *
 * Only 10090 is documented; 10084 is the standard signature-verification code.
 * 10085 was observed on 2026-08-10 and its exact meaning was never pinned down -
 * regenerating the secret fixed it empirically. It is listed here with that
 * caveat intact rather than given a confident definition it has not earned.
 */
const TABLEAU_ERROR_ADVICE = {
  10084: {
    status: FAIL,
    advice:
      "Tableau could not verify the token signature. TABLEAU_CONNECTED_APP_SECRET_VALUE " +
      "does not match the secret behind TABLEAU_CONNECTED_APP_SECRET_ID.",
  },
  10085: {
    status: FAIL,
    advice:
      "Seen on 2026-08-10 with a configuration that had rendered fine four hours earlier; " +
      "regenerating the Connected App secret fixed it. Exact meaning is not pinned down. " +
      "Create a new secret on the existing app (an app can hold several, so the old one " +
      "stays as a free rollback) and update TABLEAU_CONNECTED_APP_SECRET_ID and _VALUE.",
  },
  10090: {
    status: FAIL,
    advice:
      "The Connected App is disabled. Enable it in Tableau Cloud under Settings -> " +
      "Connected Apps. `apps/tableau-cloud-provisioner --list` reports enabled state " +
      "and project scope.",
  },
};

const finding = (status, label, detail) => ({ status, label, detail });

/** Angle brackets survive from every doc template on this project. */
const looksUnsubstituted = (value) => /[<>]/.test(String(value ?? ""));

/**
 * Static checks on the viz URL. No network, so these always run - including for
 * anonymous Tableau Public embeds, where a malformed URL is just as fatal.
 */
export function checkVizUrl(vizUrl) {
  const findings = [];

  if (looksUnsubstituted(vizUrl)) {
    findings.push(
      finding(
        FAIL,
        "viz url contains an unsubstituted placeholder",
        `${vizUrl} - this signs a valid JWT and then 404s inside the frame, which reads ` +
          "like an auth failure. Replace the <...> segments.",
      ),
    );
    return findings;
  }

  let url;
  try {
    url = new URL(vizUrl);
  } catch {
    findings.push(finding(FAIL, "viz url is not a valid URL", String(vizUrl)));
    return findings;
  }

  // Tableau Cloud's address bar shows the /#/site/ form, which does not embed.
  if (url.hash.includes("/site/") || url.pathname.includes("/#/site/")) {
    const site = (vizUrl.match(/\/#\/site\/([^/]+)\//) || [])[1];
    findings.push(
      finding(
        FAIL,
        "viz url is the address-bar form, not the embed form",
        "Tableau Cloud shows /#/site/<site>/views/...; embedding needs " +
          `/t/${site || "<site>"}/views/... Copy the path, not the URL bar.`,
      ),
    );
  } else if (!url.pathname.includes("/views/")) {
    findings.push(
      finding(
        WARN,
        "viz url has no /views/ segment",
        `${url.pathname} - expected .../views/<workbook>/<view>.`,
      ),
    );
  }

  if (findings.length === 0) {
    findings.push(finding(PASS, "viz url is well formed", vizUrl));
  }
  return findings;
}

/**
 * Static checks on the credentials themselves.
 *
 * `connectedAppConfig()` already rejects a *partial* configuration. What it
 * cannot catch is a complete one made of template text, which is exactly what a
 * copy-paste from the README produces.
 */
export function checkCredentialShape(config) {
  if (!config) {
    return [
      finding(
        SKIPPED,
        "connected app not configured - embedding anonymously",
        "Tableau Public. Set all five TABLEAU_* vars for an authenticated Cloud embed.",
      ),
    ];
  }

  const findings = [];
  const placeholders = Object.entries({
    TABLEAU_CONNECTED_APP_CLIENT_ID: config.clientId,
    TABLEAU_CONNECTED_APP_SECRET_ID: config.secretId,
    TABLEAU_CONNECTED_APP_SECRET_VALUE: config.secretValue,
    TABLEAU_EMBED_USER: config.username,
  })
    .filter(([, value]) => looksUnsubstituted(value))
    .map(([name]) => name);

  if (placeholders.length) {
    findings.push(
      finding(
        FAIL,
        "credentials contain unsubstituted placeholders",
        `${placeholders.join(", ")} still look like template text.`,
      ),
    );
  }

  // The clientId is the JWT `iss` and Tableau matches it exactly. A UUID is the
  // observed shape; anything else is worth a look but is not proof of a problem.
  if (!looksUnsubstituted(config.clientId) && !/^[0-9a-f-]{36}$/i.test(config.clientId)) {
    findings.push(
      finding(
        WARN,
        "client id is not a UUID",
        `${config.clientId} - Connected App client IDs are UUIDs. Tableau matches the ` +
          "JWT iss against it exactly.",
      ),
    );
  }

  if (findings.length === 0) {
    findings.push(finding(PASS, "credentials are fully substituted", `embedding as ${config.username}`));
  }
  return findings;
}

/**
 * Compares the local clock against Tableau's, using the `Date` header on the
 * response we are already making. Free, and it removes a manual check that was
 * done by hand during the 2026-08-10 debugging session.
 */
function checkClockSkew(dateHeader, now) {
  if (!dateHeader) return null;
  const serverTime = Date.parse(dateHeader);
  if (Number.isNaN(serverTime)) return null;

  const skewSeconds = Math.round((now - serverTime) / 1000);
  if (Math.abs(skewSeconds) <= MAX_CLOCK_SKEW_SECONDS) {
    return finding(PASS, "clock agrees with Tableau", `${skewSeconds}s skew`);
  }
  return finding(
    FAIL,
    "local clock is out of sync with Tableau",
    `${skewSeconds}s skew. JWT iat/exp are absolute, so every token this server ` +
      "mints will be rejected until the clock is corrected.",
  );
}

/**
 * The one check that actually exercises the secret: ask Tableau to evaluate a
 * token signed with it.
 *
 * A REST-scoped token is minted rather than the embed token, because there is no
 * endpoint that will evaluate an embed-only token server-side - an embed token is
 * only ever judged inside the iframe, which is the failure mode this preflight
 * exists to get ahead of.
 *
 * The tradeoff, stated plainly: a Connected App may legitimately not be
 * authorised for REST access, in which case a good secret still fails to sign in.
 * That is why anything other than a recognised signature/enablement error comes
 * back INCONCLUSIVE rather than FAIL.
 */
export async function validateCredentialsLive(
  config,
  vizUrl,
  { fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = LIVE_CHECK_TIMEOUT_MS } = {},
) {
  let origin;
  let site;
  try {
    const url = new URL(vizUrl);
    origin = url.origin;
    // /t/<site>/views/... on Cloud; Public has no site segment.
    site = (url.pathname.match(/\/t\/([^/]+)\//) || [])[1] || "";
  } catch {
    return finding(SKIPPED, "live credential check skipped", "viz url is unusable");
  }

  const token = signEmbedToken(config, { now, scopes: ["tableau:content:read"] });

  let response;
  let body = "";
  try {
    response = await fetchImpl(`${origin}/api/${REST_API_VERSION}/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ credentials: { jwt: token, site: { contentUrl: site } } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await response.text();
  } catch (err) {
    return finding(
      INCONCLUSIVE,
      "live credential check could not reach Tableau",
      `${String(err?.message ?? err)} - network or timeout, not a verdict on the credentials.`,
    );
  }

  const skew = checkClockSkew(response.headers.get("date"), now);

  if (response.ok) {
    return {
      ...finding(
        PASS,
        "Tableau accepted a token signed with this secret",
        `REST signin succeeded against ${origin}${site ? ` site ${site}` : ""}.`,
      ),
      skew,
    };
  }

  // Tableau returns <error code="10084" ...> in XML, or JSON with the same code.
  const code = Number((body.match(/code="(\d+)"/) || body.match(/"code"\s*:\s*"?(\d+)"?/) || [])[1]);
  const known = TABLEAU_ERROR_ADVICE[code];

  if (known) {
    return { ...finding(known.status, `Tableau rejected the token (error ${code})`, known.advice), skew };
  }

  return {
    ...finding(
      INCONCLUSIVE,
      `Tableau declined the REST signin (HTTP ${response.status}${code ? `, error ${code}` : ""})`,
      "This may simply mean the Connected App is not authorised for REST API access, " +
        "which does not affect embedding. Treat as unproven, not as a credential failure. " +
        `Response: ${body.slice(0, 300).replace(/\s+/g, " ").trim()}`,
    ),
    skew,
  };
}

/**
 * Runs every check and returns a structured result.
 *
 * Never throws: a preflight that can break startup is a worse liability than the
 * failures it detects.
 */
export async function runPreflight({
  vizUrl,
  connectedApp,
  live = true,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  const findings = [...checkVizUrl(vizUrl), ...checkCredentialShape(connectedApp)];

  const shapeIsSound = !findings.some((f) => f.status === FAIL);

  if (connectedApp && live && shapeIsSound) {
    try {
      const result = await validateCredentialsLive(connectedApp, vizUrl, { fetchImpl, now });
      if (result.skew) findings.push(result.skew);
      findings.push(finding(result.status, result.label, result.detail));
    } catch (err) {
      findings.push(
        finding(INCONCLUSIVE, "live credential check threw", String(err?.message ?? err)),
      );
    }
  } else if (connectedApp && live && !shapeIsSound) {
    findings.push(
      finding(SKIPPED, "live credential check skipped", "static checks failed first - fix those."),
    );
  } else if (connectedApp && !live) {
    // Say so rather than staying silent: an absent line reads as "the secret was
    // checked and was fine", which is the opposite of what happened.
    findings.push(
      finding(
        SKIPPED,
        "live credential check disabled",
        "TABLEAU_SKIP_PREFLIGHT=1 - the secret itself is unverified.",
      ),
    );
  }

  const failures = findings.filter((f) => f.status === FAIL);
  return {
    ok: failures.length === 0,
    status: failures.length ? FAIL : findings.some((f) => f.status === WARN) ? WARN : PASS,
    findings,
    failures,
  };
}

/** Renders a preflight result for stderr, which is where hosts capture logs. */
export function formatPreflight(result) {
  const lines = ["=== PREFLIGHT ==="];
  for (const f of result.findings) {
    lines.push(`  [${f.status.padEnd(12)}] ${f.label}`);
    if (f.detail) lines.push(`                 ${f.detail}`);
  }
  lines.push(
    result.ok
      ? "  VERDICT: nothing blocking found."
      : "  VERDICT: " +
          `${result.failures.length} blocking problem(s) above. Fix before registering ` +
          "the connector - these all surface inside ChatGPT as an opaque auth-failed.",
  );
  lines.push("=== END PREFLIGHT ===");
  return lines.join("\n");
}

export const PREFLIGHT_STATUS = { PASS, FAIL, WARN, INCONCLUSIVE, SKIPPED };
