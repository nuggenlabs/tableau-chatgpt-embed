/**
 * STEP 0 verdict runner.
 *
 * Drives the sandbox harness headlessly and reports which layer, if any, fails:
 *   1. Embedding API script fetch      (CSP script-src)
 *   2. <tableau-viz> registration      (script executed)
 *   3. nested iframe creation          (CSP frame-src)
 *   4. viz actually paints             (Tableau X-Frame-Options / bootstrap)
 *
 * Exit code 0 = feasible, 1 = not feasible.
 */
import puppeteer from "puppeteer";
import { startHarness } from "./sandbox-harness.js";

const TIMEOUT_MS = 75_000;

const { server, port, csp } = await startHarness(8791);
console.log("CSP under test:");
console.log("  " + csp.replace(/; /g, "\n  "));
console.log("");

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1100 });

const cspViolations = [];
const netFailures = [];
const frameUrls = [];

page.on("console", (m) => {
  const t = m.text();
  if (/Content Security Policy|Refused to/i.test(t)) cspViolations.push(t);
});
page.on("requestfailed", (r) => {
  netFailures.push(`${r.failure()?.errorText}  ${r.url().slice(0, 130)}`);
});
page.on("frameattached", (f) => frameUrls.push(f.url()));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });

// The probe writes its verdict into #verdict inside the sandboxed iframe.
let verdict = "(never reported)";
let marks = {};
const started = Date.now();

while (Date.now() - started < TIMEOUT_MS) {
  const frame = page.frames().find((f) => f.url().includes("/app"));
  if (frame) {
    try {
      const state = await frame.evaluate(() => ({
        verdict: document.getElementById("verdict")?.textContent || "",
        cls: document.getElementById("verdict")?.className || "",
        rows: Array.from(document.querySelectorAll("#log .row")).map((r) => ({
          k: r.querySelector(".k")?.textContent,
          v: r.querySelector(".v")?.textContent,
        })),
        frames: document.querySelectorAll("iframe").length,
      }));
      marks = state;
      verdict = state.verdict;
      if (state.cls === "ok" || state.cls === "bad") break;
    } catch {
      /* frame navigating; retry */
    }
  }
  await new Promise((r) => setTimeout(r, 750));
}

// The first model-context push is issued after firstinteractive, which is what
// broke the verdict loop above, and it has to read filters out of the viz
// first. So it is always still in flight at this point - wait for it rather
// than sampling too early and calling a working push broken.
const CONTEXT_TIMEOUT_MS = 25_000;
const contextStarted = Date.now();
while (Date.now() - contextStarted < CONTEXT_TIMEOUT_MS) {
  const n = await page.evaluate(() => window.__host.contextUpdates.length);
  if (n > 0) break;
  await new Promise((r) => setTimeout(r, 500));
}

