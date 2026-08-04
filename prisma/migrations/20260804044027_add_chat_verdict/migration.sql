-- CreateTable
CREATE TABLE "ChatVerdict" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "question" TEXT NOT NULL,
    "sql" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL,
    "verdict" TEXT NOT NULL,
    "reason" TEXT,
    "model" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL
);
