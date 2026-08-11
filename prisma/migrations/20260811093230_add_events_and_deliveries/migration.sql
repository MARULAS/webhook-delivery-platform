-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('PENDING', 'PROCESSING', 'RETRY_SCHEDULED', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "eventTypeId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "state" "DeliveryState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Event_idempotencyKey_key" ON "Event"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Delivery_endpointId_idx" ON "Delivery"("endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_eventId_endpointId_key" ON "Delivery"("eventId", "endpointId");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_eventTypeId_fkey" FOREIGN KEY ("eventTypeId") REFERENCES "EventType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
