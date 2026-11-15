/** Formatting is timezone-aware everywhere, because the product is about time. */

function parts(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(
    new Date(iso),
  );
}

export function formatDate(iso: string, timeZone: string): string {
  return parts(iso, timeZone, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(iso: string, timeZone: string): string {
  const date = parts(iso, timeZone, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const time = parts(iso, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date} · ${time}`;
}

export function formatTime(iso: string, timeZone: string): string {
  return parts(iso, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatShortDate(iso: string, timeZone: string): string {
  return parts(iso, timeZone, { day: "2-digit", month: "short" });
}

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** "Today" and "Yesterday" are computed in the conversation's timezone. */
export function formatRelativeDay(
  iso: string,
  timeZone: string,
  now: Date,
): string {
  const then = new Date(iso);
  const today = dayKey(now, timeZone);
  const target = dayKey(then, timeZone);
  if (target === today) return "Today";
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (target === dayKey(yesterday, timeZone)) return "Yesterday";
  return formatShortDate(iso, timeZone);
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * `Intl` canonicalises a few zones to older names. The API and the ledger use
 * whatever the browser sent, so this only changes what the header prints.
 */
const ZONE_LABELS: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Europe/Kiev": "Europe/Kyiv",
};

export function displayZone(zone: string): string {
  return ZONE_LABELS[zone] ?? zone;
}

export function formatLatency(ms: number | null): string {
  if (ms === null || ms <= 0) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatTokens(input: number | null, output: number | null): string {
  if (input === null && output === null) return "—";
  const left = input === null ? "?" : String(input);
  const right = output === null ? "?" : String(output);
  return `${left} in / ${right} out`;
}

export function titleCase(value: string): string {
  return value.length === 0
    ? value
    : value[0].toUpperCase() + value.slice(1).replace(/_/g, " ");
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}
