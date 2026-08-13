-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Delivery_state_nextAttemptAt_idx" ON "Delivery"("state", "nextAttemptAt");
