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
```

`GET /:id/turns?date=` is exact-date recall. It resolves the date in the conversation's timezone and returns the turns created inside that local day.

`POST /:id/route` returns the deterministic routing decision for a message without writing anything. Every user turn is routed on write and stores the result in `turns.intent`.

## Routing

Routing is rules-first and has no model call. The default lane is `search`, because a factual question about the changing world should be checked, not recalled from memory.

| Intent | When | Searches | Cache |
|---|---|---|---|
| `meta` | greetings, acknowledgements, capability questions | no | n/a |
| `recall` | "what did I ask on 14 November", "what did you tell me about X" | no | n/a |
| `revalidate` | "is that still true", "has it changed since yesterday" | yes | bypassed |
| `clarify` | a pronoun with no antecedent, or a recheck with no prior answer | no | n/a |
| `search` | everything factual | yes | by intent TTL |

Date resolution is not hardcoded. `yesterday` is computed from the current time in the conversation's timezone, so on 15 November 2026 in `Asia/Kolkata` it resolves to the local day of 14 November.

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
