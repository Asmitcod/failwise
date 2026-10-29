import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeFailure,
  extractLogExcerpt,
  rankSuspectFiles,
} from "../src/lib/triage.ts";

test("sanitizes timestamps and secrets and keeps excerpts within the byte limit", () => {
  const rawLog = [
    "2026-10-28T15:22:11.410Z Starting build",
    "2026-10-28T15:22:12.000Z token=super-secret-value-123456",
    `2026-10-28T15:22:13.000Z ${"output ".repeat(5000)}`,
    "2026-10-28T15:22:14.000Z error: build failed",
  ].join("\n");

  const result = extractLogExcerpt(rawLog);

  assert.ok(result.excerptBytes <= 16 * 1024);
  assert.equal(result.redactionCount, 1);
  assert.match(result.excerpt, /\[REDACTED\]/);
  assert.doesNotMatch(result.excerpt, /super-secret-value/);
  assert.doesNotMatch(result.excerpt, /2026-10-28T/);
  assert.match(result.excerpt, /error: build failed/);
});

test("classifies type-check failures and returns their line numbers as evidence", () => {
  const result = analyzeFailure(
    "npm test\nsrc/cart.ts(42,19): error TS2339: Property 'total' does not exist.",
    [{ path: "src/cart.ts", changeType: "modified", additions: 2, deletions: 1 }],
  );

  assert.equal(result.category, "lint_type");
  assert.deepEqual(result.causes[0].evidence_lines, [2]);
  assert.deepEqual(result.suspectFiles.map(({ path }) => path), ["src/cart.ts"]);
  assert.equal(result.degraded, false);
});

test("prioritizes workflow files for CI configuration failures", () => {
  const ranked = rankSuspectFiles(
    [
      { path: "src/app.ts", changeType: "modified", additions: 50, deletions: 0 },
      {
        path: ".github/workflows/ci.yml",
        changeType: "modified",
        additions: 1,
        deletions: 1,
      },
    ],
    "invalid workflow syntax: unexpected value",
    "ci_config",
  );

  assert.equal(ranked[0].path, ".github/workflows/ci.yml");
});

test("returns a low-confidence rules-only result when no signature is recognized", () => {
  const result = analyzeFailure("A process exited unexpectedly.", []);

  assert.equal(result.category, "unknown");
  assert.equal(result.confidence, "low");
  assert.equal(result.degraded, true);
  assert.deepEqual(result.causes[0].evidence_lines, []);
});
