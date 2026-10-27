-- Phase 4: EMS formal warnings mirrored as Warn rows (source "ems"), and the
-- auto-warn switch EMS sets for projects the strictness ladder runs live.
-- AlterTable
ALTER TABLE `Warn` ADD COLUMN `externalUid` VARCHAR(36) NULL;

-- CreateIndex (NULLs never collide, so existing rows are fine)
CREATE UNIQUE INDEX `Warn_externalUid_key` ON `Warn`(`externalUid`);

-- CreateTable
CREATE TABLE `BotSetting` (
    `key` VARCHAR(64) NOT NULL,
    `value` TEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
