-- CreateIndex
CREATE INDEX "Transaction_accountId_status_date_idx" ON "Transaction"("accountId", "status", "date");
