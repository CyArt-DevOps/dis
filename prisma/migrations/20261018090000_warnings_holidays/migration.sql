-- Warning lifecycle: source, kind, review/ack status, covered days.
-- Existing rows (from /warn) keep status 'sent' and source 'command'.
ALTER TABLE `Warn`
    ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'command',
    ADD COLUMN `kind` VARCHAR(16) NOT NULL DEFAULT 'other',
    ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'sent',
    ADD COLUMN `days` TEXT NULL,
    ADD COLUMN `issuedBy` VARCHAR(80) NULL,
    ADD COLUMN `sentAt` DATETIME(3) NULL,
    ADD COLUMN `ackDueAt` DATETIME(3) NULL,
    ADD COLUMN `acknowledgedAt` DATETIME(3) NULL,
    ADD COLUMN `dmChannelId` VARCHAR(32) NULL,
    ADD COLUMN `dmMessageId` VARCHAR(32) NULL;

CREATE INDEX `Warn_guildId_status_idx` ON `Warn`(`guildId`, `status`);

CREATE TABLE `Holiday` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guildId` VARCHAR(191) NOT NULL,
    `day` VARCHAR(10) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `addedBy` VARCHAR(80) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Holiday_guildId_day_key`(`guildId`, `day`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Termination` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guildId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `fullName` VARCHAR(191) NULL,
    `reason` TEXT NOT NULL,
    `warnIds` TEXT NULL,
    `by` VARCHAR(80) NOT NULL,
    `kicked` BOOLEAN NOT NULL DEFAULT false,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Termination_guildId_userId_idx`(`guildId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
