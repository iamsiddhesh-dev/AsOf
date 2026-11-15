import { formatLatency, plural, titleCase } from "../lib/format.js";
import type {
  AnswerStep,
  ClaimsSummary,
  Turn,
} from "../lib/types.js";
import { GroundedChip, StepStatus } from "./Status.js";

export type LiveReceipt = {
  grounded: boolean | null;
  steps: AnswerStep[];
  claims: ClaimsSummary;
  claimsStatus: "done" | "failed" | "skipped";
};

/**
 * The server decides `grounded` by looking for an `[sN]` that matches a
 * returned source. A stored turn does not carry that flag, so re-deriving it
 * from the stored answer and its stored citations is the same rule, not a
 * guess. Fresh answers use the flag the server actually returned.
 */
export function derivedGrounded(turn: Turn): boolean | null {
  if (turn.role !== "assistant" || turn.sources.length === 0) {
    return null;
  }
  const labels = new Set(turn.sources.map((source) => source.label));
  for (const match of turn.content.matchAll(/\[(s\d+)\]/g)) {
    const label = match[1];
    if (label !== undefined && labels.has(label)) {
      return true;
    }
  }
  return false;
}

function claimsLabel(
  claimsStatus: string,
  claims?: ClaimsSummary,
): string {
  if (claimsStatus === "failed") return "claims failed";
  if (claimsStatus === "skipped") return "no claims";
  if (claimsStatus === "pending") return "claims pending";

  if (claims === undefined) return "claims stored";

  const parts: string[] = [];
  if (claims.inserted > 0) parts.push(`${plural(claims.inserted, "claim")} stored`);
  if (claims.superseded > 0) {
    parts.push(`${plural(claims.superseded, "claim")} superseded`);
  }
  if (claims.dropped > 0) parts.push(`${claims.dropped} dropped`);
  return parts.length === 0 ? "no new claims" : parts.join(" · ");
}

type Props = {
  turn: Turn;
  live?: LiveReceipt | null;
};

export function Receipt({ turn, live }: Props) {
  const grounded = live === undefined || live === null
    ? derivedGrounded(turn)
    : live.grounded;
  const claimsStatus = live?.claimsStatus ?? turn.claimsStatus;

  return (
    <footer className="receipt">
      <div className="receipt-line">
        <span className="receipt-intent" title="Route the question took">
          {turn.intent === null ? "answer" : titleCase(turn.intent)}
        </span>

        {turn.resolvedLabel !== null ? (
          <>
            <span className="receipt-sep" aria-hidden="true">
              /
            </span>
            <span className="receipt-window" title="Resolved date window">
              {turn.resolvedLabel}
            </span>
          </>
        ) : null}

        <span className="receipt-sep" aria-hidden="true">
          /
        </span>
        <span title="Sources returned for this answer">
          {turn.sources.length === 0
            ? "no sources"
            : plural(turn.sources.length, "source")}
        </span>

        <span className="receipt-sep" aria-hidden="true">
          /
        </span>
        <GroundedChip grounded={grounded} />

        {turn.model !== null ? (
          <>
            <span className="receipt-sep" aria-hidden="true">
              /
            </span>
            <span className="receipt-model" title={turn.model}>
              {turn.model}
            </span>
          </>
        ) : null}

        {turn.latencyMs !== null ? (
          <>
            <span className="receipt-sep" aria-hidden="true">
              /
            </span>
            <span title="Wall time for the whole plan">{formatLatency(turn.latencyMs)}</span>
          </>
        ) : null}

        <span className="receipt-sep" aria-hidden="true">
          /
        </span>
        <span title="Claim extraction outcome">{claimsLabel(claimsStatus, live?.claims)}</span>

        {turn.isDemo ? (
          <>
            <span className="receipt-sep" aria-hidden="true">
              /
            </span>
            <span className="receipt-demo">seeded</span>
          </>
        ) : null}
      </div>

      {live !== undefined && live !== null && live.steps.length > 0 ? (
        <ol className="receipt-steps">
          {live.steps.map((step, index) => (
            <li key={`${step.action}-${index}`} className={`receipt-step step-${step.status}`}>
              <StepStatus status={step.status} />
              <span className="receipt-step-action">{step.action}</span>
              <span className="receipt-step-detail">{step.detail}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </footer>
  );
}