// Mark selection: clicking a mark is how a user says "this one" about an
// outlier. A real click is unreachable here - the marks live inside the same
// cross-origin frame that blocks the filter controls - but the Embedding API
// can select marks *programmatically*, which fires the same event and exercises
// the whole path: listener -> read -> render -> push. That is a much stronger
// check than asserting the listener was attached.
//
// Best-effort by design: it depends on the viz exposing a selectable field, so
// a failure to drive it is reported rather than failing the run. What IS
// asserted below is that the listener was wired at all.
const markProbe = { attempted: false, selected: 0, note: "" };
try {
  const appFrame = page.frames().find((f) => f.url().includes("/app"));
  const outcome = await appFrame.evaluate(async () => {
    const viz = await window.__vizReady;
    const sheet = viz.workbook.activeSheet;
    const worksheets = Array.isArray(sheet.worksheets) ? sheet.worksheets : [sheet];
    // Collected rather than swallowed: "no worksheet accepted a selection" with
    // no reason is a dead end for whoever reads this output next.
    const failures = [];

    // SelectionUpdateType.Replace is "select-replace" - NOT "replace", which is
    // what the Extensions API and FilterUpdateType use. Read out of the
    // embedding bundle after both obvious guesses were rejected with
    // `invalid value for enum: SelectionUpdateType`. The fallbacks stay in case
    // a future bundle changes it again.
    const updateTypes = [
      globalThis.SelectionUpdateType?.Replace,
      globalThis.tableau?.SelectionUpdateType?.Replace,
      "select-replace",
      "Replace",
      "replace",
    ].filter(Boolean);

    /** Aggregated measures rarely match a mark by value; dimensions do. */
    const isAggregate = (name) => /^(SUM|AVG|MIN|MAX|CNT|CNTD|AGG|MEDIAN|ATTR|STDEV|VAR)\(/i.test(name || "");

    const countSelected = async (ws) => {
      const collection = await ws.getSelectedMarksAsync();
      return (collection?.data || []).reduce((n, t) => n + (t.data || []).length, 0);
    };

    for (const ws of worksheets) {
      try {
        // Take real field/value pairs off the sheet rather than guessing, so
        // this keeps working if the published dashboard changes.
        const table = await ws.getSummaryDataAsync({ maxRows: 1 });
        const row = (table.data || [])[0];
        const columns = [...(table.columns || [])].sort(
          (a, b) => Number(isAggregate(a.fieldName)) - Number(isAggregate(b.fieldName)),
        );
        if (!columns.length || !row) {
          failures.push(`${ws.name}: summary data had no rows/columns`);
          continue;
        }

        for (const column of columns) {
          const cell = row[column.index != null ? column.index : 0];
          if (!cell) continue;

          let accepted = false;
          for (const updateType of updateTypes) {
            try {
              await ws.selectMarksByValueAsync(
                [{ fieldName: column.fieldName, value: [cell.value] }],
                updateType,
              );
              accepted = true;
              break;
            } catch (e) {
              if (!/invalid value for enum/i.test(e?.message ?? "")) throw e;
            }
          }
          if (!accepted) {
            failures.push(`${ws.name}: no accepted SelectionUpdateType value`);
            break; // enum problem is sheet-independent
          }

          // The call succeeding is not the same as marks being selected - a
          // measure value often matches nothing. Confirm before declaring it
          // exercised, or the probe reports success while testing nothing.
          const count = await countSelected(ws);
          if (count > 0) {
            return { ok: true, sheet: ws.name, field: column.fieldName, count };
          }
        }
        failures.push(`${ws.name}: selection accepted but matched 0 marks`);
      } catch (e) {
        failures.push(`${ws.name}: ${e?.message ?? e}`);
      }
    }
    return {
      ok: false,
      reason: failures.length
        ? failures.join(" ; ").slice(0, 400)
        : `no worksheets exposed (activeSheet=${sheet?.name})`,
    };
  });

  markProbe.attempted = outcome.ok;
  markProbe.note = outcome.ok
    ? `${outcome.count} mark(s) selected on "${outcome.sheet}" by ${outcome.field}`
    : outcome.reason;

  if (outcome.ok) {
    const markDeadline = Date.now() + 15_000;
    while (Date.now() < markDeadline) {
      // Both channels, or this races: the view sends the message only after the
      // context push has been accepted, so the harness can hold a mark-bearing
      // contextUpdate a beat before the matching message exists. Waiting on the
      // context alone would intermittently report the message as never sent.
      const ready = await page.evaluate(() => {
        const withMarks = (window.__host.contextUpdates || []).filter(
          (u) => (u.structuredContent?.marks?.length ?? 0) > 0,
        ).length;
        const messaged = (window.__host.messages || []).some((m) =>
          (m.content?.find((c) => c.type === "text")?.text ?? "").includes(
            "MARK(S) ON THE DASHBOARD",
          ),
        );
        return withMarks > 0 && messaged;
      });
      if (ready) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    markProbe.selected = await page.evaluate(() => {
      const withMarks = (window.__host.contextUpdates || []).filter(
        (u) => (u.structuredContent?.marks?.length ?? 0) > 0,
      );
      return withMarks.length ? withMarks[withMarks.length - 1].structuredContent.marks.length : 0;
    });
  }
} catch (e) {
  markProbe.note = `probe threw: ${e?.message ?? e}`;
}

// The verdict loop broke at firstinteractive, so every Phase 3 diagnostic row
// was written after `marks` was last read. Re-read, or the probe output below
// silently omits exactly the rows this run exists to check.
try {
  const appFrame = page.frames().find((f) => f.url().includes("/app"));
  marks = await appFrame.evaluate(() => ({
    verdict: document.getElementById("verdict")?.textContent || "",
    cls: document.getElementById("verdict")?.className || "",
    rows: Array.from(document.querySelectorAll("#log .row")).map((r) => ({
      k: r.querySelector(".k")?.textContent,
      v: r.querySelector(".v")?.textContent,
    })),
    frames: document.querySelectorAll("iframe").length,
  }));
} catch {
  /* keep the pre-verdict snapshot */
}

// Did a real Tableau frame get attached anywhere in the page tree?
const tableauFrames = page.frames().filter((f) => f.url().includes("tableau.com"));

console.log("=== PROBE OUTPUT ===");
for (const row of marks.rows || []) console.log(`  ${row.k}: ${row.v}`);
console.log("");
console.log("=== VERDICT ===");
console.log("  " + verdict);
console.log("");
// Host-contract evidence: a view that renders internally but never reports its
// size is invisible in a real host, which is exactly how Claude Desktop failed.
const host = await page.evaluate(() => window.__host);

console.log("=== HOST CONTRACT ===");
console.log(`  ui/initialize handshake   : ${host.initialized ? "OK" : "NEVER COMPLETED"}`);
console.log(`  size-changed reports      : ${host.sizeReports}`);
console.log(`  final iframe height       : ${host.lastHeight}px`);
console.log(`  methods seen by host      : ${host.methods.join(", ") || "(none)"}`);
console.log("");

// Phase 3: on-screen state must actually reach the model, not just be readable.
const contextUpdates = host.contextUpdates || [];
const firstContext = contextUpdates[0];
const contextText = firstContext?.content?.find((c) => c.type === "text")?.text ?? "";

console.log("=== MODEL CONTEXT ===");
console.log(`  ui/update-model-context   : ${contextUpdates.length} push(es)`);
if (contextText) {
  const structured = firstContext?.structuredContent;
  console.log(`  view reported             : ${structured?.view ?? "(none)"}`);
  console.log(`  filters reported          : ${structured?.filters?.length ?? 0}`);
  console.log(`  parameters reported       : ${structured?.parameters?.length ?? 0}`);
  console.log(
    `  mark selection            : ${
      markProbe.selected
        ? `EXERCISED - ${markProbe.selected} mark(s) reached the model (${markProbe.note})`
        : `not exercised - ${markProbe.note || "no selection driven"}`
    }`,
  );
  console.log("  first payload:");
  for (const line of contextText.split("\n")) console.log(`      ${line}`);

  // The first push is always pre-selection, so printing only it would hide the
  // thing this probe exists to demonstrate. Print the mark-bearing push too -
  // it is the only place to see what the model is actually told about "this".
  const markContext = contextUpdates.find(
    (u) => (u.structuredContent?.marks?.length ?? 0) > 0,
  );
  const markText = markContext?.content?.find((c) => c.type === "text")?.text;
  if (markText) {
    console.log("");
    console.log("  payload after mark selection:");
    for (const line of markText.split("\n")) console.log(`      ${line}`);
  }
} else {
  console.log("  (no text content block received)");
}
console.log("");

// The channel that actually delivers in ChatGPT, and the one whose payload the
// audience reads in the transcript. Printed in full because "is this short
// enough to put on screen twice per interaction" is a judgement no assertion
// can make - you have to look at it.
const messages = host.messages || [];
// Identified by excluding the probe report rather than by matching a marker in
// the state text. The state message carried a `state-id:` nonce until
// 2026-08-16 and was filtered on it; when that was removed for the transcript's
// sake this filter silently matched nothing and reported the channel dead. A
// state message is now just "everything on this channel that is not the probe".
const stateMessages = messages
  .map((m) => m.content?.find((c) => c.type === "text")?.text ?? "")
  .filter((t) => t && !t.startsWith("Tableau probe result:"));
const markStateText = stateMessages.find((t) => t.includes("Mark: ")) ?? "";

console.log("=== STATE BY MESSAGE ===");
console.log(`  ui/message                : ${messages.length} sent, ${stateMessages.length} carrying state`);
if (stateMessages.length) {
  // Every one of them, not just the mark-bearing push. The first-render message
  // is what the audience sees before anyone has clicked anything, and it is the
  // easiest to leave verbose by accident because no test ever looked at it.
  stateMessages.forEach((text, i) => {
    const lines = text.split("\n");
    console.log(`  message ${i + 1} - ${lines.length} lines, ${text.length} chars:`);
    for (const line of lines) console.log(`      ${line}`);
  });
} else {
  console.log("  (no state message received - the model would be told nothing)");
}
console.log("");
console.log("=== EVIDENCE ===");
console.log(`  nested iframes in app doc : ${marks.frames ?? 0}`);
console.log(`  tableau.com frames attached: ${tableauFrames.length}`);
for (const f of tableauFrames) console.log(`      ${f.url().slice(0, 150)}`);
console.log(`  CSP violations            : ${cspViolations.length}`);
for (const v of cspViolations.slice(0, 8)) console.log(`      ${v.slice(0, 190)}`);
console.log(`  failed requests           : ${netFailures.length}`);
for (const v of netFailures.slice(0, 8)) console.log(`      ${v}`);

await page.screenshot({ path: "test/probe-result.png", fullPage: false });
console.log("\n  screenshot: test/probe-result.png");

await browser.close();
server.close();

// Three halves, so to speak. Tableau must paint; the view must satisfy the host
// contract that makes it visible; and the on-screen state must reach the model,
// which is the only one of the three a user cannot verify by looking.
const vizPass = /^PASS/.test(verdict);
const hostPass = host.initialized && host.sizeReports > 0 && host.lastHeight > 0;
// Payload self-consistency. Twice in one session a new section was appended that
// quietly undercut an earlier one, and both times the model did the undercut
// thing: first "questions can be answered against the full data source" beside a
// selection (it answered about a region it invented), then "this view never
// returns numbers" directly beneath a mark line containing numbers (it said it
// could not tell which mark was selected).
//
// The sections are individually defensible, which is why review missed it. These
// phrases are only wrong *in the presence of a selection*, so that is what is
// asserted.
const SELECTION_CONTRADICTIONS = [
  "answered against the full data source",
  "never returns numbers",
  "supplies the scope, not the numbers",
];
//
// Checked on both channels. They are rendered from one function but in two
// modes, and the compact mode reshapes everything around the prose - so a
// contradiction could be introduced into the copy the model actually reads
// while the copy this test used to check stayed clean.
const markPayloadText =
  contextUpdates.find((u) => (u.structuredContent?.marks?.length ?? 0) > 0)
    ?.content?.find((c) => c.type === "text")?.text ?? "";
const contradictions = [
  ["context", markPayloadText],
  ["message", markStateText],
].flatMap(([channel, text]) =>
  text ? SELECTION_CONTRADICTIONS.filter((p) => text.includes(p)).map((p) => [channel, p]) : [],
);
if (contradictions.length) {
  console.log("=== PAYLOAD CONTRADICTION ===");
  for (const [channel, phrase] of contradictions) {
    console.log(`  a selection is present, but the ${channel} payload also says: "${phrase}"`);
  }
  console.log("");
}

const listenerRow = (marks.rows || []).find((r) => r.k === "5a. change listeners");
// Named individually: a selection listener that quietly stops being wired is
// invisible on screen and would silently drop the "this one" signal, which is
// the whole point of reporting marks at all.
const listenersAttached = ["filterchanged", "parameterchanged", "markselectionchanged"].every(
  (name) => (listenerRow?.v || "").includes(name),
);
const contextPass =
  contextUpdates.length > 0 &&
  contextText.includes("view:") &&
  listenersAttached &&
  contradictions.length === 0;

// Asserted separately from contextPass, and on the mark-bearing message rather
// than any message: this is the delivery path the demo runs on.
//
// The scoping instruction is no longer asserted here - it moved to the tool's
// return text on 2026-08-16 to keep it out of the transcript, and
// `server.smoke.js` checks it there. What this message must still carry is the
// facts: which mark, on which sheet. Strip those and the instruction has
// nothing to point at, however well worded it is.
const messagePass =
  stateMessages.length > 0 &&
  markStateText.includes("Mark: ") &&
  markStateText.includes("selected");

console.log(`\nRESULT: viz ${vizPass ? "RENDERS" : "DID NOT RENDER"}, ` +
  `host contract ${hostPass ? "SATISFIED" : "NOT SATISFIED"}, ` +
  `model context ${contextPass ? "DELIVERED" : "NOT DELIVERED"}, ` +
  `state by message ${messagePass ? "DELIVERED" : "NOT DELIVERED"}`);
process.exit(vizPass && hostPass && contextPass && messagePass ? 0 : 1);
