import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDateRange } from "../src/time/resolve.js";

const NOW = new Date("2026-11-15T10:00:00.000Z");
const TIMEZONE = "Asia/Kolkata";

function resolve(text: string, overrides: Partial<Parameters<typeof resolveDateRange>[1]> = {}) {
  return resolveDateRange(text, {
    now: NOW,
    timezone: TIMEZONE,
    ...overrides,
  });
}

describe("date resolution", () => {
  it("resolves local today and yesterday in the conversation timezone", () => {
    assert.deepEqual(resolve("what did I ask today?"), {
      start: "2026-11-14T18:30:00.000Z",
      end: "2026-11-15T18:30:00.000Z",
      label: "15 November 2026",
    });

    assert.deepEqual(resolve("yesterday"), {
      start: "2026-11-13T18:30:00.000Z",
      end: "2026-11-14T18:30:00.000Z",
      label: "14 November 2026",
    });
  });

  it("resolves explicit and natural day references", () => {
    assert.deepEqual(resolve("what did I ask on 3 november?"), {
      start: "2026-11-02T18:30:00.000Z",
      end: "2026-11-03T18:30:00.000Z",
      label: "3 November 2026",
    });

    assert.deepEqual(resolve("2026-11-03"), {
      start: "2026-11-02T18:30:00.000Z",
      end: "2026-11-03T18:30:00.000Z",
      label: "3 November 2026",
    });

    assert.deepEqual(resolve("november 3, 2025"), {
      start: "2025-11-02T18:30:00.000Z",
      end: "2025-11-03T18:30:00.000Z",
      label: "3 November 2025",
    });
  });

  it("resolves the most recent past occurrence when the year is omitted", () => {
    assert.equal(resolve("3 november")?.label, "3 November 2026");

    const january = resolveDateRange("3 november", {
      now: new Date("2027-01-05T10:00:00.000Z"),
      timezone: TIMEZONE,
    });
    assert.equal(january?.label, "3 November 2026");
  });

  it("resolves last friday and calendar weeks", () => {
    assert.deepEqual(resolve("last friday"), {
      start: "2026-11-12T18:30:00.000Z",
      end: "2026-11-13T18:30:00.000Z",
      label: "13 November 2026",
    });

    assert.deepEqual(resolve("last week"), {
      start: "2026-11-01T18:30:00.000Z",
      end: "2026-11-08T18:30:00.000Z",
      label: "week of 2 November 2026",
    });
  });

  it("resolves rolling windows and the conversational anchor", () => {
    assert.deepEqual(
      resolve("prices in the last 7 days"),
      {
        start: "2026-11-08T18:30:00.000Z",
        end: "2026-11-15T10:00:00.000Z",
        label: "last 7 days",
      },
    );

    assert.deepEqual(
      resolve("has anything changed since then?", {
        lastAnswerAt: "2026-11-13T10:00:00.000Z",
      }),
      {
        start: "2026-11-13T10:00:00.000Z",
        end: "2026-11-15T10:00:00.000Z",
        label: "since the last answer",
      },
    );

    assert.equal(resolve("since then"), null);
  });

  it("resolves a rolling window that starts at a named day", () => {
    assert.deepEqual(resolve("since yesterday"), {
      start: "2026-11-13T18:30:00.000Z",
      end: "2026-11-15T10:00:00.000Z",
      label: "since 14 November 2026",
    });

    assert.deepEqual(resolve("has anything changed since 3 november?"), {
      start: "2026-11-02T18:30:00.000Z",
      end: "2026-11-15T10:00:00.000Z",
      label: "since 3 November 2026",
    });
  });

  it("returns null for invalid or missing dates", () => {
    assert.equal(resolve("31 february"), null);
    assert.equal(resolve("no date here"), null);
    assert.equal(resolve(""), null);
  });
});
