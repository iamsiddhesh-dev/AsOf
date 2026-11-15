/**
 * One real question through the streaming endpoint, printing the events as they
 * arrive and measuring time to first token. Spends one search credit and one
 * model request, so it is manual: `npm run doctor` first.
 *
 *   npm run smoke:stream
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

type Citation = { id: string; title: string; url: string };

type DoneBody = {
  answer?: string;
  grounded?: boolean | null;
  citations?: Citation[];
  claims?: { inserted: number; superseded: number; dropped: number; reason: string | null };
  model?: string | null;
  latencyMs?: number;
  error?: string;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-stream-smoke-"));
const db = openDatabase(path.join(dir, "smoke.db"));

try {
  migrate(db);
  const app = createApp(db);
  const conversation = createConversation(db, {
    title: "stream smoke",
    timezone: TIMEZONE,
    now: new Date(),
  });

  console.log("");
  console.log(`AsOf live stream  ·  ${QUESTION}`);
  console.log("");

  const started = Date.now();
  const response = await app.request(
    `http://localhost/api/conversations/${conversation.id}/ask/stream`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: QUESTION }),
    },
  );

  if (response.status !== 200 || response.body === null) {
    console.log(`http      ${response.status}`);
    console.log(await response.text());
    process.exitCode = 1;
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let deltas = 0;
    let deltaChars = 0;
    let firstDeltaAt: number | null = null;
    let done: DoneBody | null = null;
    let failed = false;

    const handle = (frame: string): void => {
      const lines = frame.split("\n");
      const event =
        lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");

      if (data.length === 0) {
        return;
      }

      const body = JSON.parse(data) as Record<string, unknown>;

      if (event === "decision") {
        console.log(`decision  ${String(body["intent"])}`);
      } else if (event === "step") {
        const detail = typeof body["detail"] === "string" ? ` — ${body["detail"]}` : "";
        console.log(`step      ${String(body["action"])}:${String(body["status"])}${detail}`);
      } else if (event === "sources") {
        const citations = (body["citations"] ?? []) as Citation[];
        console.log(`sources   ${citations.length} fetched`);
        for (const citation of citations) {
          console.log(`  [${citation.id}] ${citation.title} — ${citation.url}`);
        }
      } else if (event === "block") {
        console.log(`block     ${String(body["kind"])} (${String(body["text"]).length} chars)`);
      } else if (event === "delta") {
        if (firstDeltaAt === null) {
          firstDeltaAt = Date.now() - started;
        }
        deltas += 1;
        deltaChars += String(body["text"]).length;
      } else if (event === "done") {
        done = body as DoneBody;
      } else if (event === "error") {
        failed = true;
        console.log(`error     ${String(body["message"])}`);
      }
    };

    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        handle(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }

    const wall = Date.now() - started;

    console.log("");
    console.log(
      `delta     ${deltas} chunk(s), ${deltaChars} chars, first at ${firstDeltaAt ?? "—"} ms`,
    );
    console.log(`wall      ${wall} ms`);
    console.log("");

    if (failed || done === null) {
      console.log("FAIL  the stream ended without a done event");
      process.exitCode = 1;
    } else {
      const body = done as DoneBody;
      console.log(body.answer ?? "(empty answer)");
      console.log("");
      console.log(
        `grounded  ${body.grounded === null ? "n/a" : body.grounded}  ·  model ${body.model ?? "(none)"}`,
      );

      const claims = body.claims;
      if (claims !== undefined) {
        console.log(
          `claims    ${claims.inserted} stored, ${claims.superseded} superseded, ${claims.dropped} dropped${claims.reason === null ? "" : ` (${claims.reason})`}`,
        );
      }

      const turns = listTurns(db, conversation.id);
      console.log(
        `ledger    ${turns.length} turn(s): ${turns.map((turn) => turn.role).join(", ")}`,
      );

      if (turns.length !== 2) {
        console.log("FAIL  the stream did not persist both turns");
        process.exitCode = 1;
      }
      if (body.grounded !== true) {
        console.log("FAIL  the answer carried no valid citation");
        process.exitCode = 1;
      }
    }

    console.log("");
  }
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
