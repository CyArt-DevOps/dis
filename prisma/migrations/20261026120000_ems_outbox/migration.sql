-- Outbox for events delivered to the EMS portal.
CREATE TABLE `OutboundEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` VARCHAR(36) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `payload` TEXT NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deliveredAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OutboundEvent_eventId_key`(`eventId`),
    INDEX `OutboundEvent_deliveredAt_nextAttemptAt_idx`(`deliveredAt`, `nextAttemptAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
