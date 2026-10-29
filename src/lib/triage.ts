export const MAX_LOG_BYTES = 16 * 1024;
const ERROR_PATTERNS = [
  /##\[error\]/i,
  /\berror\b/i,
  /\bfail(?:ed|ure)?\b/i,
  /\bexception\b/i,
  /\btraceback\b/i,
  /\bexit code [1-9]\d*\b/i,
  /\bERESOLVE\b/i,
  /\bTS\d{4}\b/i,
  /\btimed? ?out\b/i,
];

export type FailureCategory =
  | "test"
  | "build"
  | "lint_type"
  | "dependency"
  | "infra_timeout"
  | "ci_config"
  | "unknown";

export type Confidence = "low" | "medium" | "high";

export interface ChangedFile {
  path: string;
  changeType: string;
  additions: number;
  deletions: number;
}

export interface ExcerptLine {
  number: number;
  text: string;
}

export interface SuspectFile {
  path: string;
  reason: string;
  score: number;
}

export interface TriageResult {
  summary: string;
  category: FailureCategory;
  confidence: Confidence;
  causes: { explanation: string; evidence_lines: number[] }[];
  suspectFiles: SuspectFile[];
  nextSteps: string[];
  excerpt: string;
  excerptLines: ExcerptLine[];
  excerptBytes: number;
  redactionCount: number;
  degraded: boolean;
  promptVersion: string;
}

const CATEGORY_RULES: {
  category: FailureCategory;
  pattern: RegExp;
  confidence: Confidence;
}[] = [
  {
    category: "dependency",
    pattern: /\bERESOLVE\b|unable to resolve dependency|lockfile|package-lock|pnpm-lock|yarn\.lock|npm ci can only install/i,
    confidence: "high",
  },
  {
    category: "ci_config",
    pattern: /workflow.*(?:syntax|invalid)|(?:yaml|yml).*(?:syntax|parse)|unexpected value|invalid workflow|unrecognized named-value/i,
    confidence: "high",
  },
  {
    category: "infra_timeout",
    pattern: /timed? ?out|exceeded the maximum execution time|connection reset|network is unreachable|temporary failure in name resolution|rate limit exceeded/i,
    confidence: "high",
  },
  {
    category: "lint_type",
    pattern: /\bTS\d{4}\b|eslint|type(?:check| checking)? error|type error|mypy/i,
    confidence: "high",
  },
  {
    category: "test",
    pattern: /test suite failed|failed tests?|assertionerror|assertion failed|expect\(.*\)|\bjest\b.*\bfail/i,
    confidence: "medium",
  },
  {
    category: "build",
    pattern: /build failed|failed to compile|could not compile|compilation error|webpack.*error|error CS\d{4}/i,
    confidence: "medium",
  },
];

const NEXT_STEPS: Record<FailureCategory, string[]> = {
  test: [
    "Open the failing test and compare the expected value with the actual output.",
    "Check whether the change altered the behavior or fixtures used by this test.",
    "Run the failing test by itself to confirm the failure is reproducible.",
  ],
  build: [
    "Inspect the first compiler or bundler error above the final build failure.",
    "Check whether the changed module has unresolved imports or incompatible exports.",
    "Re-run the build locally with the same runtime and dependency versions.",
  ],
  lint_type: [
    "Open the cited file and inspect the reported type or lint diagnostic.",
    "Check nearby changed call sites for an outdated property or incompatible type.",
    "Run the same type-check or lint command locally before changing code.",
  ],
  dependency: [
    "Compare the dependency manifest and lockfile for inconsistent versions.",
    "Check whether the lockfile was generated with the package manager version used in CI.",
    "Reproduce a clean install locally without changing repository state.",
  ],
  infra_timeout: [
    "Check the Actions run for runner, network, or service interruptions.",
    "Compare the duration with recent runs to see whether this is an isolated slowdown.",
    "Inspect the failing step's retries and external service availability.",
  ],
  ci_config: [
    "Inspect the workflow syntax and the line referenced by the Actions error.",
    "Check changed workflow expressions, keys, and indentation against GitHub Actions syntax.",
    "Compare the workflow with the last successful run configuration.",
  ],
  unknown: [
    "Open the failed step and inspect the earliest error before the final exit code.",
    "Compare this run with the latest successful run on the same branch.",
    "Add more context or a failure signature before drawing a root-cause conclusion.",
  ],
};

