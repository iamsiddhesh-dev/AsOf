# AsOf

AsOf is a local-first temporal agent. It remembers what was true, when it was true, and where the answer came from.

> Ask as of.

## Status

Early development. The first milestone is the smallest working version that can prove one claim end to end: a user message, a route, a source, a quote, a verdict, and a receipt.

## Run

```bash
npm install
Copy-Item .env.example .env   # then fill LLM_API_KEY and TAVILY_API_KEY
npm run doctor                # keys present, key matches provider, model served
npm run db:migrate
npm run dev
```

The service starts on `http://localhost:8787` by default.

`npm run doctor` is the first stop when something fails. It reports which keys `.env` loaded, whether the key's prefix belongs to the provider its base URL points at, and whether that provider actually serves the configured model — without spending a token or a search credit. Model IDs move; this catches the dead ID before a request does.

Set `FAKE_NOW` to freeze the clock for tests and demos. Every "now" in the app flows through that one value.

```text
GET  /health
GET  /api/ledger/stats

POST /api/conversations
GET  /api/conversations
GET  /api/conversations/:id
POST /api/conversations/:id/turns
GET  /api/conversations/:id/turns
GET  /api/conversations/:id/turns?date=3%20november
POST /api/conversations/:id/route

POST /api/memory/recall
GET  /api/memory/stats
POST /api/demo/history
GET  /api/demo/history
```

`GET /:id/turns?date=` is conversation-scoped exact-date recall.

`POST /api/memory/recall` is global recall. Memory is not scoped to one conversation, so "what did I ask in November" reaches every conversation the user has ever had. The reply is read from the database, never generated:

```json
{
  "found": false,
  "range": { "label": "3 November 2026", "...": "..." },
  "turns": [],
  "message": "I have no record from 3 November 2026. My memory starts 14 November 2026, when this install first stored a turn."
}
```

`POST /api/demo/history` seeds six dated turns relative to the clock — yesterday, the most recent past Monday, and last Tuesday. They are tagged `isDemo` in the reply. Nothing is seeded on boot: an answer about a question the reviewer never asked is indistinguishable from a hallucination.

`POST /:id/route` returns the routing decision for a message without writing anything. Every user turn is routed on write and stores the result in `turns.intent`.

## Routing

Routing is rules-first and has no model call yet. The default lane is `search`, because a factual question about the changing world should be checked, not recalled from memory.

A message may produce several steps. Compound questions are normal:

```json
// "what did I ask on 3 november? is your answer still correct today?"
{ "intent": "recall",
  "steps": [
    { "action": "recall",  "timeRange": { "label": "3 November 2026" } },
    { "action": "recheck", "mode": "claims", "bypassCache": true } ] }
```

| Intent | When | Searches | Cache |
|---|---|---|---|
| `meta` | greetings, acknowledgements, capability questions | no | n/a |
| `recall` | "what did I ask on 14 November", "what did you tell me about X" | no | n/a |
| `revalidate` | "is that still true", "has it changed since yesterday" | yes | bypassed |
| `clarify` | a pronoun with no antecedent, or a recheck with no prior answer | no | n/a |
| `search` | everything factual | yes | by intent TTL |

`recheck` carries a `mode`: `claims` diffs stored claims, `news` looks for dated launches or announcements after the anchor. `clarify` carries a `blockedBy` reason (`no_prior_answer`, `no_entity_set`, `unresolved_date`) so a missing precondition is visible instead of guessed.

Claims are counted across the whole ledger, not one conversation, for the same reason recall is: "has it changed?" is a question about everything you have stored.

Date resolution is not hardcoded. `yesterday` is computed from the current time in the conversation's timezone, so on 15 November 2026 in `Asia/Kolkata` it resolves to the local day of 14 November. The browser can override the timezone per request with an `x-timezone` header.

## What works today

- Persistence, migrations, FTS5, health and ledger stats.
- Conversation and turn writes with routing stored per turn.
- Exact-date recall and global memory recall, both read from SQLite.
- Demo history loading.
- `.env` loading with real environment variables taking precedence, plus `npm run doctor` and `npm run probe:models`.

## What does not work yet

