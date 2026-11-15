/**
 * Smoke test for the models AsOf actually uses, on the prompts it actually
 * sends. Not a benchmark: it answers four narrow questions per model.
 *
 *   1. does the routing call return usable JSON, and the right steps?
 *   2. does the synthesis call cite the source it used?
 *   3. does it invent a number that is not in the evidence?
 *   4. does it refuse when the evidence is empty?
 *
 * It reads the same config the app reads, so a wrong base URL, a dead model ID,
 * or a key from another provider fails here before it fails in a request.
 *
 *   npm run probe:models                 # main and fast providers
 *   npm run probe:models -- --finalists  # repeat each one, plus traps
 *   npm run probe:models -- --models a,b # specific IDs on the main provider
 */
import { config } from "../src/config.js";

type Role = "main" | "fast";

type Candidate = {
  role: Role;
  baseUrl: string;
  apiKey: string | null;
  model: string;
};

type Target = Candidate & { apiKey: string; key: string };

type CallResult =
  | { ok: true; status: number; latency: number; content: string }
  | { ok: false; status: number; latency: number; error: string };

type RouteScore = {
  json: boolean;
  steps: string[] | null;
  note: string;
};

type SynthScore = {
  cites: boolean;
  invented: string | null;
  stale: boolean | null;
  note: string;
};

type ChatBody = {
  choices?: Array<{ message?: { content?: string } }>;
};

type ModelsBody = {
  data?: Array<{ id?: string }>;
};

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

const overrideModels = ((): string[] | null => {
  const inline = process.argv.find((arg) => arg.startsWith("--models="));
  if (inline !== undefined) {
    return inline
      .slice("--models=".length)
      .split(",")
      .map((model) => model.trim())
      .filter((model) => model.length > 0);
  }

  const index = process.argv.indexOf("--models");
  if (index === -1) {
    return null;
  }

  const next = process.argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    console.error("--models needs a comma-separated list");
    process.exit(1);
  }

  return next
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
})();

const candidates: Candidate[] = [
  {
    role: "main",
    baseUrl: stripSlash(config.model.main.baseUrl),
    apiKey: config.model.main.apiKey,
    model: config.model.main.model,
  },
  {
    role: "fast",
    baseUrl: stripSlash(config.model.fast.baseUrl),
    apiKey: config.model.fast.apiKey,
    model: config.model.fast.model,
  },
];

const targets: Target[] = [];

