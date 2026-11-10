/*
  Warnings:

  - You are about to drop the column `preferredTime` on the `Request` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Request" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "profession" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "preferredDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SOLICITADO',
    "selectedQuoteId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Request_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Request" ("clientId", "createdAt", "description", "id", "preferredDate", "profession", "selectedQuoteId", "status") SELECT "clientId", "createdAt", "description", "id", "preferredDate", "profession", "selectedQuoteId", "status" FROM "Request";
DROP TABLE "Request";
ALTER TABLE "new_Request" RENAME TO "Request";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
