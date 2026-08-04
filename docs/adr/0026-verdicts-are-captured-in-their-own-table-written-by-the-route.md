# ADR-0026: Verdicts are captured in their own table, written by the route

Status: Accepted
Date: 2026-08-04

## Context

Half of Phase A's value is the verdict itself; the other half is the record. ADR-0013 calls it "the
eval data the chat path has never had", and it is the half that unblocks Phase B — the gate is
"Phase A verdict data showing which failure classes actually dominate", which requires the data to be
queryable months later, not written and forgotten.

The obvious home is `ChatMessage`, which already carries `sql` and `nonAnswerReason` (ADR-0014,
PR #25). It does not work, for a reason that only shows up when you read the write path:

- `POST /api/chat` receives `{ question, history }` and **no session id**. The route has no
  `ChatMessage` row to attach anything to, and none exists yet at the moment the verifier runs.
- `ChatMessage` rows are written afterwards, **by the client** — `app/chat/_components/ChatPane.tsx`
  posts the accumulated turn to `/api/chat-sessions/[id]/messages`. So a verdict routed through the
  client is a verdict that a dropped connection, a closed tab, or a narration failure loses. Abandoned
  turns are among the samples most worth having: a turn the user walked away from is a turn that took
  too long or looked wrong.

ADR-0023 and ADR-0024 both left "structured output does not survive reload" as an unanswered schema
question. This is not that question, and bundling them would decide the harder one by accident.

## Decision

**A new `ChatVerdict` table, written server-side by `app/api/chat/route.ts`, one row per turn that
reaches the verifier. It is not linked to `ChatMessage` and carries no session id.**

```prisma
model ChatVerdict {
  id        Int      @id @default(autoincrement())
  createdAt DateTime @default(now())
  question  String   // the user's question for the turn, capped
  sql       String   // the query that actually ran, post-repair
  rowCount  Int      // rows the verifier saw, after NARRATION_ROW_CAP
  truncated Boolean  // whether the row set was cut before it got there
  verdict   String   // 'ok' | 'mismatch' | 'out-of-scope' | 'unusable' (ADR-0025)
  reason    String?  // the model's one line, capped; NULL when 'unusable'
  model     String   // the resolved sqlModel, so a model change is legible in the data
  latencyMs Int      // what the extra round-trip actually cost
}
```

- **Written before the narration call,** so the row exists even if narration 503s or the client
  disconnects mid-stream. The write is fire-and-forget with respect to the answer: a failure to record
  a verdict is logged and never fails the turn.
- **Rows are never copied in, only counted.** A verdict table holding result rows would be a second
  copy of ledger data with its own lifecycle and its own staleness, and ADR-0023 already ruled that
  re-execution is not an acceptable way to rebuild one. `sql` plus `createdAt` is enough to reconstruct
  what was asked; the answer itself is not the artifact under study.
- **`reason` is stored, never sent to the client.** It is model-authored text composed from
  third-party-controlled rows. ADR-0014's rule that the route writes every user-facing message holds
  unchanged.
- **Only turns that reached the verifier get a row.** A turn refused by an earlier guard never produced
  a verdict, and inventing one would put a model label on a deterministic decision — the exact
  conflation ADR-0025 refused at the type level.

## Consequences

**"Which failure classes dominate" is one SQL query away,** which is the entire point:
`SELECT verdict, COUNT(*) FROM ChatVerdict GROUP BY verdict`, sliced by `model` or by month. `latencyMs`
answers the other standing question — what Phase A actually costs — with measurement rather than the
estimate in ADR-0025.

**The denominator is split across two stores, and combining them is manual.** Guard refusals live in
`ChatMessage.nonAnswerReason`; verifier verdicts live here. So "of all turns, what fraction were
refused and by what" needs both, joined by hand on timestamps. That is the price of not routing this
through the client, and it is the right price — but whether guard refusals should also be recorded
here, giving one table the whole outcome distribution, is left open rather than decided. It is a bigger
change than it looks: those refusals return before the route has anything else to record, and several
return before any SQL exists at all.

**A write on the chat request path, and the read-only guard is untouched.** `executeReadonlyQuery`
governs *generated* SQL; this is ordinary application code on the normal Prisma client, the same as the
`Setting` reads already in this route and the `ChatMessage` writes in the sibling one. Nothing
model-generated reaches this table as SQL.

**It accumulates forever and that is fine, until it isn't.** Single user, a few dozen rows a day, a few
hundred bytes each. No retention policy, no pruning job; if it ever matters, deleting old rows is a
one-liner. Building a lifecycle for it now would cost more than the data is currently worth.

**It stores question text and generated SQL in the same database as the ledger.** No new exposure —
`ChatMessage` already persists both, and the app is LAN-only with no auth (ADR-0006's posture).
Anything that changes that posture has to account for this table too.
