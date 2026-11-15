import type { Claim } from "./types.js";

/**
 * The unit line under a claim value. A `$20` value does not need "$ / month";
 * a `20` value with currency `USD` does need the unit spelled out.
 */
export function claimQualifier(
  claim: Pick<Claim, "value" | "currency" | "period">,
): string | null {
  const parts: string[] = [];
  const value = claim.value ?? "";

  if (
    claim.currency !== null &&
    claim.currency.trim().length > 0 &&
    !value.includes(claim.currency)
  ) {
    parts.push(claim.currency);
  }

  if (claim.period !== null && claim.period.trim().length > 0) {
    parts.push(`/ ${claim.period}`);
  }

  return parts.length === 0 ? null : parts.join(" ");
}