- No model and no search provider are called by the app yet. The provider, key, and model are configured and verified by `npm run doctor`, but no request flows through them. `search` and `recheck` steps are decided, not executed.
- No claims are extracted, so `recheck` has nothing to diff and no receipts to show.
- No streaming, no UI.

The README says this because an agent that overstates its own state is the failure mode this project exists to avoid.

## Eval

```bash
npm run eval
```

Twelve cases run against a fresh ledger on a faked clock, in a temporary database. Each case seeds history, asks the question in a **new conversation**, and checks two things separately:

- **plan** — did the router produce the right steps, mode, date range, and blocked reason?
- **answer** — did the reply contain the right turns, or the right honest refusal?

```text
plan    12/12
answer  5/5   (7 case(s) plan-only)
```

A plan failure exits non-zero, because routing regressions are silent otherwise. `plan-only` cases are the lanes whose answer path is not built: `recheck` and `search`. The harness prints them instead of skipping them, so the gap is visible rather than averaged away.

The eval seeds every question in a new conversation on purpose. If recall or recheck were scoped to the current conversation, these cases would fail.

## Model choice

The app reads `.env` itself (`src/env.ts`), and a real environment variable wins over the file, so CI can never be pointed at a laptop's database.

```bash
npm run doctor                       # keys, key/owner agreement, model served
npm run probe:models                 # survey the main and fast calls
npm run probe:models -- --finalists  # repeat each one, plus traps
npm run probe:models -- --show       # print what the model actually said
```

`doctor` spends no tokens and no search credits. `probe` sends this repo's real routing and synthesis prompts, then checks four things per model: parseable routing JSON with the right steps, a citation on the synthesised answer, no invented numbers, and refusal when the evidence is empty.

Groq, free tier (the default), probed 15 Nov 2026:

| Model | Routing JSON | Cites source | Invented numbers | Latency |
|---|---|---|---|---|
| `openai/gpt-oss-20b` | pass | pass 3/3 | none | 0.6–0.7 s |
| `openai/gpt-oss-120b` | pass | **1/3 strict** (3/3 if `【s1】` is accepted) | none | 0.7–1.1 s |

The larger model is not the safer one here. `gpt-oss-120b` does cite, but intermittently writes full-width `【s1】` instead of `[s1]`; a parser keyed to the ASCII form silently loses provenance. That is disqualifying until the parser normalises the glyph, so both calls run the 20B model. Same model for both calls deliberately: one variable at a time, split only when measured latency or quality says so.

OpenRouter free tier, measured the same day and kept because those IDs have already moved once:

| Model | Routing JSON | Cites source | Invented numbers | Latency |
|---|---|---|---|---|
| `particle-ai/particle-1:free` | pass | 3/3 | none | 1.1–2.0 s |
| `baidu/ernie-5.5-flash-preview:free` | pass | 3/3 | none | 1.9–2.2 s |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | pass | **0/3** | none | 3.5–4.9 s |
| `inclusionai/ling-3.2-flash:free` | pass | 3/3 | none | 9.7–11.6 s |
| `nvidia/nemotron-3.5-lightning:free` | **no JSON** | — | — | 2.3 s |
| `google/gemma-4-26b-a4b-it:free` | 429 | — | — | — |

The largest OpenRouter model also failed to cite. Across both providers, provenance compliance does not follow parameter count. That is why this is measured rather than assumed.

Limits: Groq is about 30 req/min and 1,000 req/day. OpenRouter is 20 req/min and 50 req/day below 10 USD of lifetime credits, 1,000/day above. A turn costs about three requests.

Caveat: one day, free endpoints, small samples. Model IDs and limits move — re-run the probe instead of trusting this table.

## Branches

```text
main          final product
development   integration and testing
feature/*     one task per branch
```

Task branches are created from `development`. Merge back into `development` first, then promote to `main` only when the product is stable.

## Principles

- One model-visible tool.
- One local ledger.
- Local-first by default.
- Every answer carries provenance.
- Revalidate before repeating an old claim.

## Commit style

Every commit message is lowercase, one sentence, and follows:

```text
type(scope): what changed
```

Example: `fix(api): reject a claim with no source date`
