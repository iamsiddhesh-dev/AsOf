import type { RouteAction, RouteMode } from "../src/router/classify.js";
import type { TurnRole } from "../src/conversations/repository.js";

export type SeedTurn = {
  role: TurnRole;
  content: string;
  createdAt: string;
};

export type Seed =
  | "empty"
  | "demo"
  | {
      turns: SeedTurn[];
      /** Adds an active claim on the first user turn. */
      claim?: boolean;
      /** Adds an active entity set to the conversation state. */
      entitySet?: boolean;
    };

export type ExpectedAnswer = {
  /** Substrings the answer must contain, case-insensitive. */
  contains?: string[];
  /** For honest refusals, where the exact phrasing is the behaviour. */
  matches?: RegExp;
  demo?: boolean;
  grounded?: boolean;
  minCitations?: number;
};

export type EvalCase = {
  id: string;
  question: string;
  seed: Seed;
  /**
   * Supplied by hand. Keyword extraction is a model job that is not built yet,
   * so this case measures the filter, not the extraction.
   */
  keyword?: string;
  note?: string;
  expect: {
    steps: RouteAction[];
    mode?: RouteMode | null;
    blockedBy?: string | null;
    rangeLabel?: string;
    /** Omitted means the answer path for this lane is not built yet. */
    answer?: ExpectedAnswer;
  };
};

const YESTERDAY_10 = "2026-11-14T04:30:00.000Z"; // 14 Nov, 10:00 IST
const MONDAY_9 = "2026-11-09T03:30:00.000Z"; // 9 Nov, 09:00 IST

export const CASES: EvalCase[] = [
  {
    id: "recall-yesterday",
    question: "what did i do yesterday?",
    seed: "demo",
    expect: {
      steps: ["recall"],
      rangeLabel: "14 November 2026",
      answer: { contains: ["CRM tools"], demo: true },
    },
  },
  {
    id: "recall-empty-ledger",
    question: "what did i ask on 3 november?",
    seed: "empty",
    expect: {
      steps: ["recall"],
      rangeLabel: "3 November 2026",
      answer: { matches: /nothing has been stored/i },
    },
  },
  {
    id: "recall-window-before-memory",
    question: "what did i ask on 3 november?",
    seed: {
      turns: [
        {
          role: "user",
          content: "We shortlisted five CRM tools.",
          createdAt: MONDAY_9,
        },
      ],
    },
    expect: {
      steps: ["recall"],
      answer: { matches: /memory starts 9 November 2026/i },
    },
  },
  {
    id: "recall-crosses-conversations",
    question: "what did i ask yesterday?",
    seed: {
      turns: [
        {
          role: "user",
          content: "We shortlisted five CRM tools.",
          createdAt: YESTERDAY_10,
        },
        {
          role: "user",
          content: "We need managed Postgres with daily backups.",
          createdAt: "2026-11-14T05:30:00.000Z",
        },
      ],
    },
    expect: {
      steps: ["recall"],
      answer: {
        contains: ["CRM tools", "managed Postgres"],
      },
    },
  },
  {
    id: "compound-recall-then-recheck",
    question: "what did i ask yesterday? is your answer still correct today?",
    seed: "demo",
    expect: {
      steps: ["recall", "recheck"],
      mode: "claims",
      answer: { matches: /no stored claims/i },
    },
  },
  {
    id: "recheck-claims-with-history",
    question: "has it changed since yesterday?",
    seed: {
      turns: [
        {
          role: "user",
          content: "HubSpot Starter is 20 USD per seat per month.",
          createdAt: YESTERDAY_10,
        },
      ],
      claim: true,
    },
    expect: {
      steps: ["recheck"],
      mode: "claims",
      answer: {
        contains: ["HubSpot", "still 20"],
        grounded: true,
        minCitations: 1,
      },
    },
  },
  {
    id: "recheck-news-with-entity-set",
    question: "has any of them shipped something big since?",
    seed: {
      turns: [
        {
          role: "user",
          content: "We shortlisted five CRM tools.",
          createdAt: YESTERDAY_10,
        },
      ],
      claim: true,
      entitySet: true,
    },
    expect: { steps: ["recheck"], mode: "news" },
  },
  {
    id: "search-factual",
    question: "what is hubspot starter pricing?",
    seed: "empty",
    expect: {
      steps: ["search"],
      answer: {
        contains: ["HubSpot Starter", "20 USD"],
        grounded: true,
        minCitations: 1,
      },
    },
  },
  {
    id: "clarify-pronoun-without-set",
    question: "has any of them changed pricing?",
    seed: "empty",
    expect: {
      steps: [],
      blockedBy: "no_entity_set",
      answer: { matches: /Name the tools or topics/i },
    },
  },
  {
    id: "clarify-stale-recheck",
    question: "is that still true?",
    seed: "empty",
    expect: {
      steps: [],
      blockedBy: "no_prior_answer",
      answer: { matches: /don't have a previous answer/i },
    },
  },
  {
    id: "meta-greeting",
    question: "hello",
    seed: "empty",
    expect: { steps: ["chat"], answer: { matches: /AsOf/ } },
  },
  {
    id: "recall-keyword-filter",
    question: "what did i ask about postgres yesterday?",
    seed: {
      turns: [
        {
          role: "user",
          content: "Managed Postgres with daily backups.",
          createdAt: YESTERDAY_10,
        },
        {
          role: "user",
          content: "CRM pricing looks high.",
          createdAt: "2026-11-14T05:00:00.000Z",
        },
      ],
    },
    keyword: "postgres",
    note: "keyword supplied by hand; extraction is a model job that is not built",
    expect: {
      steps: ["recall"],
      answer: { contains: ["managed Postgres"] },
    },
  },
];