function redactSecrets(value: string): { text: string; count: number } {
  let count = 0;
  let text = value.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi,
    () => {
      count += 1;
      return "[REDACTED_TOKEN]";
    },
  );
  text = text.replace(
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    () => {
      count += 1;
      return "Bearer [REDACTED_TOKEN]";
    },
  );
  text = text.replace(
    /\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, prefix: string) => {
      count += 1;
      return `${prefix}[REDACTED]`;
    },
  );
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, () => {
    count += 1;
    return "[REDACTED_AWS_KEY]";
  });
  return { text, count };
}

function cleanLogLine(line: string): { text: string; redactionCount: number } {
  const withoutAnsi = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const withoutTimestamp = withoutAnsi.replace(
    /^\s*(?:\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?\s+|\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+)/,
    "",
  );
  const redacted = redactSecrets(withoutTimestamp.trim());
  return { text: redacted.text, redactionCount: redacted.count };
}

function clipToUtf8Bytes(value: string, maxBytes: number): string {
  let clipped = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    clipped += character;
    bytes += characterBytes;
  }
  return clipped;
}

function renderExcerpt(lines: ExcerptLine[]): string {
  return lines.map(({ number, text }) => `${number} | ${text}`).join("\n");
}

export function extractLogExcerpt(rawLog: string, requestedMaxBytes = MAX_LOG_BYTES) {
  if (!Number.isFinite(requestedMaxBytes) || requestedMaxBytes < 0) {
    throw new RangeError("The log excerpt byte limit must be a non-negative number.");
  }

  const maxBytes = Math.min(Math.floor(requestedMaxBytes), MAX_LOG_BYTES);
  const cleanedLines: ExcerptLine[] = [];
  let redactionCount = 0;

  rawLog.split(/\r?\n/).forEach((rawLine, index) => {
    const cleaned = cleanLogLine(rawLine);
    redactionCount += cleaned.redactionCount;
    if (cleaned.text && cleanedLines.at(-1)?.text !== cleaned.text) {
      cleanedLines.push({ number: index + 1, text: cleaned.text });
    }
  });

  const priorities = new Map<number, number>();
  const mark = (index: number, priority: number) => {
    const current = priorities.get(index);
    if (current === undefined || priority < current) priorities.set(index, priority);
  };

  cleanedLines.forEach((line, index) => {
    if (ERROR_PATTERNS.some((pattern) => pattern.test(line.text))) {
      mark(index, 0);
      for (let context = Math.max(0, index - 10); context <= Math.min(cleanedLines.length - 1, index + 10); context += 1) {
        mark(context, 1);
      }
    }
  });

  for (let index = Math.max(0, cleanedLines.length - 200); index < cleanedLines.length; index += 1) {
    mark(index, 2);
  }

  const selected: ExcerptLine[] = [];
  let usedBytes = 0;
  const prioritized = [...priorities.entries()].sort(
    ([leftIndex, leftPriority], [rightIndex, rightPriority]) =>
      leftPriority - rightPriority || leftIndex - rightIndex,
  );

  for (const [index] of prioritized) {
    const line = cleanedLines[index];
    const prefix = `${line.number} | `;
    const separatorBytes = selected.length ? 1 : 0;
    const availableTextBytes = maxBytes - usedBytes - separatorBytes - new TextEncoder().encode(prefix).byteLength;
    if (availableTextBytes <= 0) continue;

    const text = clipToUtf8Bytes(line.text, availableTextBytes);
    const entry = { number: line.number, text };
    const renderedBytes = new TextEncoder().encode(`${prefix}${text}`).byteLength + separatorBytes;
    if (renderedBytes > 0) {
      selected.push(entry);
      usedBytes += renderedBytes;
    }
  }

  selected.sort((left, right) => left.number - right.number);
  const excerpt = renderExcerpt(selected);
  return {
    excerpt,
    lines: selected,
    excerptBytes: new TextEncoder().encode(excerpt).byteLength,
    redactionCount,
  };
}

