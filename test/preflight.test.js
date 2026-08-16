/**
 * Preflight unit tests.
 *
 * The live credential check is driven with a stub fetch rather than a real
 * Tableau call: the failures worth covering (a stale secret, a disabled app, an
 * unreachable host) are exactly the ones that cannot be produced on demand
 * against a working site.
 *
 * The distinction these tests exist to protect is FAIL vs INCONCLUSIVE. A
 * preflight that reports "your secret is bad" when Tableau merely declined a
 * REST scope would send you regenerating credentials that were fine, which is a
 * worse outcome than not checking at all.
 */
import {
  checkCredentialShape,
  checkVizUrl,
  PREFLIGHT_STATUS as S,
  runPreflight,
} from "../src/preflight.js";

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? " -> " + detail : ""}`);
  if (!cond) failures++;
};

const statuses = (findings) => findings.map((f) => f.status);
const has = (findings, status) => findings.some((f) => f.status === status);

const GOOD_CONFIG = {
  clientId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
  secretId: "845c3414-24f8-4dec-a14b-c490648cc1d1",
  secretValue: "not-a-real-secret",
  username: "someone@example.com",
};

const CLOUD_VIZ = "https://us-east-1.online.tableau.com/t/mysite/views/Workbook/View";

const stubFetch = (status, body, headers = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => body,
});

console.log("=== viz url ===");

check("well-formed cloud url passes", has(checkVizUrl(CLOUD_VIZ), S.PASS));

check(
  "unsubstituted placeholder fails",
  has(checkVizUrl("https://us-east-1.online.tableau.com/t/site/views/<workbook>/<view>"), S.FAIL),
  "the literal template that 404'd inside the frame on 2026-08-10",
);

check(
  "address-bar form fails",
  has(checkVizUrl("https://us-east-1.online.tableau.com/#/site/mysite/views/WB/V"), S.FAIL),
  "Cloud shows /#/site/; embedding needs /t/",
);

check("garbage url fails", has(checkVizUrl("not a url"), S.FAIL));

check(
  "public tableau url passes",
  has(checkVizUrl("https://public.tableau.com/views/WB/Sheet1"), S.PASS),
);

console.log("=== credential shape ===");

check("no config is skipped, not failed", has(checkCredentialShape(null), S.SKIPPED));

check("good config passes", has(checkCredentialShape(GOOD_CONFIG), S.PASS));

check(
  "placeholder secret fails",
  has(checkCredentialShape({ ...GOOD_CONFIG, secretValue: "<your-secret-value>" }), S.FAIL),
);

check(
  "non-uuid client id warns but does not fail",
  (() => {
    const f = checkCredentialShape({ ...GOOD_CONFIG, clientId: "my-app" });
    return has(f, S.WARN) && !has(f, S.FAIL);
  })(),
);

console.log("=== live credential check ===");

const live = async (label, fetchImpl, expect, detail) => {
  const result = await runPreflight({
    vizUrl: CLOUD_VIZ,
    connectedApp: GOOD_CONFIG,
    fetchImpl,
    now: Date.parse("2026-08-14T12:00:00Z"),
  });
  check(label, has(result.findings, expect), detail || statuses(result.findings).join(","));
  return result;
};

await live(
  "successful signin passes",
  stubFetch(200, '{"credentials":{"token":"x"}}', { date: "Fri, 14 Aug 2026 12:00:00 GMT" }),
  S.PASS,
);

await live(
  "error 10084 is a credential failure",
  stubFetch(401, '<error code="10084"><summary>Signature verification failed</summary></error>'),
  S.FAIL,
  "signature verification failed",
);

await live(
  "error 10090 is a credential failure",
  stubFetch(401, '<error code="10090"><summary>Connected app disabled</summary></error>'),
  S.FAIL,
  "disabled connected app",
);

await live(
  "error 10085 is a credential failure",
  stubFetch(401, '<error code="10085"><summary>unknown</summary></error>'),
  S.FAIL,
  "the 2026-08-10 stale-secret signature",
);

await live(
  "an unrecognised rejection is INCONCLUSIVE, not FAIL",
  stubFetch(403, '<error code="10077"><summary>Scope not permitted</summary></error>'),
  S.INCONCLUSIVE,
  "a connected app may legitimately lack REST scope",
);

await live(
  "a network error is INCONCLUSIVE, not FAIL",
  async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  },
  S.INCONCLUSIVE,
);

console.log("=== clock skew ===");

const skewed = await runPreflight({
  vizUrl: CLOUD_VIZ,
  connectedApp: GOOD_CONFIG,
  fetchImpl: stubFetch(200, "{}", { date: "Fri, 14 Aug 2026 11:30:00 GMT" }),
  now: Date.parse("2026-08-14T12:00:00Z"),
});
check(
  "a 30-minute clock skew fails",
  has(skewed.findings, S.FAIL),
  "JWT iat/exp are absolute, so every minted token would be rejected",
);

console.log("=== gating ===");

const badShape = await runPreflight({
  vizUrl: "https://us-east-1.online.tableau.com/t/s/views/<wb>/<v>",
  connectedApp: GOOD_CONFIG,
  fetchImpl: async () => {
    throw new Error("live check should not have run");
  },
});
check(
  "a failing static check skips the live call",
  !badShape.ok && has(badShape.findings, S.SKIPPED),
  "no point asking Tableau about a URL we already know is wrong",
);

const disabled = await runPreflight({
  vizUrl: CLOUD_VIZ,
  connectedApp: GOOD_CONFIG,
  live: false,
  fetchImpl: async () => {
    throw new Error("live check should not have run");
  },
});
check(
  "a disabled live check says so rather than staying silent",
  disabled.ok && disabled.findings.some((f) => f.status === S.SKIPPED && /disabled/.test(f.label)),
  "an absent line would read as 'checked and fine'",
);

const anonymous = await runPreflight({
  vizUrl: "https://public.tableau.com/views/WB/Sheet1",
  connectedApp: null,
  fetchImpl: async () => {
    throw new Error("live check should not have run");
  },
});
check("anonymous embed makes no network call and passes", anonymous.ok);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
