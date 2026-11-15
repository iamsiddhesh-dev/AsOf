# Design

This document is the architecture argument for AsOf: what it stores, why it
stores it that way, what it refuses to do, and how the pieces fail. It is kept
next to the code and updated with it.

If you only read one section, read [The trust boundary](#the-trust-boundary)
and [What is deliberately missing](#what-is-deliberately-missing).

---

## The thesis

Most assistants answer questions. AsOf answers questions **and remembers what
the answer was**, with the quote, the source, the date it was observed, and
what it replaced.

That changes the shape of the product. A chat log records what was said; it
cannot tell you what the ledger believed on 14 November, or that a price moved
from $20 to $15 and which page said so. An answer without provenance is a
rumour with good typography.

So the unit of storage is not the message. It is the **claim**:

> `HubSpot` · `starter_price` · `20 USD per seat per month` · observed 2026-11-14
> · "HubSpot Starter is 20 USD per seat per month." · source `s1`

Everything else — routing, recall, recheck, streaming, the UI — exists to
produce claims that are worth trusting, and to show the work when they are not.

---

## What the agent does today

| Behaviour | Status | Where |
|---|---|---|
| Exact-date recall ("what did I ask on 14 November") | works | `src/memory/recall.ts` |
| Global memory across conversations | works | `recallTurnsEverywhere` |
| Rules-first routing, no model call | works | `src/router/classify.ts` |
| Search answer with numbered citations + `grounded` flag | works | `src/answer/answer.ts` |
| Verbatim-checked claim extraction | works | `src/claims/extract.ts` |
| Claim recheck against a fresh search | works | `src/recheck/compare.ts` |
| Streaming answer (`/ask/stream`) | works | `src/routes/answer.ts` |
| News recheck ("has anything shipped since?") | **not built** — says so | `not_built` step |
| Entity-set population ("any of them") | **not built** — asks | `blockedBy: no_entity_set` |
| Frontend | **not built** | next slice |

The honest-refusal rows are not gaps in the demo. They are the design: the
agent has a vocabulary for *not knowing*, and uses it.

---

## The data model

Four tables carry the argument.

```text
conversations ──< turns ──< claims >── sources
                    │
                    └── parent_turn_id (question → answer)
```

`turns` is the conversation log, with the receipt attached: `intent`, resolved
date range, model, latency, tokens, `claims_status`.

`sources` is keyed by **what was fetched**, not by the answer that cited it. The
id is a hash of provider + canonical URL + snippet, so two answers that quote
the same page share one row instead of duplicating it.

`claims` is append-only. Every row carries:

- `subject_text`, `attribute`, `value_text`, `unit`, `currency`, `period` — the
  identity of the claim, so an annual price never overwrites a monthly one;
- `quote` — non-empty, enforced by `CHECK (length(trim(quote)) > 0)`;
- `source_id` — the page the quote came from;
- `observed_at` — when this ledger saw it;
- `supersedes_claim_id` and `status` — the history.

`status` is one of `active`, `superseded`, `retracted`, `unknown`. Nothing
deletes. "What did the ledger believe on 14 November" stays answerable after a
recheck changes the value.

Two columns are reserved and **currently unused**: `valid_from` / `valid_to`.
They are for real-world validity (a price was true from March to July), which is
a different question from when we observed it. Writing them without a dated
source would be fiction, so nothing writes them yet.

---

## One request, end to end

```text
POST /api/conversations/:id/ask
  │
  ├─ read body, resolve timezone (x-timezone header, else conversation)
  ├─ classify(text, now, timezone, state)          ← no model
  ├─ answerQuestion(...)                           ← plan executor
  │    ├─ recall   → SQLite read
  │    ├─ recheck  → fresh search + comparison call
  │    ├─ search   → one search + one synthesis call
  │    └─ chat     → fixed reply
  ├─ persist: user turn, assistant turn, claims
  └─ respond: answer, steps[], citations[], grounded, claims
```

Two orderings in that flow are deliberate and are the easiest thing to get
wrong.

### Answer before write

The question is written to the ledger **after** the answer is computed. That is
why "what did I ask on 14 November?" on an empty ledger says *nothing has been
stored yet* instead of listing the question you just asked. Writing first would
make the ledger describe a world that includes the question, which is not the
world the user was asking about.

### Decide before search

The router runs first and produces an explicit plan. A search answer cannot
quietly become a recall answer halfway through, and a compound question
("what did I ask on 3 November? Is that still correct?") is two steps with two
statuses, not one paragraph that hides which half failed.

---

## Routing without a model

```ts
type RouteIntent = "meta" | "recall" | "revalidate" | "clarify" | "search";
type RouteAction = "chat" | "recall" | "recheck" | "search";
```

`classify()` is a set of ordered regex rules plus date resolution. No model call,
no latency, no tokens, and — the part that matters — a decision you can read:

```json
{
  "intent": "revalidate",
  "confidence": "high",
  "reason": "matched \"is it still\"",
  "steps": [{ "action": "recheck", "mode": "claims", "bypassCache": true }],
  "blockedBy": null
}
```

Why not a model router?

1. **Speed.** Routing is free and instant, so the only latency in a search
   answer is the search and the synthesis.
2. **Testability.** 12 eval cases assert the exact step list. A model router
   turns a deterministic assertion into a distribution.
3. **Refusal.** A rule can see that "is it still true?" has no prior answer and
   block *before* spending a search. A model asked to classify it will happily
   produce a plausible plan for a question that cannot be answered.

The cost is coverage: phrasing outside the rules falls through to `search`.
That is a deliberate trade — a wrong search is recoverable, a wrong *silent*
recall is not. The rule labels are in the reason string, so a miss is visible in
the trace rather than mysterious.

`clarify` is a first-class outcome. A pronoun with no antecedent returns
`blockedBy: "no_prior_answer"` or `"no_entity_set"` instead of searching for the
word "it".

---

## Time is computed, never hardcoded

There is no example date anywhere in `src/`. Every "now" flows through one
clock; every date window is derived from it in the conversation's timezone.

`resolveDateRange()` handles `today`, `yesterday`, `tomorrow`, `last week`,
`this month`, `last 3 days`, `last monday`, `since the last answer`, ISO dates,
`14 November`, `14 November 2026`, and `November 14`.

Two details worth calling out:

**Yearless dates pick the most recent past occurrence.** On 15 November 2026,
"3 November" is 3 November 2026; on 2 January 2027 it is 3 November 2026, not
the future. The resolved range is echoed in the reply, so the interpretation is
never hidden.

**Timezone is part of the query, not the server.** "Yesterday" in
`Asia/Kolkata` is 2026-11-13T18:30Z → 2026-11-14T18:30Z. The day boundary is
computed with `Intl` rather than by adding 24 hours, so DST and offsets do not
silently shift a window. The browser can send `x-timezone` per request.

If the text names a date that cannot be resolved, the route is `clarify` with
`unresolved_date`. It does not guess.

---

## The trust boundary

This is the core of the project.

> **A claim is stored only if its quote appears verbatim in the snippet of the
> evidence it cites.**

The extraction model is asked for JSON claims with a `sourceId` and a `quote`.
Before anything is written, `keepClaim()` normalises whitespace and checks
`source.snippet.includes(claim.quote)`. If the quote is invented, paraphrased, or
cites an `sN` that was never returned, the claim is dropped and counted.

The same gate applies to recheck verdicts. An `unchanged` or `changed` verdict
whose quote is not verbatim in the cited snippet is downgraded to `unknown`:

```text
changed  "HubSpot now costs 15 USD each month"   ← paraphrased
   ↓
unknown  "the model's quote did not appear verbatim in the cited evidence"
```

And citations themselves are validated before that. A search answer is
`grounded: true` only when the reply contains an `[sN]` that matches a source
actually returned. This is not theoretical: it caught `gpt-oss-120b` emitting
full-width `【s1】` citations, which the parser rejects. The answer came back
`grounded: false` with the reason visible instead of being trusted because it
looked confident.

Three properties follow:

- **Fabrication is structurally hard.** The model chooses *which* sentence to
  quote; it cannot choose the sentence's contents.
- **Failure is visible.** `dropped` and `grounded: false` are in the response,
  not in a log nobody reads.
- **Recheck is meaningful.** A later diff compares text that was actually in the
  evidence, so "changed" means the evidence changed, not that the model's mood
  did.

The gate cannot check that the model picked the *right* sentence. A quote can be
verbatim and irrelevant. That is a real limit, stated in
[What is deliberately missing](#what-is-deliberately-missing).

---

## Claim lifecycle

```text
search result ──► synthesis ──► extraction ──► claim(active)
                                                    │
                                       recheck: evidence disagrees
                                                    ▼
                                   claim(superseded) ◄── new claim(active)
```

- **Append, never update.** A changed claim is a new row; the old one becomes
  `superseded` and `supersedes_claim_id` links them. Overwriting would destroy
  the thing the product is for.
- **Identity is more than the subject.** Supersession matches on
  `subject + attribute + currency + period`. HubSpot's monthly and annual prices
  are different claims and must not collide.
- **Extraction runs only on grounded answers.** No citations, no claims.
- **Recheck runs on the fast model.** It selects up to 3 active claims,
  preferring the subject the question or the active entity set names. If the
  question names a subject the ledger has never seen, it blocks rather than
  comparing an unrelated claim.
- **A recheck with no evidence writes nothing.** No stored claims, no fresh
  sources, or unusable JSON all produce a `blocked` step and a sentence saying
  so. "Nothing changed" is a conclusion that requires evidence.

`unchanged` means **the current sources still say it**. It does not mean the
value was continuously true since yesterday. Only a dated archive could claim
that, and there isn't one yet.

---

## Streaming

`POST /:id/ask/stream` runs the same plan and reports it over SSE.

| Event | Meaning |
|---|---|
| `decision` | intent, resolved range, planned steps, before any work |
| `step` | `action` + `running` / `done` / `blocked` / `not_built` |
| `sources` | the numbered citations, before the first token |
| `block` | a finished non-generated part: `recall`, `recheck`, `chat`, `clarify` |
| `delta` | real model tokens, keyed to the answer part |
| `done` | the `/ask` body plus `claimsStatus` and turn ids |
| `error` | message, provider, HTTP status, `retryable`, recorded question id |

What does **not** stream, by design:

- **Recall.** It is a SQLite read; there are no tokens to stream, and faking
  them would be theatre.
- **Recheck.** The verdict list is composed from validated JSON. It arrives as
  one block after the comparison, because a half-validated verdict is worse than
  a late one.

Turns are written **on completion**. An assistant turn created at stream open
with `status: 'streaming'` would be visible to recall and would make
`lastAnswerTurnId` point at an unfinished answer. The schema has the state; the
endpoint does not use it, because there is nothing useful to do with a partial
turn that cannot be said better by just waiting.

A client that disconnects mid-stream loses the partial answer and the question
is not recorded, since the plan never completed. This is a trade: an interrupted
answer is not evidence.

Retries stop at the first token. Re-sending a stream after deltas have been
delivered would repeat text the reader has already seen, so a mid-stream failure
is reported, not retried.

---

## Provider boundary

```ts
interface SearchClient { search(query, options?): Promise<SearchResponse> }
interface ChatClient {
  chat(request): Promise<ChatResponse>
  stream?(request, onDelta): Promise<ChatResponse>   // optional
}
```

Nothing above this line knows whether the provider is Tavily, Groq, OpenRouter,
or a fixture. That is what makes the eval honest: the same handler that serves
production runs against `FakeSearch` and `FakeChat`, so citation validation,
persistence, supersession, and refusals are tested deterministically with no
network and no keys.

Production wiring adds two things the interfaces do not show:

- **Retry policy.** Bounded at two retries, honouring `Retry-After`, and never
  retrying a rejected key. A free-tier budget should not be spent on a storm.
- **Search cache.** 15 minutes, keyed by provider + query + count. A recheck
  sets `bypassCache`, because comparing against the same cached page is not a
  recheck.

---

## Evaluation

```bash
npm run eval
```

Twelve cases, each seeded into a temporary database with a frozen clock and
asked in a **new** conversation. Two scores per case:

- **plan** — did routing produce the right steps, mode, date range, and blocked
  reason?
- **answer** — did the real endpoint return the right text, citations, and
  refusal?

```text
plan    12/12
answer  11/11   (1 case(s) plan-only)
```

The one plan-only case is the `news` recheck, which is planned and deliberately
not executed. It is printed, not skipped, so the gap stays visible instead of
being averaged into a number that looks fine.

Three other instruments exist because a fixture cannot tell you whether a model
is any good:

| Command | Question it answers | Cost |
|---|---|---|
| `npm run doctor` | are the keys present, correct for the base URL, and is the model served? | free |
| `npm run probe:models` | which configured models actually answer, and in what format? | tokens |
| `npm run smoke:answer` | does the real search + model pair produce a grounded answer? | 1 search, 2 calls |
| `npm run smoke:recheck` | does a recheck in a new conversation see global memory? | 2 searches, up to 4 calls |
| `npm run smoke:stream` | are the SSE events real, and do both turns land? | 1 search, 2 calls |

What the eval does **not** prove: that the extraction prompt captures every
claim a human would, that the router understands every phrasing, or that the
model chose the *most relevant* verbatim quote. Those are model-quality
questions, and they are measured by the smoke runs and by reading the output,
not by a green check.

---

## UI direction

The reference list maps to product surfaces, not decoration:

| Reference | AsOf feature |
|---|---|
| Perplexity | conversation with cited answers and marginal sources |
| NotebookLM | source inspector and reading layout |
| Elicit | claim ledger and evidence tables |
| Kagi | temporal search filters |
| Wayback Machine | historical snapshots and date navigation |
| Obsidian | local-first knowledge organisation |
| Mem | contextual recall and history |

That produces three views, not a chat clone:

1. **Reader** — the conversation as a document timeline in a ~68-character
   column. Turns are not bubbles. Each answer carries a receipt line: intent,
   steps, model, latency, `grounded`. Citations sit in the margin; clicking one
   opens its quoted snippet.
2. **Inspector** — source detail for an `[sN]`, and claim history for a subject:
   value, `active` / `superseded`, observed date, quote, and the supersession
   link.
3. **Ledger** — claims as primary objects: subject, attribute, current value,
   previous value, status, observed date. This is the Elicit/Kagi/Wayback view,
   and it is the one that makes the product look like an instrument.

The header always shows the ledger clock and timezone, because time is the
premise.

The UI is **light mode only, calm editorial**. No gradients, no glassmorphism,
no sparkle icons, no chat bubbles, no generic hero. Typography, rules, and
whitespace do the work. Density is moderate: the reader is comfortable at length
because this is meant to be used daily, not screenshot once.

Not built yet. It needs three read APIs first: `GET /api/ledger/claims`,
claim history by subject, and durable per-turn citations (a `turn_sources`
table), so reopening a conversation can still show its evidence instead of
relying on the response body that has already been discarded.

---

## What is deliberately missing

Scope discipline is part of the architecture. These are cuts, not oversights:

- **No news recheck.** "Has anything shipped since?" needs dated-launch
  extraction from news, which is a different job from claim diffing. It returns
  `not_built` and says so.
- **No entity sets.** The schema has `entities`, `entity_aliases`, and
  `entity_sets`; nothing populates them. So "any of them" asks for the referent
  instead of guessing a list.
- **No background watches.** `watches` and `watch_events` exist in the schema;
  there is no scheduler. The user asks for a recheck; the agent does not poll on
  its own.
- **No embeddings.** Recall is SQL over a time window plus FTS5 keywords.
  Semantic recall would be a second index and a new failure mode; it is not
  needed to prove the temporal claim.
- **No valid-time modelling.** `valid_from` / `valid_to` are unused. We know when
  we observed a claim, not when the world changed.
- **No multi-user.** Local-first, single ledger, no auth. That is the product
  shape, not a shortcut.
- **No partial turn on disconnect.** See [Streaming](#streaming).

Each of these is a place where pretending would be easier than saying "not
built". The README and the eval output repeat the list, because an agent that
overstates its own state is exactly the failure this project exists to avoid.

---

## Mapping to the judging criteria

**Fast.** Routing is regex, so the first network call is the search. Recall never
calls a model. The search cache and bypass flag are explicit per step. Streaming
puts sources on screen before the first token. Live run: 94 deltas, first token
at 4.2 s of a 5.6 s turn, with ~4 s of that being search.

**Gets things right.** Strongest claim first: quotes are checked mechanically
against evidence, citations are validated against returned ids, and a changed
claim supersedes instead of overwriting. When the check fails, the system says so
(`grounded: false`, `dropped`, `unknown`) rather than degrading quietly.

**Good to talk to.** It has a vocabulary for uncertainty: `clarify` with a
reason, `blocked` with a reason, `not_built` with a reason, and an empty-ledger
reply that names the day memory starts. It never answers "nothing changed" from
an empty comparison. Compound questions report per-step status instead of
flattening into one paragraph.

The through-line: **the ledger only grows by things that can be pointed at.**
