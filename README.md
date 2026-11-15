# AsOf

AsOf is a local-first temporal agent. It remembers what was true, when it was true, and where the answer came from.

> Ask as of.

## Status

Early development. The first milestone is the smallest working version that can prove one claim end to end: a user message, a route, a source, a quote, a verdict, and a receipt.

## Run

```bash
npm install
npm run db:migrate
npm run dev
```

The service starts on `http://localhost:8787` by default.

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

Date resolution is not hardcoded. `yesterday` is computed from the current time in the conversation's timezone, so on 15 November 2026 in `Asia/Kolkata` it resolves to the local day of 14 November. The browser can override the timezone per request with an `x-timezone` header.

## What works today

- Persistence, migrations, FTS5, health and ledger stats.
- Conversation and turn writes with routing stored per turn.
- Exact-date recall and global memory recall, both read from SQLite.
- Demo history loading.

## What does not work yet

- No model and no search provider are wired. `search` and `recheck` steps are decided but not executed.
- No claims are extracted, so `recheck` has nothing to diff and no receipts to show.
- No streaming, no UI.

The README says this because an agent that overstates its own state is the failure mode this project exists to avoid.

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
