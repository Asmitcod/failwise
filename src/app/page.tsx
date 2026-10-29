import Link from "next/link";
import {
  getDashboardData,
  type DashboardPagination,
  type DashboardRunSummary,
} from "@/lib/dashboard-data";
import styles from "./page.module.css";

export const instant = false;

function categoryLabel(category: string) {
  return category.replaceAll("_", " ");
}

function runStateLabel(state: string) {
  return state.replaceAll("_", " ");
}

function runTimestamp(value: Date) {
  return value.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function RunHistory({
  runs,
  selectedKey,
  search,
  state,
  pagination,
}: {
  runs: DashboardRunSummary[];
  selectedKey: string;
  search: string;
  state: string;
  pagination: DashboardPagination;
}) {
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (state !== "all") params.set("state", state);
    params.set("page", page.toString());
    return `/?${params.toString()}`;
  };
  const firstResult = pagination.total
    ? (pagination.page - 1) * pagination.pageSize + 1
    : 0;
  const lastResult = Math.min(pagination.page * pagination.pageSize, pagination.total);

  return (
    <section className={styles.historyPanel} aria-labelledby="history-heading">
      <div className={styles.historyHeading}>
        <div>
          <span className={styles.sectionEyebrow}><span className={styles.sectionIndex}>00</span> EVENT STREAM</span>
          <h2 id="history-heading">Recent runs</h2>
        </div>
        <form className={styles.historyFilters} action="/" method="get">
          <input type="hidden" name="run" value={selectedKey} />
          <label className={styles.visuallyHidden} htmlFor="run-search">Search runs</label>
          <input
            id="run-search"
            className={styles.historySearch}
            type="search"
            name="q"
            placeholder="repo / workflow / branch"
            defaultValue={search}
          />
          <label className={styles.visuallyHidden} htmlFor="run-state">Filter by processing state</label>
          <select id="run-state" className={styles.historyStateFilter} name="state" defaultValue={state || "all"}>
            <option value="all">ALL STATES</option>
            <option value="queued">QUEUED</option>
            <option value="collecting">COLLECTING</option>
            <option value="analyzing">ANALYZING</option>
            <option value="completed">COMPLETED</option>
            <option value="degraded">DEGRADED</option>
            <option value="failed">FAILED</option>
          </select>
          <button className={styles.historyFilterButton} type="submit">FILTER</button>
        </form>
      </div>
      <div className={styles.historyResultCount}>
        {String(runs.length).padStart(2, "0")} MATCHING RUN{runs.length === 1 ? "" : "S"}
      </div>
      <div className={styles.historyList}>
        {runs.map((run) => (
          <Link
            className={`${styles.historyItem} ${run.key === selectedKey ? styles.historyItemActive : ""}`}
            href={`/?${new URLSearchParams({
              ...(search ? { q: search } : {}),
              ...(state && state !== "all" ? { state } : {}),
              page: pagination.page.toString(),
              run: run.key,
            }).toString()}`}
            key={run.key}
          >
            <span className={`${styles.historyState} ${run.conclusion === "success" ? styles.historyStateSuccess : ""}`} />
            <span className={styles.historyRun}>
              <strong>{run.repository}</strong>
              <span>{run.workflowName} · #{run.runId} / attempt {run.attempt}</span>
            </span>
            <span className={styles.historyStatus}>
              <strong>{runStateLabel(run.state)}</strong>
              <span>{runTimestamp(run.createdAt)}</span>
            </span>
            <span className={styles.historyArrow} aria-hidden="true">↗</span>
          </Link>
        ))}
      </div>
      <div className={styles.historyPagination}>
        <span>{firstResult}–{lastResult} OF {pagination.total}</span>
        <div>
          <Link
            aria-disabled={pagination.page <= 1}
            className={pagination.page <= 1 ? styles.pageControlDisabled : styles.pageControl}
            href={pageHref(Math.max(1, pagination.page - 1))}
            tabIndex={pagination.page <= 1 ? -1 : undefined}
          >
            ← PREVIOUS
          </Link>
          <span className={styles.pageNumber}>
            {String(pagination.page).padStart(2, "0")} / {String(pagination.totalPages).padStart(2, "0")}
          </span>
          <Link
            aria-disabled={pagination.page >= pagination.totalPages}
            className={pagination.page >= pagination.totalPages ? styles.pageControlDisabled : styles.pageControl}
            href={pageHref(Math.min(pagination.totalPages, pagination.page + 1))}
            tabIndex={pagination.page >= pagination.totalPages ? -1 : undefined}
          >
            NEXT →
          </Link>
        </div>
      </div>
    </section>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; q?: string; state?: string; page?: string }>;
}) {
  const { run: requestedRunKey, q, state, page: requestedPage } = await searchParams;
  const search = q?.slice(0, 100) ?? "";
  const parsedPage = Number.parseInt(requestedPage ?? "1", 10);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const validStates = new Set([
    "all",
    "queued",
    "collecting",
    "analyzing",
    "completed",
    "degraded",
    "failed",
  ]);
  const selectedState = state && validStates.has(state) ? state : "all";
  const data = await getDashboardData(requestedRunKey, {
    search,
    state: selectedState,
    page,
  });
  if (data.mode === "error") {
    return (
      <main className={styles.shell}>
        <aside className={styles.sidebar}>
          <Link className={styles.brand} href="/" aria-label="Failwise home">
            <span className={styles.brandMark}>F</span><span>failwise</span>
            <span className={styles.brandVersion}>/ 01</span>
          </Link>
          <div className={styles.workspaceLabel}>WORKSPACE</div>
          <Link className={`${styles.navItem} ${styles.navActive}`} href="/">
            <span className={styles.navIcon}>◫</span>Runs
          </Link>
          <div className={styles.sidebarBottom}>
            <span className={styles.statusDot} /><span>DATABASE ERROR</span>
          </div>
        </aside>
        <section className={styles.content}>
          <header className={styles.topbar}>
            <div className={styles.breadcrumb}><span>WORKSPACE</span><span className={styles.slash}>/</span><span>RUNS</span></div>
            <span className={styles.demoBadge}>DATA SOURCE ERROR</span>
          </header>
          <div className={styles.pageContent}>
            <section className={styles.emptyPanel}>
              <span className={styles.sectionEyebrow}><span className={styles.sectionIndex}>!</span> PERSISTENCE LAYER</span>
              <h1>Run data unavailable</h1>
              <p>{data.message}</p>
            </section>
          </div>
        </section>
      </main>
    );
  }

  const { selectedRun, runs, mode, pagination } = data;
  if (!selectedRun) {
    const hasFilters = Boolean(search) || selectedState !== "all";
    return (
      <main className={styles.shell}>
        <aside className={styles.sidebar}>
          <Link className={styles.brand} href="/" aria-label="Failwise home">
            <span className={styles.brandMark}>F</span><span>failwise</span>
            <span className={styles.brandVersion}>/ 01</span>
          </Link>
          <div className={styles.workspaceLabel}>WORKSPACE</div>
          <Link className={`${styles.navItem} ${styles.navActive}`} href="/">
            <span className={styles.navIcon}>◫</span>Runs
          </Link>
          <div className={styles.sidebarBottom}>
            <span className={styles.statusDot} /><span>DATABASE CONNECTED</span>
          </div>
        </aside>
        <section className={styles.content}>
          <header className={styles.topbar}>
            <div className={styles.breadcrumb}><span>WORKSPACE</span><span className={styles.slash}>/</span><span>RUNS</span></div>
            <span className={styles.demoBadge}>PERSISTED DATA</span>
          </header>
          <div className={styles.pageContent}>
            <section className={styles.emptyPanel}>
              <span className={styles.sectionEyebrow}><span className={styles.sectionIndex}>00</span> EVENT STREAM</span>
              <h1>{hasFilters ? "No matching runs" : "No runs ingested yet"}</h1>
              <p>
                {hasFilters
                  ? "Try a different search or state filter to find a run."
                  : mode === "demo"
                    ? "The demo preview does not match these filters. Clear filters to return to the sample run."
                    : "Database connection is active. Send a completed failed workflow run to the configured GitHub webhook to see its triage here."}
              </p>
              {hasFilters ? <Link className={styles.clearFilters} href="/">CLEAR FILTERS ↗</Link> : null}
            </section>
          </div>
        </section>
      </main>
    );
  }

  const analysis = selectedRun.analysis;
  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link className={styles.brand} href="/" aria-label="Failwise home">
          <span className={styles.brandMark}>F</span>
          <span>failwise</span>
          <span className={styles.brandVersion}>/ 01</span>
        </Link>
        <div className={styles.workspaceLabel}>WORKSPACE</div>
        <Link className={`${styles.navItem} ${styles.navActive}`} href="/">
          <span className={styles.navIcon}>◫</span>
          Runs
          <span className={styles.navCount}>{runs.length}</span>
        </Link>
        <a className={styles.navItem} href="#how-it-works">
          <span className={styles.navIcon}>⌁</span>
          Analysis
        </a>
        <div className={styles.sidebarRule} />
        <div className={styles.workspaceLabel}>SYSTEM</div>
        <div className={styles.systemItem}>
          <span className={styles.systemGlyph}>⌘</span>
          Rules engine
          <span className={styles.systemState}>READY</span>
        </div>
        <div className={styles.systemItem}>
          <span className={styles.systemGlyph}>◈</span>
          LLM provider
          <span className={styles.systemOff}>OFF</span>
        </div>
        <div className={styles.sideBuild}>
          <span className={styles.sideBuildLabel}>CURRENT BUILD</span>
          <span className={styles.sideBuildName}>{selectedRun.workflowName}</span>
          <span className={styles.sideBuildSha}>sha · {selectedRun.headSha.slice(0, 7)}</span>
          <span className={styles.sideBuildLine} />
          <span className={styles.sideBuildNote}>Rules-first · read only</span>
        </div>
        <div className={styles.sidebarBottom}>
          <span className={styles.statusDot} />
          <span>LOCAL ENVIRONMENT</span>
          <span className={styles.readOnly}>V0.1</span>
        </div>
      </aside>

      <section className={styles.content}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}>
            <span className={styles.breadcrumbMark}>⌘</span>
            <span>WORKSPACE</span><span className={styles.slash}>/</span>
            <span>RUNS</span><span className={styles.slash}>/</span>
            <span className={styles.crumbCurrent}>TRIAGE DETAIL</span>
          </div>
          <div className={styles.topbarRight}>
            <span className={styles.topStatus}><span /> ANALYSIS SYSTEM READY</span>
            <span className={styles.demoBadge}>{mode === "demo" ? "DEMO DATA" : "PERSISTED DATA"}</span>
          </div>
        </header>

        <div className={styles.pageContent}>
          <div className={styles.headingRow}>
            <div>
              <div className={styles.eyebrow}><span className={styles.headingPulse} /> FAILURE INTELLIGENCE <span className={styles.headingSlash}>/</span> GITHUB ACTIONS</div>
              <h1>Run <span className={styles.headingHash}>#{selectedRun.runId}</span></h1>
              <p className={styles.subtitle}>One failure. The evidence, likely cause, and next move.</p>
            </div>
            <a className={styles.githubLink} href={selectedRun.htmlUrl} target="_blank" rel="noreferrer">
              <span className={styles.githubIcon}>GH</span>
              OPEN SOURCE RUN <span aria-hidden="true">↗</span>
            </a>
          </div>

          <RunHistory
            runs={runs}
            selectedKey={selectedRun.key}
            search={search}
            state={selectedState}
            pagination={pagination}
          />

          <section className={styles.summaryCard} aria-labelledby="summary-heading">
            <div className={styles.cardGrid} aria-hidden="true" />
            <div className={styles.incidentRail}>
              <span>INCIDENT</span>
              <span className={styles.incidentRailLine} />
              <span>#{selectedRun.runId}</span>
            </div>
            <div className={styles.summaryTop}>
              <div className={styles.failureIcon} aria-hidden="true"><span>!</span></div>
              <div className={styles.summaryCopy}>
                <div className={styles.summaryMeta}>
                  <span className={styles.failedBadge}><span /> {selectedRun.conclusion.toUpperCase()} DETECTED</span>
                  <span className={styles.metaDivider}>/</span>
                  <span>{selectedRun.repository}</span>
                </div>
                <h2 id="summary-heading">{analysis.summary}</h2>
                <p>
                  {analysis.causes[0]?.explanation ??
                    "The available log evidence was not enough to determine a likely cause."}
                </p>
              </div>
              <div className={styles.confidence}>
                <span className={styles.confidenceLabel}>SIGNAL STRENGTH</span>
                <div className={styles.confidenceMeter} aria-label={`${analysis.confidence} confidence`}>
                  <span className={styles[`confidenceFill${analysis.confidence}`]} />
                  <span className={styles[`confidenceFill${analysis.confidence}`]} />
                  <span className={styles[`confidenceFill${analysis.confidence}`]} />
                  <span />
                  <span />
                </div>
                <strong className={styles[`confidence${analysis.confidence}`]}>{analysis.confidence} confidence</strong>
              </div>
            </div>

            <div className={styles.cardDivider} />
            <div className={styles.classificationRow}>
              <div className={styles.classificationGroup}>
                <span className={styles.fieldLabel}>CLASSIFICATION</span>
                <span className={styles.categoryPill}><span className={styles.categoryDot} />{categoryLabel(analysis.category)}</span>
                <span className={styles.jobTag}>{selectedRun.failedJob}</span>
              </div>
              <div className={styles.degradedNote}>
                <span className={styles.ruleGlyph} aria-hidden="true">⌘</span>
                RULE-BASED <span className={styles.degradedSeparator}>/</span> NO AI CALL
              </div>
            </div>
          </section>

          <section className={styles.signalStrip} aria-label="Run context">
            <div className={styles.signalCell}>
              <span className={styles.signalLabel}>REPOSITORY</span>
              <span className={styles.signalValue}><span className={styles.signalGlyph}>◈</span>{selectedRun.repository}</span>
            </div>
            <div className={styles.signalCell}>
              <span className={styles.signalLabel}>BRANCH</span>
              <span className={styles.signalValue}><span className={styles.signalGlyph}>⑂</span>{selectedRun.branch}</span>
            </div>
            <div className={styles.signalCell}>
              <span className={styles.signalLabel}>HEAD COMMIT</span>
              <span className={styles.signalValue}><span className={styles.signalGlyph}>⌗</span>{selectedRun.headSha.slice(0, 12)}</span>
            </div>
            <div className={styles.signalCell}>
              <span className={styles.signalLabel}>RUN STATUS</span>
              <span className={styles.signalValue}><span className={styles.signalFailedDot} /> {selectedRun.conclusion.toUpperCase()} <span className={styles.signalMuted}>/ ATTEMPT {selectedRun.attempt}</span></span>
            </div>
          </section>

          <div className={styles.detailGrid}>
            <section className={styles.panel} aria-labelledby="evidence-heading">
              <div className={styles.panelHeading}>
                <div>
                  <span className={styles.sectionEyebrow}><span className={styles.sectionIndex}>01</span> INPUT SIGNAL</span>
                  <h2 id="evidence-heading">Log evidence <span className={styles.headingDim}>/ failed step</span></h2>
                </div>
                <span className={styles.lineCount}><span className={styles.byteDot} />{analysis.excerptBytes.toLocaleString()} B</span>
              </div>
              <div className={styles.terminalHeader}>
                <div className={styles.terminalDots}><span /><span /><span /></div>
                <span>JOB / {selectedRun.failedJob.toUpperCase()}</span>
                <span className={styles.terminalReadOnly}>SANITIZED</span>
              </div>
              <div className={styles.logWindow} role="log" aria-label="Sanitized failure log excerpt">
                {analysis.excerptLines.map((line) => (
                  <div className={`${styles.logLine} ${line.text.toLowerCase().includes("error") ? styles.logError : ""}`} key={line.number}>
                    <span className={styles.lineNumber}>{line.number}</span>
                    <code>{line.text}</code>
                  </div>
                ))}
              </div>
              <div className={styles.privacyNote}><span>⛨</span> Sanitized excerpt <span className={styles.privacyBullet}>·</span> 16 KB limit <span className={styles.privacyBullet}>·</span> Full logs not stored</div>
            </section>

            <div className={styles.rightColumn}>
              <section className={styles.panel} aria-labelledby="suspects-heading">
                <div className={styles.panelHeading}>
                  <div>
                    <span className={styles.sectionEyebrow}><span className={styles.sectionIndex}>02</span> CORRELATION</span>
                    <h2 id="suspects-heading">Suspect files</h2>
                  </div>
                  <span className={styles.fileCount}>{String(analysis.suspectFiles.length).padStart(2, "0")} MATCHED</span>
                </div>
                {analysis.suspectFiles.length ? (
                  <ul className={styles.fileList}>
                    {analysis.suspectFiles.map((file, index) => (
                      <li className={styles.fileItem} key={file.path}>
                        <span className={styles.fileRank}>{String(index + 1).padStart(2, "0")}</span>
                        <span className={styles.fileGlyph}>{file.path.endsWith(".ts") ? "TS" : "··"}</span>
                        <span className={styles.fileDetails}>
                          <strong>{file.path.split("/").at(-1)}<span className={styles.filePath}>{file.path.slice(0, Math.max(0, file.path.lastIndexOf("/") + 1))}</span></strong>
                          <span className={styles.fileReason}>{file.reason}</span>
                        </span>
                        <span className={styles.changeCount}>
                          <span className={styles.changePlus}>+</span>{selectedRun.changedFiles.find((changed) => changed.path === file.path)?.additions ?? 0}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.emptyState}>No changed file matched the available log evidence.</p>
                )}
              </section>

              <section className={styles.panel} aria-labelledby="steps-heading">
                <div className={styles.panelHeading}>
                  <div>
                    <span className={styles.sectionEyebrow}><span className={styles.sectionIndex}>03</span> OPERATOR PLAYBOOK</span>
                    <h2 id="steps-heading">Next moves</h2>
                  </div>
                  <span className={styles.playbookGlyph}>↗</span>
                </div>
                <ol className={styles.stepsList}>
                  {analysis.nextSteps.map((step, index) => (
                    <li key={step}>
                      <span className={styles.stepIndex}>{String(index + 1).padStart(2, "0")}</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          </div>

          <footer className={styles.footer} id="how-it-works">
            <span><span className={styles.footerMark}>F</span> ADVISORY ONLY <span className={styles.footerSep}>/</span> No reruns, writes, or repository changes.</span>
            <span><span className={styles.footerVersion}>{analysis.promptVersion}</span><span className={styles.footerSep}>/</span> {mode === "demo" ? "LOCAL DEMO" : "DATABASE"} · {runTimestamp(selectedRun.createdAt)}</span>
          </footer>
        </div>
      </section>
    </main>
  );
}
