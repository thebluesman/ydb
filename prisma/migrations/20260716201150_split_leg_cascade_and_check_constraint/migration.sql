-- Hand-edited: Prisma's schema can't express a CHECK constraint, and SQLite
-- has no ALTER TABLE ADD CONSTRAINT, so it's added by hand into the
-- CREATE TABLE this RedefineTables rebuild already performs for the
-- parentTransaction onDelete: Cascade change (FOLLOWUPS §5). Predicate was
-- run as a negated SELECT against dev.db before writing this — 0 violating
-- rows (see IMPROVEMENT_PLAN.md Phase 6 status; the checked DB was empty).
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Transaction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "date" DATETIME NOT NULL,
    "amount" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "originalDescription" TEXT,
    "transactionType" TEXT NOT NULL DEFAULT 'debit',
    "category" TEXT NOT NULL DEFAULT '',
    "accountId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'review',
    "notes" TEXT,
    "rawSource" TEXT,
    "createdVia" TEXT NOT NULL DEFAULT 'import',
    "linkedTransferId" INTEGER,
    "parentTransactionId" INTEGER,
    "reimbursableFor" TEXT,
    "reimbursementTxId" INTEGER,
    "transferCounterpartAccountId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transaction_linkedTransferId_fkey" FOREIGN KEY ("linkedTransferId") REFERENCES "Transaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_parentTransactionId_fkey" FOREIGN KEY ("parentTransactionId") REFERENCES "Transaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_reimbursementTxId_fkey" FOREIGN KEY ("reimbursementTxId") REFERENCES "Transaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_transferCounterpartAccountId_fkey" FOREIGN KEY ("transferCounterpartAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CHECK ((transactionType = 'debit' AND amount <= 0) OR (transactionType = 'credit' AND amount >= 0) OR transactionType = 'transfer')
);
INSERT INTO "new_Transaction" ("accountId", "amount", "category", "createdAt", "createdVia", "date", "description", "id", "linkedTransferId", "notes", "originalDescription", "parentTransactionId", "rawSource", "reimbursableFor", "reimbursementTxId", "status", "transactionType", "transferCounterpartAccountId", "updatedAt") SELECT "accountId", "amount", "category", "createdAt", "createdVia", "date", "description", "id", "linkedTransferId", "notes", "originalDescription", "parentTransactionId", "rawSource", "reimbursableFor", "reimbursementTxId", "status", "transactionType", "transferCounterpartAccountId", "updatedAt" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
CREATE UNIQUE INDEX "Transaction_reimbursementTxId_key" ON "Transaction"("reimbursementTxId");
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");
CREATE INDEX "Transaction_accountId_date_idx" ON "Transaction"("accountId", "date");
CREATE INDEX "Transaction_accountId_status_date_idx" ON "Transaction"("accountId", "status", "date");
CREATE INDEX "Transaction_status_idx" ON "Transaction"("status");
CREATE INDEX "Transaction_category_idx" ON "Transaction"("category");
CREATE INDEX "Transaction_parentTransactionId_idx" ON "Transaction"("parentTransactionId");
CREATE INDEX "Transaction_linkedTransferId_idx" ON "Transaction"("linkedTransferId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
