-- CreateEnum
CREATE TYPE "DeliveryAttemptOutcome" AS ENUM ('SUCCESS', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE');

-- CreateEnum
CREATE TYPE "DeliveryErrorCategory" AS ENUM ('HTTP_STATUS', 'TIMEOUT', 'CONNECTION_ERROR');

-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "leaseUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DeliveryAttempt" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL,
    "outcome" "DeliveryAttemptOutcome" NOT NULL,
    "httpStatusCode" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "errorCategory" "DeliveryErrorCategory",
    "errorMessage" TEXT,

    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryAttempt_deliveryId_attemptNumber_key" ON "DeliveryAttempt"("deliveryId", "attemptNumber");

-- CreateIndex
CREATE INDEX "Delivery_state_createdAt_idx" ON "Delivery"("state", "createdAt");

-- AddForeignKey
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
