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
POST /api/conversations/:id/ask

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

## Answer path

`POST /:id/ask` routes the question, executes the plan in order, and writes both the question and the answer to the ledger. The route decides; the executor only does what it was told, so a half-answered compound question reports one status per step instead of hiding behind a single paragraph.

| Step | What actually runs |
|---|---|
| `recall` | a SQLite read, never a model call, listing the turns and naming the date range used |
| `search` | one Tavily search, then one synthesis call with five numbered sources |
| `chat` | a fixed reply; no provider call |
| `recheck` | `claims`: fresh search plus a comparison call; `news`: still `not_built` |

A search answer is only marked `grounded: true` when the reply cites an `[sN]` id that matches a source returned by that search. A model that answers without citing, or cites `[s9]` out of nowhere, produces `grounded: false` — the answer is returned with its citations and a visible flag, not silently trusted. This is what caught `gpt-oss-120b` swapping `[s1]` for `【s1】`.

Search results are cached in `search_cache` for 15 minutes, keyed by provider, query, and count. A recheck step carries `bypassCache` and refetches. Generated answers store the model, latency, and token counts on the assistant turn.

### Claims

A grounded answer is followed by one extraction call on the fast model. The model returns JSON claims, and each claim is only stored if its `quote` appears **verbatim** in the snippet of the source it cites. A paraphrased quote, an invented number, or an `[sN]` id that was never returned is dropped and counted in `dropped`. This is the rule that makes a later recheck meaningful: the ledger only holds what the evidence actually said.

Stored claims go into `claims` with the quote, the value, and a `source_id`; the cited pages are written to `sources`. A new active claim on the same subject, attribute, currency, and period supersedes the previous one, so an annual price does not overwrite a monthly price and the ledger keeps the history instead of overwriting it. The assistant turn records `claims_status` as `done`, `failed`, or `skipped` (no grounding, nothing to extract).

The response carries the summary:

```json
{ "claims": { "inserted": 2, "superseded": 0, "dropped": 1, "reason": null } }
```

Extraction failure never discards the answer the user already has. The turn is marked `failed` and the reason is returned.

### Recheck

`has hubspot pricing changed?` selects up to three **active** claims from the whole ledger. A claim is preferred when the question or the conversation's active entity set names its subject; if the question is just "has it changed?", the most recent active claims are used, and the answer says how many it checked. It then searches again with `bypassCache: true`, using the claim's subject and attribute as the query, and asks the fast model for one verdict per claim: `unchanged`, `changed`, or `unknown`.

The same provenance rule applies to verdicts. An `unchanged` or `changed` verdict without a quote that appears verbatim in the cited snippet is downgraded to `unknown`. A `changed` verdict whose new value equals the stored value is also downgraded. Only a trusted `changed` verdict writes anything: after the assistant turn exists, the new claim is stored and the compared claim is marked `superseded`, so the old belief stays in the ledger with the value it had. A recheck with no stored claims, no fresh sources, or unusable JSON reports a `blocked` step and says so; it never returns "nothing changed" from an empty comparison.

`news` mode is still `not_built`: dated launches and announcements are a different extraction job, and the answer says so.

```bash
npm run smoke:recheck
```

The script asks a pricing question, then rechecks it in a **new** conversation, which is also the test that memory is global rather than per-conversation:

```text
ask 1     200  what is hubspot starter pricing?
claims    6 stored, 0 dropped

ask 2     200  has hubspot pricing changed?
steps     recheck:done
grounded  true

I checked 3 stored claims.

HubSpot Starter plan normal price per seat per month is still $20 [s1].
HubSpot Starter plan discount for new customers is still up to 65% [s1].
HubSpot Starter plan annual commitment price per seat per month is still $7 [s1].

verdict   unchanged: HubSpot Starter plan normal_price_per_seat_per_month ($20 -> unchanged)
...

claims    0 stored, 0 superseded
```

No key? The endpoint returns `503` naming what is missing, rather than failing halfway through a turn.

One real question end to end, spending one search credit and two model requests (synthesis plus extraction):

```bash
npm run smoke:answer
```

```text
http      200  (3492 ms wall)
model     openai/gpt-oss-20b
grounded  true
steps     search:done

HubSpot's Starter plan is priced at $7 per seat per month when you pay annually,
or $10 per seat per month on a month-to-month basis. The standard price is $20
per seat per month, but the current offer gives up to 65 % off [s1][s3][s4].

  [s1] HubSpot's Starter Plan — https://www.hubspot.com/products/crm/starter
  ...

ledger    2 turn(s): user, assistant
claims    4 stored, 0 superseded, 0 dropped
```

## What works today

- Persistence, migrations, FTS5, health and ledger stats.
- Conversation and turn writes with routing stored per turn.
- Exact-date recall and global memory recall, both read from SQLite.
- Demo history loading.
- `.env` loading with real environment variables taking precedence, plus `npm run doctor` and `npm run probe:models`.
- A search answer with real sources, strict citation checks, a `grounded` flag, and both turns written to the ledger.
- Verbatim-checked claim extraction after grounded answers, with `sources` rows and supersession history.
- Claims-mode recheck: global claim selection, fresh search, verbatim-checked verdicts, and supersession of changed values.
- Deterministic eval coverage of the answer path through injected fixtures.

## What does not work yet

- News rechecks (`has any of them shipped something?`) still return `not_built`. Only dated claims and announcements would make that lane honest.
- No entity-set population, so "any of them" usually asks for the referent first.
- No streaming and no UI. Answers arrive as one JSON body.
- Claim extraction is only as good as the extraction prompt: claims the model omits are not recovered, and `dropped` counts rejected claims rather than explaining each one.
- A recheck compares against a fresh open-web search, not a dated archive. `unchanged` means "the current sources still say this", not "this was true continuously since yesterday".

The README says this because an agent that overstates its own state is the failure mode this project exists to avoid.

## Eval

```bash
npm run eval
```

Twelve cases run against a fresh ledger on a faked clock, in a temporary database. Each case seeds history, asks the question in a **new conversation**, and checks two things separately:

- **plan** — did the router produce the right steps, mode, date range, and blocked reason?
- **answer** — did the real `/ask` endpoint return the right text, citations, and honest refusal?

```text
plan    12/12
answer  11/11   (1 case(s) plan-only)
```

The answer cases go through the same handler as production. Search and chat are injected with fixtures, so the harness scores plumbing — citation validation, persistence, supersession, refusals — deterministically, with no network and no keys. A fixture does not prove a model is any good; `probe:models` measures that, and `smoke:answer` / `smoke:recheck` prove the real pair works once.

A plan failure exits non-zero, because routing regressions are silent otherwise. The one `plan-only` case is the `news` recheck, which is planned but deliberately not executed. It is printed, not skipped, so the gap stays visible instead of being averaged into a number that looks fine.

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
