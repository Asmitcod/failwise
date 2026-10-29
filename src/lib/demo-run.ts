import type { ChangedFile } from "./triage.ts";

export const demoRun = {
  repository: "acme/payments",
  branch: "feature/checkout-summary",
  commit: "a81f2c9",
  runNumber: 1842,
  failedJob: "unit-tests / node-20",
  runUrl: "https://github.com/acme/payments/actions/runs/1842",
  log: [
    "2026-10-28T15:22:11.410Z ##[group]Run npm test",
    "> payments-web@1.4.0 test",
    "> vitest run",
    "",
    "src/checkout/summary.ts(42,19): error TS2339: Property 'discountTotal' does not exist on type 'CartSummary'.",
    "##[error]Process completed with exit code 2.",
  ].join("\n"),
  changedFiles: [
    {
      path: "src/checkout/summary.ts",
      changeType: "modified",
      additions: 18,
      deletions: 7,
    },
    {
      path: "src/cart/types.ts",
      changeType: "modified",
      additions: 4,
      deletions: 1,
    },
    {
      path: "tests/checkout-summary.test.ts",
      changeType: "modified",
      additions: 12,
      deletions: 3,
    },
  ] satisfies ChangedFile[],
};
