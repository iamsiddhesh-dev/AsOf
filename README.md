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
GET /health
GET /api/ledger/stats
```

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
