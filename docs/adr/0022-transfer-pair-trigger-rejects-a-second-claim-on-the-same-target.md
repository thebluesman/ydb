# ADR-0022: The transfer-pair trigger also rejects a second claim on the same target

Status: Accepted
Date: 2026-08-02

## Context

ADR-0021 enforces transfer-pair exclusivity with two SQLite triggers on `"Transaction"`, aborting on
three conditions: self-link, counterpart already taken, and abandoning an inbound pointer. Reviewing
the shipped migration (`prisma/migrations/20260802103000_transfer_pair_exclusivity_triggers`) against
the state space it is supposed to close, one reachable bad state survives all three.

Take three rows `A`, `B`, `C`, all unlinked. Write `A→C`: condition 2 passes because `C` is NULL,
condition 3 passes because nothing points at `A`. Now write `B→C`: condition 2 still passes — `C` is
*still* NULL, because `A→C` was one-sided and never touched it — and condition 3 still passes,
because nothing points at `B`. Both writes are accepted and the table rests at `A→C`, `B→C`, `C`
NULL. Two rows claim the same counterpart, and the counterpart claims neither.

This is the same class of miss ADR-0021 identified in the naive symmetry check, one step out: each
condition inspects the target's outbound pointer or the writer's inbound pointers, and neither can
see a *sibling* claim on a target that is innocently NULL. Condition 2 is the near miss — it asks "is
my target spoken for by someone else" but only via the target's own pointer, which a one-sided
claimant never sets. The state is not reachable through today's five write paths in sequence, but it
is one hand-written `UPDATE` or one future sixth path away, and it is exactly the dead end the
triggers exist to make unrepresentable: no subsequent legal write repairs it, because whichever of
`A` or `B` eventually gets `C` pointing back leaves the other dangling forever.

Measured against `prisma/dev.db`, 2026-08-02: zero rows share a non-NULL `linkedTransferId` (367
transactions, 44 linked). The gap is latent, not present in the data.

## Decision

**Add a fourth condition to both triggers: a non-NULL `linkedTransferId` may not name a target that
another row already names.** Appended after the existing three, so the more specific messages win
where conditions overlap:

```sql
WHEN EXISTS (SELECT 1 FROM "Transaction" WHERE "linkedTransferId" = NEW."linkedTransferId"
             AND "id" <> NEW."id")
  THEN RAISE(ABORT, 'transfer link asymmetry: counterpart is already claimed by another transaction')
```

ADR-0021's framing is unchanged and its `WHEN NEW."linkedTransferId" IS NOT NULL` guard still
governs: writes of NULL are never checked, so the `ON DELETE SET NULL` survivor and every transient
one-sided state inside a pairing transaction stay legal. This narrows an enforced predicate; it does
not revisit the exclusivity-not-symmetry choice, the `AFTER`-not-`BEFORE` finding, or the decision to
enforce in the database at all.

Verified on a `better-sqlite3` instance with both trigger sets: the `A→C` / `B→C` sequence is
accepted without the clause and aborts on the second write with it, while the two-sided create, the
two-sided pair-then-repoint, the re-pair through NULL, and the post-delete survivor re-link are all
still accepted. The abort lands on the second claimant, so the first one-sided pointer survives —
which is correct, since one-sided is a legal state.

## Consequences

The dead-end state stops being representable, and the sixth write path inherits that too, which was
ADR-0021's whole reason for pushing this into the database.

**ADR-0021 is not edited.** It stands Accepted as written; this is a separate decision on a separate
predicate, in the same shape as ADR-0019's relationship to ADR-0016. Anyone reading the trigger set
needs both ADRs, and the migration comment header should say so.

**The failure surface widens the same way ADR-0021's did.** A second claim now returns a 500 from a
raw SQLite error rather than a clean 409, and the pre-check ADR-0021 asked for on the link route
should cover this condition as well — the route's 409 checks inspect the writer's outbound pointer
and (pending that work) inbound pointers, but nothing currently asks whether the target is already
claimed by a third row. Until then this is a backstop that fails ugly.

**Delivery.** The clause is a `@backend-engineer` ticket against PR #41, applied to both triggers.
Whether it lands as an edit to the unmerged 20260802103000 migration or as a follow-on migration is
an implementation call — if 20260802103000 has already been applied anywhere, it is a follow-on. The
violation-count comment in the header gains a fourth line (duplicate-claim: 0). `@qa`: the
three-row `A→C` then `B→C` sequence is the regression case, alongside the four legal sequences above,
which must keep passing.

**Invariants untouched.** Integer-cents money, `lib/accounts.ts` sign rules and the read-only guard
(`lib/prisma.ts`) are unchanged.
