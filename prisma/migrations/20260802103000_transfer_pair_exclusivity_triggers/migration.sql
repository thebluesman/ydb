-- Hand-edited: Prisma cannot express triggers and SQLite has no
-- ALTER TABLE ADD CONSTRAINT, so transfer-pair integrity is added by hand
-- (FOLLOWUPS §5, last item; design in ADR-0021).
--
-- Enforces pair EXCLUSIVITY, not literal symmetry. Writes of NULL are never
-- checked: the FK is ON DELETE SET NULL and every write path nulls a
-- back-pointer before repointing it, so one-sided NULL is a legal state both
-- after a counterpart delete and transiently inside every pairing transaction.
--
-- AFTER, not BEFORE, on INSERT: in a BEFORE INSERT trigger SQLite has not yet
-- assigned the autoincrement rowid and NEW.id reads as -1, which silently
-- breaks the self-link check and both <> NEW.id comparisons.
--
-- Predicates run as negated SELECTs against dev.db before writing this
-- (367 transactions, 44 linked = 22 clean pairs): self-link 0,
-- counterpart-already-taken 0, abandoned-inbound-pointer 0, dangling FK 0.
--
-- NOTE: a future Prisma RedefineTables migration on "Transaction" drops both
-- of these triggers AND the amount-sign CHECK from
-- 20260716201150_split_leg_cascade_and_check_constraint. Re-create all three
-- by hand if that happens (docs/architecture.md).

CREATE TRIGGER "Transaction_transfer_pair_insert"
AFTER INSERT ON "Transaction"
FOR EACH ROW WHEN NEW."linkedTransferId" IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW."linkedTransferId" = NEW."id"
      THEN RAISE(ABORT, 'transfer link: a transaction cannot be linked to itself')
    WHEN EXISTS (SELECT 1 FROM "Transaction" WHERE "id" = NEW."linkedTransferId"
                 AND "linkedTransferId" IS NOT NULL AND "linkedTransferId" <> NEW."id")
      THEN RAISE(ABORT, 'transfer link asymmetry: counterpart is already linked to a different transaction')
    WHEN EXISTS (SELECT 1 FROM "Transaction" WHERE "linkedTransferId" = NEW."id"
                 AND "id" <> NEW."linkedTransferId")
      THEN RAISE(ABORT, 'transfer link asymmetry: another transaction still points at this one')
  END;
END;

CREATE TRIGGER "Transaction_transfer_pair_update"
AFTER UPDATE OF "linkedTransferId" ON "Transaction"
FOR EACH ROW WHEN NEW."linkedTransferId" IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW."linkedTransferId" = NEW."id"
      THEN RAISE(ABORT, 'transfer link: a transaction cannot be linked to itself')
    WHEN EXISTS (SELECT 1 FROM "Transaction" WHERE "id" = NEW."linkedTransferId"
                 AND "linkedTransferId" IS NOT NULL AND "linkedTransferId" <> NEW."id")
      THEN RAISE(ABORT, 'transfer link asymmetry: counterpart is already linked to a different transaction')
    WHEN EXISTS (SELECT 1 FROM "Transaction" WHERE "linkedTransferId" = NEW."id"
                 AND "id" <> NEW."linkedTransferId")
      THEN RAISE(ABORT, 'transfer link asymmetry: another transaction still points at this one')
  END;
END;
