/**
 * Minimal .env loader.
 *
 * Connected App credentials previously survived only in shell environment
 * variables, so every closed window meant re-entering five values - and one of
 * the 2026-08-10 failures was a template placeholder pasted verbatim during
 * exactly that re-entry. A gitignored `.env` removes the most repeated setup
 * cost in this project.
 *
 * Hand-rolled rather than `dotenv`, per the repo's dependency-light rule: the
 * format is a dozen lines of parsing, and this way the precedence rule below is
 * ours to state rather than a library's to change.
 *
 * `process.loadEnvFile()` exists in modern Node but overwrites nothing and
 * throws on a missing file; the explicit parser makes both behaviours visible.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The app root, one level up from src/. */
export const DEFAULT_ENV_PATH = join(__dirname, "..", ".env");

/**
 * Parses .env text into a plain object.
 *
 * Deliberately small: `KEY=value`, `#` comments, blank lines, optional
 * surrounding quotes, and an optional `export ` prefix so a file can be both
 * sourced by a shell and read here. No interpolation, no multi-line values -
 * anything fancier is a sign the value belongs somewhere else.
 */
export function parseEnv(text) {
  const out = {};
  // Windows editors (Notepad among them) can save UTF-8 with a byte-order mark.
  // Left in place it becomes part of the first key's name, so that key silently
  // fails to load while every other line works - the worst kind of bug to hunt
  // in a credentials file.
  const body = String(text).replace(/^﻿/, "");
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    // Quotes are stripped only when they match, so a value that legitimately
    // starts with a quote is not silently mangled.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Loads `.env` into `process.env`.
 *
 * **A variable already set in the environment always wins.** That ordering is
 * the point: the file is the convenience, and a value exported in the current
 * shell is a deliberate override for this run - most often pointing at a
 * different viz or a freshly regenerated secret. Silently clobbering it would
 * make a correct-looking shell command do nothing.
 *
 * Returns which keys were applied and which were skipped, so startup can say so
 * without printing any values.
 */
export function loadEnvFile({ path = DEFAULT_ENV_PATH, env = process.env } = {}) {
  if (!existsSync(path)) return { loaded: false, path, applied: [], skipped: [] };

  let parsed;
  try {
    parsed = parseEnv(readFileSync(path, "utf-8"));
  } catch (err) {
    return { loaded: false, path, applied: [], skipped: [], error: String(err?.message ?? err) };
  }

  const applied = [];
  const skipped = [];
  const empty = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined && env[key] !== "") {
      skipped.push(key);
      continue;
    }
    // A bare `KEY=` is an unfilled line, not a deliberate empty string.
    // Assigning "" here made the loader claim it had applied a variable that
    // every downstream falsiness check then read as missing - so startup said
    // "loaded 5 vars" and the next line said three of them were absent. Report
    // it as unfilled and leave it unset, so the two messages agree.
    if (value === "") {
      empty.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }

  return { loaded: true, path, applied, skipped, empty };
}

/** One line for stderr. Names keys only - never values. */
export function formatEnvLoad(result) {
  if (!result.loaded) {
    return result.error
      ? `[env] .env present but unreadable: ${result.error}`
      : `[env] no .env at ${result.path} - using shell environment only`;
  }
  const parts = [`[env] loaded ${result.applied.length} var(s) from .env`];
  if (result.applied.length) parts.push(`applied: ${result.applied.join(", ")}`);
  if (result.skipped.length) {
    parts.push(`already set in shell, left alone: ${result.skipped.join(", ")}`);
  }
  // Named loudly: an unfilled line is the most likely reason the next thing to
  // read process.env reports a variable as missing.
  if (result.empty?.length) {
    parts.push(`PRESENT BUT EMPTY in .env, so NOT set: ${result.empty.join(", ")}`);
  }
  return parts.join(" | ");
}
