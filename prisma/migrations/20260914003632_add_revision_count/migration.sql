-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rewardAmount" TEXT NOT NULL,
    "rewardToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "creator" TEXT NOT NULL,
    "assignee" TEXT,
    "revisionCount" INTEGER NOT NULL DEFAULT 0,
    "deadline" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Task" ("assignee", "createdAt", "creator", "deadline", "description", "id", "rewardAmount", "rewardToken", "status", "title", "updatedAt") SELECT "assignee", "createdAt", "creator", "deadline", "description", "id", "rewardAmount", "rewardToken", "status", "title", "updatedAt" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_creator_idx" ON "Task"("creator");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
