-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "dni" TEXT,
    "profession" TEXT,
    "description" TEXT,
    "services" TEXT,
    "schedule" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" DATETIME
);
INSERT INTO "new_User" ("createdAt", "description", "dni", "id", "name", "passwordHash", "profession", "role", "schedule", "services", "username") SELECT "createdAt", "description", "dni", "id", "name", "passwordHash", "profession", "role", "schedule", "services", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_dni_key" ON "User"("dni");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
