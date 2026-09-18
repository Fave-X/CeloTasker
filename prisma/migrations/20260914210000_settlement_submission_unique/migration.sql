-- Stage 4.2: exactly one settlement may ever exist per submission.
-- Backs the guarded UNDER_REVIEW -> SETTLING transition as a hard,
-- database-level guarantee against duplicate settlement records.

-- DropIndex
DROP INDEX "Settlement_submissionId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_submissionId_key" ON "Settlement"("submissionId");