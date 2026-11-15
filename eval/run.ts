import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import {
  appendTurn,
  createConversation,
  type Conversation,
} from "../src/conversations/repository.js";
import { emptyConversationState } from "../src/conversations/state.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { CASES, type EvalCase } from "./cases.js";
import { FakeChat, FakeSearch } from "../test/support/fakes.js";

const NOW = new Date(process.env.EVAL_NOW ?? "2026-11-15T10:00:00.000Z");
const TIMEZONE = process.env.EVAL_TIMEZONE ?? "Asia/Kolkata";

type Outcome = { ok: boolean; detail: string };

type Row = {
  id: string;
  plan: Outcome;
  answer: Outcome | null;
  note?: string | undefined;
};

type Decision = {
  steps: Array<{ action: string; mode: string | null }>;
  blockedBy: string | null;
  timeRange: { label: string } | null;
};

type AskBody = {
  answer: string;
  citations: Array<{ id: string; url: string }>;
  grounded: boolean | null;
  demo: boolean;
  steps: Array<{ action: string; status: string }>;
};

function seedTurns(db: Db, history: Conversation, testCase: EvalCase): void {
  const seed = testCase.seed;
  if (seed === "empty" || seed === "demo") {
    return;
  }

  for (const turn of seed.turns) {
    appendTurn(db, {
      conversationId: history.id,
      role: turn.role,
      content: turn.content,
      createdAt: turn.createdAt,
    });
  }

  if (seed.claim !== true) {
    return;
  }

  const turn = db
    .prepare(
      "SELECT id, created_at FROM turns WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 1",
    )
    .get(history.id) as { id: string; created_at: string } | undefined;

  if (turn === undefined) {
    return;
  }

  db.prepare(
    `INSERT INTO claims
      (id, turn_id, conversation_id, subject_text, attribute, claim_type,
       value_json, value_text, unit, currency, period, confidence, source_kind,
       quote, observed_at, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `claim-${turn.id}`,
    turn.id,
    history.id,
    "HubSpot",
    "starter_price",
    "price",
    JSON.stringify({ amount: 20 }),
    "20",
    "USD/seat/month",
    "USD",
    "month",
    0.9,
    "web",
    "HubSpot Starter is 20 USD per seat per month.",
    turn.created_at,
    `hash-${turn.id}`,
    turn.created_at,
  );
}

async function prepare(
  db: Db,
  app: ReturnType<typeof createApp>,
  testCase: EvalCase,
): Promise<Conversation> {
  if (testCase.seed === "demo") {
    await app.request("http://localhost/api/demo/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone: TIMEZONE }),
    });
  } else if (testCase.seed !== "empty") {
    const history = createConversation(db, {
      title: "eval history",
      timezone: TIMEZONE,
      now: NOW,
    });
    seedTurns(db, history, testCase);
  }

  // The question is always asked in a brand-new conversation, so recall and
  // recheck have to reach history the user stored elsewhere.
  const anchor = createConversation(db, {
    title: "eval question",
    timezone: TIMEZONE,
    now: NOW,
  });

  if (testCase.seed !== "empty" && testCase.seed !== "demo" && testCase.seed.entitySet === true) {
    const state = {
      ...emptyConversationState(),
      activeEntitySet: {
        id: "set-1",
        name: "crm shortlist",
        members: ["hubspot", "salesforce", "pipedrive"],
      },
    };
    db.prepare("UPDATE conversations SET state_json = ? WHERE id = ?").run(
      JSON.stringify(state),
      anchor.id,
    );
  }

  return anchor;
}

function checkPlan(decision: Decision, testCase: EvalCase): Outcome {
  const actualSteps = decision.steps.map((step) => step.action).join(",");
  const expectedSteps = testCase.expect.steps.join(",");

  if (actualSteps !== expectedSteps) {
    return {
      ok: false,
      detail: `steps ${actualSteps || "(none)"} != ${expectedSteps || "(none)"}`,
    };
  }

  const recheckStep = decision.steps.find((step) => step.action === "recheck");
  if (
    testCase.expect.mode !== undefined &&
    (recheckStep?.mode ?? null) !== testCase.expect.mode
  ) {
    return {
      ok: false,
      detail: `mode ${recheckStep?.mode ?? "null"} != ${testCase.expect.mode}`,
    };
  }

  if (
    testCase.expect.blockedBy !== undefined &&
    decision.blockedBy !== testCase.expect.blockedBy
  ) {
    return {
      ok: false,
      detail: `blockedBy ${decision.blockedBy ?? "null"} != ${testCase.expect.blockedBy}`,
    };
  }

  if (
    testCase.expect.rangeLabel !== undefined &&
    decision.timeRange?.label !== testCase.expect.rangeLabel
  ) {
    return {
      ok: false,
      detail: `range ${decision.timeRange?.label ?? "null"} != ${testCase.expect.rangeLabel}`,
    };
  }

  return { ok: true, detail: actualSteps || "clarify" };
}

function checkAnswer(body: AskBody, testCase: EvalCase): Outcome {
  const expected = testCase.expect.answer;
  if (expected === undefined) {
    return { ok: false, detail: "no expectation" };
  }

  if (expected.demo !== undefined && body.demo !== expected.demo) {
    return { ok: false, detail: `demo ${body.demo} != ${expected.demo}` };
  }

  if (expected.grounded !== undefined && body.grounded !== expected.grounded) {
    return {
      ok: false,
      detail: `grounded ${body.grounded} != ${expected.grounded}`,
    };
  }

  if (
    expected.minCitations !== undefined &&
    body.citations.length < expected.minCitations
  ) {
    return {
      ok: false,
      detail: `${body.citations.length} citation(s) < ${expected.minCitations}`,
    };
  }

  if (expected.matches !== undefined && !expected.matches.test(body.answer)) {
    return { ok: false, detail: `answer did not match ${expected.matches}` };
  }

  const haystack = body.answer.toLowerCase();
  for (const needle of expected.contains ?? []) {
    if (!haystack.includes(needle.toLowerCase())) {
      return { ok: false, detail: `missing "${needle}"` };
    }
  }

  return {
    ok: true,
    detail: `${body.answer.length} chars, ${body.citations.length} citation(s)`,
  };
}

async function runCase(testCase: EvalCase): Promise<Row> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-eval-"));
  const db = openDatabase(path.join(dir, "eval.db"));

  try {
    migrate(db);
    const app = createApp(db, {
      clock: () => NOW,
      search: new FakeSearch(),
      chat: new FakeChat(),
      model: "fixture-model",
    });
    const anchor = await prepare(db, app, testCase);

    const routeResponse = await app.request(
      `http://localhost/api/conversations/${anchor.id}/route`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: testCase.question }),
      },
    );
    const plan = checkPlan((await routeResponse.json()) as Decision, testCase);

    let answer: Outcome | null = null;
    if (testCase.expect.answer !== undefined) {
      const askResponse = await app.request(
        `http://localhost/api/conversations/${anchor.id}/ask`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: testCase.question,
            keyword: testCase.keyword ?? null,
          }),
        },
      );
      answer = checkAnswer((await askResponse.json()) as AskBody, testCase);
    }

    return { id: testCase.id, plan, answer, note: testCase.note };
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const rows: Row[] = [];
  for (const testCase of CASES) {
    rows.push(await runCase(testCase));
  }

  const planPassed = rows.filter((row) => row.plan.ok).length;
  const answered = rows.filter((row) => row.answer !== null);
  const answerPassed = answered.filter((row) => row.answer?.ok === true).length;
  const planOnly = rows.length - answered.length;

  console.log("");
  console.log(`AsOf eval  ·  now ${NOW.toISOString()}  ·  ${TIMEZONE}`);
  console.log("");

  for (const row of rows) {
    const answerLabel =
      row.answer === null
        ? "answer: not built"
        : `answer ${row.answer.ok ? "pass" : "FAIL"}`;
    console.log(
      `${row.plan.ok ? "pass" : "FAIL"}  ${row.id.padEnd(30)} plan ${row.plan.ok ? "pass" : "FAIL"}  ${answerLabel}`,
    );
    if (!row.plan.ok) {
      console.log(`      ${row.plan.detail}`);
    }
    if (row.answer !== null && !row.answer.ok) {
      console.log(`      ${row.answer.detail}`);
    }
    if (row.note !== undefined) {
      console.log(`      note: ${row.note}`);
    }
  }

  console.log("");
  console.log(`plan    ${planPassed}/${rows.length}`);
  console.log(`answer  ${answerPassed}/${answered.length}   (${planOnly} case(s) plan-only)`);
  console.log("");

  if (planPassed !== rows.length) {
    console.log("plan failures are regressions and fail the run");
    process.exitCode = 1;
  }
}

await main();
