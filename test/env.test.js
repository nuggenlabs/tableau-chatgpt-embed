/**
 * .env loader tests.
 *
 * The first case is a regression: the loader used to assign an empty `KEY=`
 * line and report it as applied, so startup announced "loaded 5 var(s)" and the
 * very next line failed with three of those five missing. Two true-looking
 * messages that contradict each other are worse than either failure alone.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatEnvLoad, loadEnvFile, parseEnv } from "../src/env.js";

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? " -> " + detail : ""}`);
  if (!cond) failures++;
};

const dir = mkdtempSync(join(tmpdir(), "env-test-"));
const writeEnv = (name, body) => {
  const path = join(dir, name);
  writeFileSync(path, body, "utf-8");
  return path;
};

console.log("=== parsing ===");

const parsed = parseEnv(
  [
    "# a comment",
    "",
    "PLAIN=value",
    "export EXPORTED=from-shell-style",
    'DOUBLE="quoted value"',
    "SINGLE='quoted value'",
    "  SPACED  =  trimmed  ",
    "EMPTY=",
    "NOT_A_PAIR",
  ].join("\n"),
);

check("plain key/value", parsed.PLAIN === "value");
check("`export ` prefix stripped", parsed.EXPORTED === "from-shell-style");
check("double quotes stripped", parsed.DOUBLE === "quoted value");
check("single quotes stripped", parsed.SINGLE === "quoted value");
check("whitespace trimmed", parsed.SPACED === "trimmed");
check("comments skipped", !("# a comment" in parsed));
check("lines without = skipped", !("NOT_A_PAIR" in parsed));
check("empty value parses as empty string", parsed.EMPTY === "");

// Notepad on Windows can save UTF-8 with a BOM; unstripped it joins the first
// key's name, so that one key silently fails to load while the rest work.
const withBom = parseEnv("﻿FIRST_KEY=value\nSECOND_KEY=other");
check("a UTF-8 BOM does not corrupt the first key", withBom.FIRST_KEY === "value", Object.keys(withBom).join(", "));

console.log("=== application ===");

// The exact shape of .env.example before it was fixed: viz URL and user filled
// in, the three secrets left as bare `KEY=` lines.
const partial = writeEnv(
  "partial.env",
  [
    "TABLEAU_VIZ_URL=https://us-east-1.online.tableau.com/t/site/views/WB/View",
    "TABLEAU_CONNECTED_APP_CLIENT_ID=",
    "TABLEAU_CONNECTED_APP_SECRET_ID=",
    "TABLEAU_CONNECTED_APP_SECRET_VALUE=",
    "TABLEAU_EMBED_USER=you@example.com",
  ].join("\n"),
);

const env = {};
const result = loadEnvFile({ path: partial, env });

check(
  "an empty line is NOT applied",
  !Object.prototype.hasOwnProperty.call(env, "TABLEAU_CONNECTED_APP_CLIENT_ID"),
  "assigning '' made downstream falsiness checks disagree with the load summary",
);
check("empty keys are reported", result.empty.length === 3, result.empty.join(", "));
check("only real values counted as applied", result.applied.length === 2, result.applied.join(", "));
check(
  "the summary names the empty keys",
  /PRESENT BUT EMPTY/.test(formatEnvLoad(result)),
  "silence here is what made the original failure confusing",
);

console.log("=== precedence ===");

const both = writeEnv("both.env", "SHARED=from-file\nFILE_ONLY=from-file\n");
const shellEnv = { SHARED: "from-shell" };
const precedence = loadEnvFile({ path: both, env: shellEnv });

check(
  "a value already set in the shell wins",
  shellEnv.SHARED === "from-shell",
  "the file is the convenience; a shell export is a deliberate one-run override",
);
check("shell-set keys are reported as skipped", precedence.skipped.includes("SHARED"));
check("file-only keys still apply", shellEnv.FILE_ONLY === "from-file");

const blankShell = { SHARED: "" };
loadEnvFile({ path: both, env: blankShell });
check(
  "an empty shell value does not block the file",
  blankShell.SHARED === "from-file",
  "an exported-but-blank var is not a deliberate override",
);

console.log("=== missing file ===");

const absent = loadEnvFile({ path: join(dir, "nope.env"), env: {} });
check("a missing .env is not an error", absent.loaded === false && !absent.error);
check("and says so plainly", /no \.env at/.test(formatEnvLoad(absent)));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
