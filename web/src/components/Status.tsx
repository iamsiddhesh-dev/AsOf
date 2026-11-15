import type { ClaimStatus, StepEvent } from "../lib/types.js";

export function StatusChip({ status }: { status: ClaimStatus }) {
  return (
    <span className={`chip chip-${status}`}>
      <span className="chip-dot" aria-hidden="true" />
      {status}
    </span>
  );
}

const GROUNDED_COPY: Record<
  "yes" | "no" | "none",
  { label: string; title: string }
> = {
  yes: {
    label: "grounded",
    title: "Every citation matches a source this answer actually returned.",
  },
  no: {
    label: "not grounded",
    title:
      "The reply did not contain a citation matching any returned source. Read it as unverified.",
  },
  none: {
    label: "no citations",
    title: "This answer did not search, so there was nothing to cite.",
  },
};

export function GroundedChip({ grounded }: { grounded: boolean | null }) {
  const key = grounded === null ? "none" : grounded ? "yes" : "no";
  const copy = GROUNDED_COPY[key];
  return (
    <span className={`grounded grounded-${key}`} title={copy.title}>
      {copy.label}
    </span>
  );
}

export function StepStatus({ status }: { status: StepEvent["status"] }) {
  if (status === "running") {
    return <span className="step-mark step-running" aria-label="running" />;
  }
  if (status === "done") {
    return (
      <span className="step-mark step-done" aria-label="done">
        ✓
      </span>
    );
  }
  if (status === "blocked") {
    return (
      <span className="step-mark step-blocked" aria-label="blocked">
        ×
      </span>
    );
  }
  return (
    <span className="step-mark step-skipped" aria-label="not built">
      —
    </span>
  );
}
