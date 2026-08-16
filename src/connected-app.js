/**
 * Tableau Connected App (Direct Trust) JWT signing.
 *
 * Embedding an authenticated Tableau Cloud view requires a short-lived JWT
 * signed with a Connected App secret. This is what "EAS" refers to in other
 * implementations - though Direct Trust, used here, needs no external
 * authorization server.
 *
 * HS256 via node:crypto, so no new dependency. Credentials come from the
 * environment and are never written to disk or logged.
 */
import { createHmac, randomUUID } from "node:crypto";

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Tokens are minted per view render, so they only need to outlive the load. */
const LIFETIME_SECONDS = 600;

/**
 * Reads Connected App credentials from the environment.
 * Returns null when unconfigured, which is the signal to embed anonymously
 * (Tableau Public) rather than to fail.
 */
export function connectedAppConfig(env = process.env) {
  const clientId = env.TABLEAU_CONNECTED_APP_CLIENT_ID;
  const secretId = env.TABLEAU_CONNECTED_APP_SECRET_ID;
  const secretValue = env.TABLEAU_CONNECTED_APP_SECRET_VALUE;
  const username = env.TABLEAU_EMBED_USER;

  if (!clientId && !secretId && !secretValue && !username) return null;

  // A partial configuration is always a mistake worth failing loudly on: the
  // symptom otherwise is an opaque Tableau login prompt inside the iframe.
  const missing = Object.entries({
    TABLEAU_CONNECTED_APP_CLIENT_ID: clientId,
    TABLEAU_CONNECTED_APP_SECRET_ID: secretId,
    TABLEAU_CONNECTED_APP_SECRET_VALUE: secretValue,
    TABLEAU_EMBED_USER: username,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    throw new Error(
      `Connected App is partially configured. Missing: ${missing.join(", ")}. ` +
        "Set all four, or none to embed anonymously. " +
        // Named because a bare `KEY=` in .env is the usual cause, and the env
        // loader's own summary lists such keys as PRESENT BUT EMPTY - which is
        // easy to read as "loaded" at a glance.
        "If these are in .env, check none of them is an empty `KEY=` line.",
    );
  }
  return { clientId, secretId, secretValue, username };
}

/** Scopes an embed token needs. Anything less and the iframe shows a login prompt. */
export const EMBED_SCOPES = ["tableau:views:embed", "tableau:views:embed_authoring"];

/**
 * Mints a Connected App JWT.
 *
 * `scp` must include `tableau:views:embed` for embedding; without it Tableau
 * rejects the token and the iframe falls back to a login prompt. The scopes are
 * overridable because the boot preflight mints a REST-scoped token instead - it
 * needs a token Tableau will actually *evaluate* server-side, which an
 * embed-only token is not.
 */
export function signEmbedToken(config, { now = Date.now(), scopes = EMBED_SCOPES } = {}) {
  const issuedAt = Math.floor(now / 1000);

  const header = {
    alg: "HS256",
    typ: "JWT",
    kid: config.secretId,
    iss: config.clientId,
  };

  const payload = {
    iss: config.clientId,
    sub: config.username,
    aud: "tableau",
    jti: randomUUID(),
    iat: issuedAt,
    exp: issuedAt + LIFETIME_SECONDS,
    scp: scopes,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", config.secretValue)
    .update(signingInput)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${signingInput}.${signature}`;
}
