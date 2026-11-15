/**
 * Two real questions: one that stores claims, then a recheck in a **new**
 * conversation, so the recheck proves memory is global.
 *
 *   npm run smoke:recheck
 *
 * Spends two searches and up to four model requests. `npm run doctor` first.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import {
  createConversation,
  listTurns,
} from "../src/conversations/repository.js";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

const FIRST = process.argv[2] ?? "what is hubspot starter pricing?";
const SECOND = process.argv[3] ?? "has hubspot pricing changed?";
const TIMEZONE = process.env.DEFAULT_TIMEZONE ?? "Asia/Kolkata";

type ClaimSummary = {
  inserted: number;
  superseded: number;
  dropped: number;
  reason: string | null;
};

type AskBody = {
  answer?: string;
  grounded?: boolean | null;
  citations?: Array<{ id: string; title: string; url: string }>;
  steps?: Array<{ action: string; status: string; detail: string }>;
  claims?: ClaimSummary;
  recheck?: {
    status: string;
    verdicts: Array<{
      status: string;
      subject: string;
      attribute: string;
      previousValue: string | null;
      value: string | null;
      reason: string;
    }>;
  } | null;
  model?: string | null;
  error?: string;
  hint?: string;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-recheck-smoke-"));
const db = openDatabase(path.join(dir, "smoke.db"));

async function ask(app: ReturnType<typeof createApp>, conversationId: string, text: string) {
  const response = await app.request(
    `http://localhost/api/conversations/${conversationId}/ask`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  return { status: response.status, body: (await response.json()) as AskBody };
}

try {
  migrate(db);
  const app = createApp(db);

  console.log("");
  console.log("AsOf live recheck");
  console.log("");

  const first = createConversation(db, {
    title: "pricing",
    timezone: TIMEZONE,
    now: new Date(),
  });
  const before = await ask(app, first.id, FIRST);

  console.log(`ask 1     ${before.status}  ${FIRST}`);
  console.log(`claims    ${before.body.claims?.inserted ?? 0} stored, ${before.body.claims?.dropped ?? 0} dropped${before.body.claims?.reason === null ? "" : ` (${before.body.claims?.reason})`}`);
  console.log("");

  if (before.status !== 200 || before.body.claims === undefined || before.body.claims.inserted === 0) {
    console.log("FAIL  the first answer stored no claims, so there is nothing to recheck");
    console.log(before.body.answer ?? before.body.error ?? "");
    process.exitCode = 1;
  } else {
    const second = createConversation(db, {
      title: "recheck",
      timezone: TIMEZONE,
      now: new Date(),
    });
    const after = await ask(app, second.id, SECOND);

    console.log(`ask 2     ${after.status}  ${SECOND}`);
    console.log(
      `steps     ${(after.body.steps ?? []).map((step) => `${step.action}:${step.status}`).join(", ") || "(none)"}`,
    );
    console.log(`grounded  ${after.body.grounded === null ? "n/a" : after.body.grounded}`);
    console.log("");
    console.log(after.body.answer ?? after.body.error ?? "(empty answer)");
    console.log("");

    for (const citation of after.body.citations ?? []) {
      console.log(`  [${citation.id}] ${citation.title} — ${citation.url}`);
    }

    console.log("");
    for (const verdict of after.body.recheck?.verdicts ?? []) {
      console.log(
        `verdict   ${verdict.status}: ${verdict.subject} ${verdict.attribute} (${verdict.previousValue ?? "?"} -> ${verdict.value ?? "unchanged"})${verdict.reason === "" ? "" : ` — ${verdict.reason}`}`,
      );
    }

    const claims = after.body.claims;
    console.log("");
    console.log(
      `claims    ${claims?.inserted ?? 0} stored, ${claims?.superseded ?? 0} superseded${claims?.reason === null ? "" : ` (${claims?.reason})`}`,
    );
    console.log(
      `ledger    ask 2 wrote ${listTurns(db, second.id).length} turn(s)`,
    );
    console.log("");

    if (after.status !== 200 || after.body.recheck?.status !== "done") {
      console.log("FAIL  the recheck did not complete");
      process.exitCode = 1;
    } else if (after.body.grounded !== true) {
      console.log("FAIL  the recheck answer carried no cited verdict");
      process.exitCode = 1;
    }
  }
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
