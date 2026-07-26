-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "ynabId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_ynabId_key" ON "Transaction"("ynabId");
