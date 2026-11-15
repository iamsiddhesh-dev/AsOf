import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { claimQualifier } from "../lib/claims.js";
import { formatDate, plural } from "../lib/format.js";
import type {
  ClaimPage,
  ClaimStatus,
  SubjectSummary,
} from "../lib/types.js";
import { StatusChip } from "./Status.js";

type StatusFilter = ClaimStatus | "all";

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "superseded", label: "Superseded" },
  { value: "all", label: "All" },
];

type Props = {
  timezone: string;
  refreshToken: number;
  onOpenClaim: (claimId: string) => void;
};

function valueOf(claim: { value: string | null }): string {
  if (claim.value === null) return "—";
  return claim.value;
}

export function LedgerView({ timezone, refreshToken, onOpenClaim }: Props) {
  const [status, setStatus] = useState<StatusFilter>("active");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [subject, setSubject] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);
  const [page, setPage] = useState<ClaimPage | null>(null);
  const [subjects, setSubjects] = useState<SubjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void api
      .listClaims({
        status,
        subject,
        q: debouncedQuery.length === 0 ? null : debouncedQuery,
        limit,
      })
      .then((body) => {
        if (!cancelled) setPage(body);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "could not read the ledger");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [status, subject, debouncedQuery, limit, refreshToken]);

  useEffect(() => {
    let cancelled = false;
    void api
      .listSubjects()
      .then((body) => {
        if (!cancelled) setSubjects(body.subjects);
      })
      .catch(() => {
        // The table still works without the subject index.
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  const claims = page?.claims ?? [];
  const total = page?.total ?? 0;
  const filtered = debouncedQuery.length > 0 || subject !== null;
  const ledgerEmpty = subjects.length === 0 && total === 0 && !filtered;

  function chooseStatus(next: StatusFilter): void {
    setStatus(next);
    setLimit(50);
  }

  function chooseSubject(next: string | null): void {
    setSubject(next);
    setLimit(50);
  }

  return (
    <div className="ledger">
      <div className="ledger-scroll">
        <div className="column-wide">
          <header className="doc-head">
            <div className="doc-kicker">The ledger</div>
            <h1 className="doc-title">Claims</h1>
            <p className="doc-lede">
              Each row is a sentence the ledger stands behind, with the page that
              said it and the day it was seen. A changed value is superseded, not
              deleted, so the history stays readable.
            </p>
          </header>

          <div className="ledger-filters">
            <div className="search-field">
              <label className="visually-hidden" htmlFor="claim-search">
                Search claims
              </label>
              <input
                id="claim-search"
                type="search"
                value={query}
                placeholder="Search subject, attribute, or value"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(50);
                }}
              />
            </div>

            <div className="segmented" role="group" aria-label="Claim status">
              {STATUS_FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={
                    status === option.value ? "segment is-active" : "segment"
                  }
                  onClick={() => chooseStatus(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {subjects.length > 0 ? (
            <div className="subject-strip" aria-label="Subjects in the ledger">
              <button
                type="button"
                className={subject === null ? "subject-chip is-active" : "subject-chip"}
                onClick={() => chooseSubject(null)}
              >
                All subjects
              </button>
              {subjects.map((entry) => (
                <button
                  key={entry.subject}
                  type="button"
                  className={
                    subject !== null &&
                    subject.toLowerCase() === entry.subject.toLowerCase()
                      ? "subject-chip is-active"
                      : "subject-chip"
                  }
                  onClick={() => chooseSubject(entry.subject)}
                  title={`${entry.active} active · ${entry.superseded} superseded`}
                >
                  {entry.subject}
                  <span className="subject-count">{entry.active + entry.superseded}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="ledger-summary">
            <span>
              {loading
                ? "Reading the ledger…"
                : `${plural(total, "claim")}${filtered ? " matching" : ""}`}
            </span>
            {total > claims.length ? (
              <span className="ledger-summary-note">
                showing {claims.length}
              </span>
            ) : null}
          </div>

          {error !== null ? (
            <div className="inline-error" role="alert">
              {error}
            </div>
          ) : null}

          {!loading && claims.length === 0 ? (
            <div className="ledger-empty">
              {ledgerEmpty ? (
                <>
                  <p className="ledger-empty-title">The ledger is empty.</p>
                  <p>
                    Claims are written only from grounded search answers, and
                    only when the quote appears verbatim in the cited page. Ask
                    something that needs the web and this view fills in.
                  </p>
                </>
              ) : (
                <>
                  <p className="ledger-empty-title">No claims match this view.</p>
                  <p>
                    Nothing here has been superseded or renamed in a way that
                    matches these filters.
                  </p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setQuery("");
                      setDebouncedQuery("");
                      chooseSubject(null);
                      chooseStatus("active");
                    }}
                  >
                    Clear filters
                  </button>
                </>
              )}
            </div>
          ) : null}

          {claims.length > 0 ? (
            <div className="table-scroll">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th scope="col">Subject</th>
                    <th scope="col">Attribute</th>
                    <th scope="col">Value</th>
                    <th scope="col">Status</th>
                    <th scope="col">Observed</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.map((claim) => (
                    <tr
                      key={claim.id}
                      className="claim-row"
                      tabIndex={0}
                      aria-label={`Open claim: ${claim.subject} ${claim.attribute}`}
                      onClick={() => onOpenClaim(claim.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onOpenClaim(claim.id);
                        }
                      }}
                    >
                      <td className="cell-subject">{claim.subject}</td>
                      <td className="cell-attribute">{claim.attribute}</td>
                      <td className="cell-value">
                        <span className="claim-value">{valueOf(claim)}</span>
                        {claimQualifier(claim) !== null ? (
                          <span className="claim-qualifier">{claimQualifier(claim)}</span>
                        ) : null}
                      </td>
                      <td>
                        <StatusChip status={claim.status} />
                      </td>
                      <td className="cell-date">
                        {formatDate(claim.observedAt, timezone)}
                      </td>
                      <td className="cell-source">
                        {claim.source === null ? (
                          <span className="muted">no source</span>
                        ) : (
                          <span title={claim.source.title ?? claim.source.url}>
                            {claim.source.domain}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {total > claims.length ? (
            <div className="ledger-more">
              <button
                type="button"
                className="text-button"
                onClick={() => setLimit((value) => Math.min(value + 50, 200))}
              >
                Load more
              </button>
            </div>
          ) : null}

          <div className="reader-tail" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
