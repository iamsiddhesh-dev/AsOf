const MONTHS = [
  { name: "january", short: "jan", number: 1 },
  { name: "february", short: "feb", number: 2 },
  { name: "march", short: "mar", number: 3 },
  { name: "april", short: "apr", number: 4 },
  { name: "may", short: "may", number: 5 },
  { name: "june", short: "jun", number: 6 },
  { name: "july", short: "jul", number: 7 },
  { name: "august", short: "aug", number: 8 },
  { name: "september", short: "sep", number: 9 },
  { name: "october", short: "oct", number: 10 },
  { name: "november", short: "nov", number: 11 },
  { name: "december", short: "dec", number: 12 },
] as const;

const MONTH_NAMES = MONTHS.map((month) => month.name);
const MONTH_LOOKUP = new Map<string, number>();
for (const month of MONTHS) {
  MONTH_LOOKUP.set(month.name, month.number);
  MONTH_LOOKUP.set(month.short, month.number);
}
MONTH_LOOKUP.set("sept", 9);

const MONTH_PATTERN = [
  ...MONTHS.flatMap((month) => [month.name, month.short]),
  "sept",
].join("|");

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const WEEKDAY_LOOKUP = new Map<string, number>(
  WEEKDAYS.map((day, index) => [day, index]),
);

export type DateDirection = "past" | "future" | "nearest";

export type ResolvedRange = {
  start: string;
  end: string;
  label: string;
};

export type ResolveDateOptions = {
  now: Date;
  timezone: string;
  direction?: DateDirection;
  lastAnswerAt?: string | null;
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = new Map(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    year: values.get("year") ?? 1970,
    month: values.get("month") ?? 1,
    day: values.get("day") ?? 1,
    hour: values.get("hour") ?? 0,
    minute: values.get("minute") ?? 0,
    second: values.get("second") ?? 0,
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.trunc(date.getTime() / 1000) * 1000;
}

function zonedMidnightUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day);
  const firstOffset = timeZoneOffsetMs(new Date(utcGuess), timeZone);
  let result = utcGuess - firstOffset;
  const secondOffset = timeZoneOffsetMs(new Date(result), timeZone);
  if (secondOffset !== firstOffset) {
    result = utcGuess - secondOffset;
  }
  return new Date(result);
}

function addLocalDays(parts: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function shiftMonth(year: number, month: number, delta: number): DateParts {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: 1,
  };
}

