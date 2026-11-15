import { Hono, type Context } from "hono";
import { config } from "../config.js";
import {
  appendTurn,
  createConversation,
  listConversations,
  type Turn,
} from "../conversations/repository.js";
import type { Db } from "../db/index.js";
import {
  isValidTimeZone,
  localDayAt,
  localWeekday,
  resolveDateRange,
} from "../time/resolve.js";

export type DemoRouteOptions = {
  clock?: () => Date;
};

const DEMO_TITLE = "Demo history";

type JsonObject = Record<string, unknown>;

async function readJson(c: Context): Promise<JsonObject | null> {
  try {
    const value = await c.req.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function mostRecentPastWeekday(base: Date, timezone: string, target: number): number {
  const current = localWeekday(base, timezone);
  const diff = (current - target + 7) % 7;
  return -(diff === 0 ? 7 : diff);
}

type Seed = {
  offsetDays: number;
  hour: number;
  minute: number;
  user: string;
  assistant: string;
};

/**
 * Dates are computed from the clock, never written down. A seed that hardcodes
 * "3 November" is a seed that goes stale and a lie about what the app can do.
 */
function buildSeeds(now: Date, timezone: string): Seed[] {
  return [
    {
      offsetDays: -1,
      hour: 10,
      minute: 0,
      user: "We shortlisted five CRM tools for our 20-person sales team: HubSpot, Salesforce, Pipedrive, Zoho, Freshsales.",
      assistant:
        "Recorded the CRM shortlist: HubSpot, Salesforce, Pipedrive, Zoho, Freshsales. I will treat all five as tracked.",
    },
    {
      offsetDays: mostRecentPastWeekday(now, timezone, 1),
      hour: 9,
      minute: 30,
      user: "Remind me to send the pricing deck to Priya by Friday.",
      assistant: "Noted: pricing deck for Priya, due Friday.",
    },
    {
      offsetDays: mostRecentPastWeekday(now, timezone, 2),
      hour: 16,
      minute: 0,
      user: "We need managed Postgres with daily backups for the new service.",
      assistant:
        "Noted as a requirement you gave me, not a web fact. I will not overwrite it with a vendor page.",
    },
  ];
}

export function demoRoutes(db: Db, options: DemoRouteOptions = {}) {
  const router = new Hono();
  const clock = options.clock ?? (() => new Date());

  router.get("/history", (c) => {
    const conversation = listConversations(db, 200).find(
      (candidate) => candidate.title === DEMO_TITLE,
    );
    return c.json({
      loaded: conversation !== undefined,
      conversation: conversation ?? null,
    });
  });

  /**
   * Loading demo history is explicit, never automatic. A reviewer who gets an
   * answer about a question they never asked reads it as a hallucination.
   */
  router.post("/history", async (c) => {
    const body = (await readJson(c)) ?? {};

    const timezoneValue = body["timezone"];
    const timezone =
      typeof timezoneValue === "string" ? timezoneValue.trim() : config.timezone;
    if (!isValidTimeZone(timezone)) {
      return c.json({ error: "invalid timezone" }, 400);
    }

    const existing = listConversations(db, 200).find(
      (candidate) => candidate.title === DEMO_TITLE,
    );
    if (existing !== undefined) {
      return c.json({ created: false, conversation: existing, turns: [] });
    }

    const now = clock();
    const conversation = createConversation(db, {
      title: DEMO_TITLE,
      timezone,
      now,
    });

    const turns: Turn[] = [];
    for (const seed of buildSeeds(now, timezone)) {
      const at = localDayAt(now, timezone, seed.offsetDays, seed.hour, seed.minute);
      const range = resolveDateRange("today", {
        now: at,
        timezone,
        direction: "past",
      });

      turns.push(
        appendTurn(db, {
          conversationId: conversation.id,
          role: "user",
          content: seed.user,
          createdAt: at.toISOString(),
          resolvedStart: range?.start ?? null,
          resolvedEnd: range?.end ?? null,
          resolvedLabel: range?.label ?? null,
          intent: "demo",
          isDemo: true,
        }),
      );

      turns.push(
        appendTurn(db, {
          conversationId: conversation.id,
          role: "assistant",
          content: seed.assistant,
          createdAt: new Date(at.getTime() + 2_000).toISOString(),
          isDemo: true,
        }),
      );
    }

    const created = listConversations(db, 200).find(
      (candidate) => candidate.id === conversation.id,
    );

    return c.json(
      {
        created: true,
        conversation: created ?? conversation,
        turns,
      },
      201,
    );
  });

  return router;
}
