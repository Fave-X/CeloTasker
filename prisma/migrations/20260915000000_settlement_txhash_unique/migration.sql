-- M-A: a transaction hash identifies exactly ONE payment, so at most one
-- settlement may ever own it.
--
-- Backs the recovery/attachment ownership invariant at the database level: the
-- ownership check (SELECT of already-taken hashes) and the attach (UPDATE) are
-- separate statements, so without this constraint two concurrent recoverers
-- could both attach the SAME verified broadcast to two different settlements —
-- each believing it owns the payment.
--
-- SQLite allows multiple NULL values in a UNIQUE index, so the fail-closed
-- BROADCAST-with-null-txHash crash window remains representable.

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_txHash_key" ON "Settlement"("txHash");