function validYmd(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function monthLabel(month: number): string {
  const name = MONTH_NAMES[month - 1] ?? "unknown";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function formatDay(year: number, month: number, day: number): string {
  return `${day} ${monthLabel(month)} ${year}`;
}

function dayRange(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): ResolvedRange {
  const next = addLocalDays({ year, month, day }, 1);
  return {
    start: zonedMidnightUtc(year, month, day, timeZone).toISOString(),
    end: zonedMidnightUtc(next.year, next.month, next.day, timeZone).toISOString(),
    label: formatDay(year, month, day),
  };
}

function weekRange(
  nowParts: ZonedParts,
  weekOffset: number,
  timeZone: string,
): ResolvedRange {
  const currentDay = new Date(
    Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day),
  ).getUTCDay();
  const daysFromMonday = (currentDay + 6) % 7;
  const startParts = addLocalDays(
    {
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
    },
    -daysFromMonday + weekOffset * 7,
  );
  const endParts = addLocalDays(startParts, 7);

  return {
    start: zonedMidnightUtc(
      startParts.year,
      startParts.month,
      startParts.day,
      timeZone,
    ).toISOString(),
    end: zonedMidnightUtc(
      endParts.year,
      endParts.month,
      endParts.day,
      timeZone,
    ).toISOString(),
    label: `week of ${formatDay(startParts.year, startParts.month, startParts.day)}`,
  };
}

function monthRange(
  year: number,
  month: number,
  monthOffset: number,
  timeZone: string,
): ResolvedRange {
  const start = shiftMonth(year, month, monthOffset);
  const end = shiftMonth(year, month, monthOffset + 1);
  return {
    start: zonedMidnightUtc(start.year, start.month, 1, timeZone).toISOString(),
    end: zonedMidnightUtc(end.year, end.month, 1, timeZone).toISOString(),
    label: `${monthLabel(start.month)} ${start.year}`,
  };
}

function inferYear(
  month: number,
  day: number,
  nowParts: ZonedParts,
  direction: DateDirection,
): number | null {
  const candidates = [nowParts.year - 1, nowParts.year, nowParts.year + 1].filter(
    (year) => validYmd(year, month, day),
  );
  if (candidates.length === 0) {
    return null;
  }

  const today = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  const asUtc = (year: number): number => Date.UTC(year, month - 1, day);

  if (direction === "future") {
    return (
      candidates.find((year) => asUtc(year) >= today) ??
      candidates[candidates.length - 1] ??
      null
    );
  }

  if (direction === "past") {
    const past = candidates.filter((year) => asUtc(year) <= today);
    return past[past.length - 1] ?? candidates[0] ?? null;
  }

  return (
    candidates
      .slice()
      .sort((left, right) => Math.abs(asUtc(left) - today) - Math.abs(asUtc(right) - today))[0] ??
    null
  );
}

export function resolveDateRange(
  input: string,
  options: ResolveDateOptions,
): ResolvedRange | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (text.length === 0) {
    return null;
  }

  const nowParts = getZonedParts(options.now, options.timezone);
  const direction = options.direction ?? "past";
  const lastAnswerAt = options.lastAnswerAt ?? null;

  if (/\b(?:since then|since the last answer|since my last answer)\b/.test(text)) {
    if (lastAnswerAt === null) {
      return null;
    }
    const start = new Date(lastAnswerAt);
    if (Number.isNaN(start.getTime())) {
      return null;
    }
    return {
      start: start.toISOString(),
      end: options.now.toISOString(),
      label: "since the last answer",
    };
  }

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (validYmd(year, month, day)) {
      return dayRange(year, month, day, options.timezone);
    }
    return null;
  }

  if (/\btoday\b/.test(text)) {
    return dayRange(nowParts.year, nowParts.month, nowParts.day, options.timezone);
  }

  if (/\byesterday\b/.test(text)) {
    const parts = addLocalDays(
      { year: nowParts.year, month: nowParts.month, day: nowParts.day },
      -1,
    );
    return dayRange(parts.year, parts.month, parts.day, options.timezone);
  }

  if (/\btomorrow\b/.test(text)) {
    const parts = addLocalDays(
      { year: nowParts.year, month: nowParts.month, day: nowParts.day },
      1,
    );
    return dayRange(parts.year, parts.month, parts.day, options.timezone);
  }

  if (/\bthis week\b/.test(text)) {
    return weekRange(nowParts, 0, options.timezone);
  }

  if (/\blast week\b/.test(text)) {
    return weekRange(nowParts, -1, options.timezone);
  }

  if (/\bthis month\b/.test(text)) {
    return monthRange(nowParts.year, nowParts.month, 0, options.timezone);
  }

  if (/\blast month\b/.test(text)) {
    return monthRange(nowParts.year, nowParts.month, -1, options.timezone);
  }

  const lastDays = text.match(/\b(?:last|past)\s+(\d{1,2})\s+days?\b/);
  if (lastDays) {
    const count = Number(lastDays[1]);
    if (count >= 1 && count <= 3650) {
      const startParts = addLocalDays(
        { year: nowParts.year, month: nowParts.month, day: nowParts.day },
        -(count - 1),
      );
      return {
        start: zonedMidnightUtc(
          startParts.year,
          startParts.month,
          startParts.day,
          options.timezone,
        ).toISOString(),
        end: options.now.toISOString(),
        label: `last ${count} days`,
      };
    }
  }

  const lastWeekday = text.match(
    /\blast\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
  );
  if (lastWeekday) {
    const target = WEEKDAY_LOOKUP.get(lastWeekday[1] ?? "");
    if (target !== undefined) {
      const current = new Date(
        Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day),
      ).getUTCDay();
      let diff = (current - target + 7) % 7;
      if (diff === 0) {
        diff = 7;
      }
      const parts = addLocalDays(
        { year: nowParts.year, month: nowParts.month, day: nowParts.day },
        -diff,
      );
      return dayRange(parts.year, parts.month, parts.day, options.timezone);
    }
  }

  const dayMonth = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN})(?:\\s+(\\d{4}))?\\b`,
  ).exec(text);
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = MONTH_LOOKUP.get(dayMonth[2] ?? "");
    if (month !== undefined) {
      const year = dayMonth[3] ? Number(dayMonth[3]) : inferYear(month, day, nowParts, direction);
      if (year !== null && validYmd(year, month, day)) {
        return dayRange(year, month, day, options.timezone);
      }
    }
  }

  const monthDay = new RegExp(
    `\\b(?:the\\s+)?(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  ).exec(text);
  if (monthDay) {
    const month = MONTH_LOOKUP.get(monthDay[1] ?? "");
    const day = Number(monthDay[2]);
    if (month !== undefined) {
      const year = monthDay[3] ? Number(monthDay[3]) : inferYear(month, day, nowParts, direction);
      if (year !== null && validYmd(year, month, day)) {
        return dayRange(year, month, day, options.timezone);
      }
    }
  }

  return null;
}
