import assert from "node:assert/strict";
import test from "node:test";
import { getDashboardData } from "../src/lib/dashboard-data.ts";

test("shows the labeled demo preview when no database is configured", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const data = await getDashboardData();

    assert.equal(data.mode, "demo");
    assert.equal(data.runs.length, 1);
    assert.equal(data.selectedRun.repository, "acme/payments");
    assert.equal(data.selectedRun.analysis.promptVersion, "rules-v1");
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("applies repository, workflow, branch, and processing-state filters", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const matching = await getDashboardData(undefined, {
      search: "checkout-summary",
      state: "failed",
    });
    const wrongState = await getDashboardData(undefined, {
      search: "checkout-summary",
      state: "completed",
    });
    const wrongSearch = await getDashboardData(undefined, {
      search: "unknown-repo",
      state: "all",
    });

    assert.equal(matching.runs.length, 1);
    assert.equal(wrongState.runs.length, 0);
    assert.equal(wrongSearch.runs.length, 0);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