for (const candidate of candidates) {
  const models =
    overrideModels !== null && candidate.role === "main"
      ? overrideModels
      : [candidate.model];

  for (const model of models) {
    const key = `${candidate.baseUrl}|${candidate.apiKey ?? ""}|${model}`;
    if (targets.some((target) => target.key === key)) {
      continue;
    }
    if (candidate.apiKey === null) {
      console.error(`${candidate.role}: ${candidate.baseUrl} has no API key set`);
      process.exit(1);
    }
    targets.push({ ...candidate, apiKey: candidate.apiKey, model, key });
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

function isOpenRouter(baseUrl: string): boolean {
  return /(^|\.)openrouter\.ai$/i.test(hostOf(baseUrl));
}

function headers(provider: Candidate): Record<string, string> {
  const out: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${provider.apiKey ?? ""}`,
  };
  if (isOpenRouter(provider.baseUrl)) {
    out["http-referer"] = "https://github.com/iamsiddhesh-dev/AsOf";
    out["x-title"] = "AsOf model probe";
  }
  return out;
}

function label(provider: Candidate): string {
  return `${provider.role}  ${provider.model}  (${hostOf(provider.baseUrl)})`;
}

const ROUTE_SYSTEM = `You route messages for a temporal agent. Return JSON only, no prose, no code fences.

Schema:
{"steps":[{"action":"recall"|"recheck"|"search"|"chat","query":string|null}],"clarify":string|null}

Rules:
- recall: the user asks what they said or asked before.
- recheck: the user asks whether a previous answer is still true or whether things changed.
- search: factual questions about the world.
- chat: greetings only.
- A message may have several steps, in order.`;

const ROUTE_USER = "what did i ask yesterday? is your answer still correct today?";

const EVIDENCE = `[s1] hubspot.com/pricing (published 2026-11-12): "HubSpot Starter is 20 USD per seat per month."
[s2] crmblog.example (published 2025-03-04): "HubSpot Starter costs 15 USD per seat per month."`;

const SYNTH_SYSTEM =
  "Answer only from the evidence. Cite every claim with its source id like [s1]. Use the most recent source when they disagree. If something is unknown, say so. No preamble.";

const SYNTH_USER = `Question: What does HubSpot Starter cost, and has the price changed?

Evidence:
${EVIDENCE}`;

const ROUTE_CASES: Array<{
  id: string;
  user: string;
  check: (steps: string[]) => boolean;
}> = [
  {
    id: "compound",
    user: ROUTE_USER,
    check: (steps) => steps[0] === "recall" && steps.includes("recheck"),
  },
  {
    id: "search",
    user: "what is hubspot starter pricing?",
    check: (steps) => steps[0] === "search" && steps.length === 1,
  },
];

async function call(
  provider: Candidate,
  system: string,
  user: string,
  maxTokens: number,
): Promise<CallResult> {
  const started = Date.now();
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(provider),
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });

  const raw = await response.text();
  const latency = Date.now() - started;

  if (!response.ok) {
    return { ok: false, status: response.status, latency, error: raw.slice(0, 240) };
  }

  let body: ChatBody;
  try {
    body = JSON.parse(raw) as ChatBody;
  } catch {
    return { ok: false, status: response.status, latency, error: "response was not JSON" };
  }

  return {
    ok: true,
    status: response.status,
    latency,
    content: body.choices?.[0]?.message?.content ?? "",
  };
}

function stripFences(value: string): string {
  return value
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function scoreRoute(result: CallResult): RouteScore {
  if (!result.ok) {
    return { json: false, steps: null, note: `http ${result.status}: ${result.error}` };
  }

  const raw = stripFences(result.content);
  let parsed: { steps?: Array<{ action?: unknown }> };

  try {
    parsed = JSON.parse(raw) as { steps?: Array<{ action?: unknown }> };
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match === null) {
      return { json: false, steps: null, note: "no JSON in the reply" };
    }
    try {
      parsed = JSON.parse(match[0]) as { steps?: Array<{ action?: unknown }> };
    } catch {
      return { json: false, steps: null, note: "unparseable JSON" };
    }
  }

  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.map((step) => String(step?.action ?? "?"))
    : null;

  return {
    json: true,
    steps,
    note: steps === null ? "no steps array" : "",
  };
}

function scoreSynth(result: CallResult): SynthScore {
  if (!result.ok) {
    return {
      cites: false,
      invented: null,
      stale: null,
      note: `http ${result.status}: ${result.error}`,
    };
  }

  const value = result.content;
  const cites = /\[s1\]/.test(value);
  const numbers = [
    ...value.matchAll(/(?:usd|\$|€|₹)\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(?:usd|dollars)/gi),
  ]
    .map((match) => match[1] ?? match[2])
    .filter((number): number is string => number !== undefined);
  const invented = numbers.filter((number) => !EVIDENCE.includes(number));
  const callsOldCurrent = /(?:is|costs|price is)\s*(?:now\s*)?(?:15|usd 15|\$15)/i.test(value);

  return {
    cites,
    invented: invented.length > 0 ? invented.join(",") : null,
    stale: callsOldCurrent,
    note: "",
  };
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function pause(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSurvey(target: Target): Promise<void> {
  const route = await call(target, ROUTE_SYSTEM, ROUTE_USER, 300);
  const routeScore = scoreRoute(route);
  const routeOk =
    routeScore.steps !== null &&
    routeScore.steps[0] === "recall" &&
    routeScore.steps.includes("recheck");

  await pause();

  const synth = await call(target, SYNTH_SYSTEM, SYNTH_USER, 400);
  const synthScore = scoreSynth(synth);

  console.log(
    pad(label(target), 64) +
      pad(routeOk ? "pass" : "FAIL", 7) +
      pad(routeScore.json ? "pass" : "FAIL", 7) +
      pad(synthScore.cites ? "pass" : "FAIL", 7) +
      pad(synthScore.invented ?? "-", 8) +
      `${route.latency}/${synth.latency} ms`,
  );

  for (const note of [routeScore.note, synthScore.note]) {
    if (note.length > 0) {
      console.log(`    ${note}`);
    }
  }
  if (synthScore.stale === true) {
    console.log("    treated the stale 15 USD source as current");
  }
  if (process.argv.includes("--show")) {
    console.log(`    reply: ${synth.ok ? synth.content.replace(/\s+/g, " ").slice(0, 700) : synth.error}`);
  }
}

async function runFinalists(target: Target): Promise<void> {
  const results: Array<{ id: string; pass: boolean; detail: string }> = [];

  for (const testCase of ROUTE_CASES) {
    const result = await call(target, ROUTE_SYSTEM, testCase.user, 300);
    const score = scoreRoute(result);
    results.push({
      id: `route:${testCase.id}`,
      pass: score.steps !== null && testCase.check(score.steps),
      detail: score.steps === null ? score.note : score.steps.join(" -> "),
    });
    await pause();
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await call(target, SYNTH_SYSTEM, SYNTH_USER, 400);
    const score = scoreSynth(result);
    const detail = `${result.ok ? "ok" : "http"} cites=${score.cites} stale=${score.stale} invented=${score.invented ?? "-"}`;
    results.push({
      id: `synth:cite-${attempt}`,
      pass: score.cites && score.stale !== true && score.invented === null,
      detail:
        score.cites || !result.ok
          ? detail
          : `${detail} reply="${result.content.replace(/\s+/g, " ").slice(0, 180)}"`,
    });
    await pause();
  }

  const empty = await call(
    target,
    "Answer only from the evidence. If the evidence does not contain the answer, say you do not know. Never invent a price.",
    "Question: What does HubSpot Starter cost?\n\nEvidence:\n(none)",
    200,
  );
  const emptyText = empty.ok ? empty.content : "";
  const refused =
    /do not know|don't know|no evidence|not enough information|cannot|unable|no information|unknown/i.test(
      emptyText,
    );
  const inventedOnEmpty = /(?:\$|usd\s?)\d+/i.test(emptyText);

  results.push({
    id: "synth:empty-evidence",
    pass: refused && !inventedOnEmpty,
    detail: empty.ok
      ? refused
        ? "refused"
        : "answered anyway"
      : `http ${empty.status}: ${empty.error}`,
  });

  const passed = results.filter((row) => row.pass).length;
  console.log("");
  console.log(`${label(target)}  ${passed}/${results.length}`);
  for (const row of results) {
    console.log(`  ${row.pass ? "pass" : "FAIL"}  ${pad(row.id, 24)} ${row.detail}`);
  }
}

async function describeReachability(provider: Candidate): Promise<void> {
  if (provider.apiKey === null) {
    console.log(`${pad(provider.role, 5)} ${provider.baseUrl}  key: MISSING`);
    return;
  }

  const url = `${provider.baseUrl}/models`;
  try {
    const response = await fetch(url, { headers: headers(provider) });
    const body = (await response.json().catch(() => null)) as ModelsBody | null;
    const ids = Array.isArray(body?.data)
      ? body.data
          .map((row) => row.id)
          .filter((id): id is string => typeof id === "string")
      : null;

    const listed = ids?.includes(provider.model) ?? null;
    const note =
      listed === null
        ? `models http ${response.status}`
        : listed
          ? "model listed"
          : `model NOT listed among ${ids?.length ?? 0} model(s)`;

    console.log(
      `${pad(provider.role, 5)} ${provider.baseUrl}  key: present  ${note}`,
    );
  } catch (error) {
    console.log(
      `${pad(provider.role, 5)} ${provider.baseUrl}  models unreachable: ${(error as Error).message}`,
    );
  }

  await pause(150);
}

async function main(): Promise<void> {
  console.log("");
  console.log("AsOf model probe");
  console.log("");

  for (const provider of candidates) {
    await describeReachability(provider);
  }

  if (process.argv.includes("--finalists")) {
    for (const target of targets) {
      await runFinalists(target);
    }
    console.log("");
    return;
  }

  console.log("");
  console.log(
    pad("target  ·  model  ·  host", 64) +
      pad("route", 7) +
      pad("json", 7) +
      pad("cite", 7) +
      pad("inv", 8) +
      "latency",
  );
  console.log("-".repeat(112));

  for (const target of targets) {
    await runSurvey(target);
    await pause();
  }

  console.log("");
  console.log(
    "route/json/cite expect pass; inv must be '-'. A FAIL here means the model cannot hold its contract.",
  );
  console.log("");
}

await main();