export function classifyFailure(excerpt: string): {
  category: FailureCategory;
  confidence: Confidence;
  evidence: string[];
} {
  for (const rule of CATEGORY_RULES) {
    const evidence = excerpt.split("\n").filter((line) => rule.pattern.test(line));
    if (evidence.length) {
      return { category: rule.category, confidence: rule.confidence, evidence: evidence.slice(0, 3) };
    }
  }
  return { category: "unknown", confidence: "low", evidence: [] };
}

export function rankSuspectFiles(
  changedFiles: ChangedFile[],
  excerpt: string,
  category: FailureCategory,
): SuspectFile[] {
  const normalizedExcerpt = excerpt.toLowerCase().replaceAll("\\", "/");
  return changedFiles
    .map((file) => {
      const path = file.path.replaceAll("\\", "/");
      const normalizedPath = path.toLowerCase();
      const filename = normalizedPath.split("/").at(-1) ?? normalizedPath;
      const basename = filename.replace(/\.[^.]+$/, "");
      let score = 0;
      const reasons: string[] = [];

      if (normalizedExcerpt.includes(normalizedPath)) {
        score += 100;
        reasons.push("Path appears in the log");
      } else if (normalizedExcerpt.includes(filename)) {
        score += 35;
        reasons.push("Filename appears in the log");
      } else if (basename.length > 2 && normalizedExcerpt.includes(basename)) {
        score += 15;
        reasons.push("Module name appears in the log");
      }

      if (category === "dependency" && /(?:package-lock|pnpm-lock|yarn\.lock|lockfile)/i.test(path)) {
        score += 40;
        reasons.push("Lockfile changed in a dependency failure");
      }
      if (category === "ci_config" && path.startsWith(".github/workflows/")) {
        score += 40;
        reasons.push("Workflow file changed in a CI configuration failure");
      }
      if (category === "lint_type" && /\.(?:ts|tsx|js|jsx)$/i.test(path)) {
        score += 10;
        reasons.push("Source file changed in a lint or type failure");
      }
      if (category === "test" && /(?:^|[./_-])(?:test|spec)(?:[./_-]|$)/i.test(path)) {
        score += 20;
        reasons.push("Test file changed in a test failure");
      }

      const changeSize = Math.max(0, file.additions) + Math.max(0, file.deletions);
      if (changeSize) {
        score += Math.min(10, Math.ceil(changeSize / 20));
      }

      return {
        path,
        score,
        reason: reasons.join(" · ") || "Changed in this run; no direct log match",
      };
    })
    .filter((file) => file.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 3);
}

export function analyzeFailure(rawLog: string, changedFiles: ChangedFile[]): TriageResult {
  const excerptResult = extractLogExcerpt(rawLog);
  const classification = classifyFailure(excerptResult.excerpt);
  const suspectFiles = rankSuspectFiles(changedFiles, excerptResult.excerpt, classification.category);
  const evidenceLines = classification.evidence
    .map((evidence) => Number(evidence.match(/^(\d+)\s*\|/)?.[1]))
    .filter((lineNumber) => Number.isInteger(lineNumber));
  const categoryLabel = classification.category.replaceAll("_", " ");
  const explanation =
    classification.category === "unknown"
      ? "No known failure signature was found in the available log excerpt."
      : `The log contains a ${categoryLabel} failure signature. This is a likely classification, not a confirmed root cause.`;

  return {
    summary:
      classification.category === "unknown"
        ? "The failure could not be classified from the available log evidence."
        : `${categoryLabel[0].toUpperCase()}${categoryLabel.slice(1)} failure detected from the job log.`,
    category: classification.category,
    confidence: classification.confidence,
    causes: [{ explanation, evidence_lines: evidenceLines }],
    suspectFiles,
    nextSteps: NEXT_STEPS[classification.category],
    excerpt: excerptResult.excerpt,
    excerptLines: excerptResult.lines,
    excerptBytes: excerptResult.excerptBytes,
    redactionCount: excerptResult.redactionCount,
    degraded: classification.category === "unknown",
    promptVersion: "rules-v1",
  };
}
