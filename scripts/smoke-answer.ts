/**
 * One real question through the whole path: Tavily search, model synthesis,
 * citation check, ledger writes. Spends one search credit and one model
 * request, so it is a manual smoke test, not part of `npm test` or `npm run
 * eval`.
 *
 *   npm run smoke:answer
 *
 * `npm run doctor` first; this script assumes the keys and model are valid.
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

const QUESTION = process.argv[2] ?? "what is hubspot starter pricing?";
const TIMEZONE = process.env.DEFAULT_TIMEZONE ?? "Asia/Kolkata";

type AskBody = {
  answer?: string;
  grounded?: boolean | null;
  citations?: Array<{ id: string; title: string; url: string }>;
  steps?: Array<{ action: string; status: string; detail: string }>;
  claims?: {
    inserted: number;
    superseded: number;
    dropped: number;
    reason: string | null;
  };
  model?: string | null;
  latencyMs?: number;
  error?: string;
  hint?: string;
  userTurnId?: string;
  assistantTurnId?: string;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-smoke-"));
const db = openDatabase(path.join(dir, "smoke.db"));

try {
  migrate(db);
  const app = createApp(db);
  const conversation = createConversation(db, {
    title: "smoke",
    timezone: TIMEZONE,
    now: new Date(),
  });

  console.log("");
  console.log(`AsOf live smoke  ·  ${QUESTION}`);
  console.log("");

  const started = Date.now();
  const response = await app.request(
    `http://localhost/api/conversations/${conversation.id}/ask`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: QUESTION }),
    },
  );
  const body = (await response.json()) as AskBody;

  console.log(`http      ${response.status}  (${Date.now() - started} ms wall)`);

  if (response.status !== 200) {
    console.log(`error     ${body.error ?? "unknown"}`);
    if (body.hint !== undefined) {
      console.log(`hint      ${body.hint}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`model     ${body.model ?? "(no model call)"}`);
    console.log(`latency   ${body.latencyMs ?? "?"} ms`);
    console.log(`grounded  ${body.grounded === null ? "n/a" : body.grounded}`);
    console.log(
      `steps     ${(body.steps ?? []).map((step) => `${step.action}:${step.status}`).join(", ") || "(none)"}`,
    );
    console.log("");
    console.log(body.answer ?? "(empty answer)");
    console.log("");

    for (const citation of body.citations ?? []) {
      console.log(`  [${citation.id}] ${citation.title} — ${citation.url}`);
    }

    const turns = listTurns(db, conversation.id);
    console.log("");
    console.log(
      `ledger    ${turns.length} turn(s): ${turns.map((turn) => turn.role).join(", ")}`,
    );
    const claims = body.claims;
    if (claims !== undefined) {
      console.log(
        `claims    ${claims.inserted} stored, ${claims.superseded} superseded, ${claims.dropped} dropped${claims.reason === null ? "" : ` (${claims.reason})`}`,
      );
    }
    console.log("");

    if (body.grounded !== true) {
      console.log("FAIL  the answer did not carry a valid citation");
      process.exitCode = 1;
    }
  }
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
