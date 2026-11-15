import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { claimQualifier } from "../lib/claims.js";
import { formatDate, formatDateTime } from "../lib/format.js";
import type { Claim, InspectorTarget } from "../lib/types.js";
import { StatusChip } from "./Status.js";

type ClaimState = {
  loading: boolean;
  claim: Claim | null;
  history: Claim[];
  error: string | null;
};

type Props = {
  target: InspectorTarget;
  timezone: string;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
};

const SNIPPET_LIMIT = 520;

/**
 * Evidence snippets can be a whole page section. Show the opening verbatim and
 * let the reader ask for the rest, rather than dumping markup into the panel.
 */
function Snippet({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > SNIPPET_LIMIT;

  return (
    <>
      <blockquote className="inspector-quote">
        {long && !expanded
          ? `${text.slice(0, SNIPPET_LIMIT).trimEnd()}…`
          : text}
      </blockquote>
      {long ? (
        <button
          type="button"
          className="text-button snippet-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Read the full snippet"}
        </button>
      ) : null}
    </>
  );
}

export function Inspector({
  target,
  timezone,
  onClose,
  onOpenConversation,
}: Props) {
  const [state, setState] = useState<ClaimState>({
    loading: target.kind === "claim",
    claim: null,
    history: [],
    error: null,
  });

  useEffect(() => {
    if (target.kind !== "claim") return;

    let cancelled = false;
    setState({ loading: true, claim: null, history: [], error: null });

    void api
      .getClaim(target.claimId)
      .then((body) => {
        if (!cancelled) {
          setState({
            loading: false,
            claim: body.claim,
            history: body.history,
            error: null,
          });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            loading: false,
            claim: null,
            history: [],
            error:
              cause instanceof Error ? cause.message : "could not read this claim",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [target]);

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-head">
        <span className="inspector-kicker">
          {target.kind === "source" ? (
            <>
              Source <span className="cite-badge">{target.source.label}</span>
            </>
          ) : (
            "Claim"
          )}
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close inspector"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      {target.kind === "source" ? (
        <div className="inspector-body">
          <h2 className="inspector-title">
            {target.source.title ?? target.source.domain}
          </h2>
          <div className="inspector-meta">
            <span>{target.source.domain}</span>
            {target.source.publishedAt !== null ? (
              <>
                <span className="dot" aria-hidden="true">
                  ·
                </span>
                <span>
                  published {formatDate(target.source.publishedAt, timezone)}
                </span>
              </>
            ) : null}
            {target.source.fetchedAt !== null ? (
              <>
                <span className="dot" aria-hidden="true">
                  ·
                </span>
                <span>
                  fetched {formatDate(target.source.fetchedAt, timezone)}
                </span>
              </>
            ) : null}
          </div>

          {target.source.snippet !== null ? (
            <Snippet text={target.source.snippet} />
          ) : (
            <p className="inspector-note">No snippet was stored for this source.</p>
          )}

          <a
            className="source-open"
            href={target.source.url}
            target="_blank"
            rel="noreferrer"
          >
            Open page <span aria-hidden="true">↗</span>
          </a>

          <p className="inspector-note">
            This is the evidence the model was allowed to quote. A claim is kept
            only when its quote appears verbatim in this snippet.
          </p>
        </div>
      ) : null}

      {target.kind === "claim" ? (
        <div className="inspector-body">
          {state.loading ? (
            <div className="inspector-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          ) : null}

          {state.error !== null ? (
            <div className="inline-error" role="alert">
              {state.error}
            </div>
          ) : null}

          {state.claim !== null ? (
            <>
              <div className="claim-status-line">
                <StatusChip status={state.claim.status} />
                <span className="claim-observed">
                  observed {formatDate(state.claim.observedAt, timezone)}
                </span>
              </div>

              <h2 className="inspector-title">{state.claim.subject}</h2>
              <div className="inspector-attribute">{state.claim.attribute}</div>
              <div className="inspector-value">{state.claim.value ?? "—"}</div>

              <dl className="facts">
                <div>
                  <dt>Observed</dt>
                  <dd>{formatDateTime(state.claim.observedAt, timezone)}</dd>
                </div>
                <div>
                  <dt>Confidence</dt>
                  <dd>{Math.round(state.claim.confidence * 100)}%</dd>
                </div>
                <div>
                  <dt>Unit</dt>
                  <dd>{claimQualifier(state.claim) ?? "—"}</dd>
                </div>
                <div>
                  <dt>Conversation</dt>
                  <dd>
                    {state.claim.conversationTitle === null ? (
                      "—"
                    ) : (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          onOpenConversation(state.claim?.conversationId ?? "")
                        }
                      >
                        {state.claim.conversationTitle}
                      </button>
                    )}
                  </dd>
                </div>
              </dl>

              <blockquote className="inspector-quote">
                {state.claim.quote}
              </blockquote>

              {state.claim.source !== null ? (
                <a
                  className="claim-source"
                  href={state.claim.source.url}
                  target="_blank"
                  rel="noreferrer"
                  title={state.claim.source.title ?? state.claim.source.url}
                >
                  <span className="claim-source-domain">
                    {state.claim.source.domain}
                  </span>
                  <span className="claim-source-title">
                    {state.claim.source.title ?? "Open source"}
                  </span>
                  <span aria-hidden="true">↗</span>
                </a>
              ) : (
                <p className="inspector-note">No source row is attached.</p>
              )}

              <h3 className="inspector-section">History</h3>
              {state.history.length <= 1 ? (
                <p className="inspector-note">
                  No earlier value recorded. This claim has not been superseded.
                </p>
              ) : (
                <ol className="history">
                  {state.history.map((entry) => {
                    const current = entry.id === state.claim?.id;
                    return (
                      <li
                        key={entry.id}
                        className={current ? "history-item is-current" : "history-item"}
                      >
                        <span className="history-dot" aria-hidden="true" />
                        <div className="history-body">
                          <div className="history-line">
                            <span className="history-date">
                              {formatDate(entry.observedAt, timezone)}
                            </span>
                            <StatusChip status={entry.status} />
                          </div>
                          <div className="history-value">{entry.value ?? "—"}</div>
                          {!current ? (
                            <p className="history-quote">{entry.quote}</p>
                          ) : null}
                          {entry.source !== null ? (
                            <span className="history-source">
                              {entry.source.domain}
                            </span>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}

              <p className="inspector-note">
                History is walked through the supersession link, not by matching
                subject text, so two unrelated price histories stay separate.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
