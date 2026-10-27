-- Phase 3: meetings synced with EMS under one uid.
-- uid is added NULL, backfilled for existing rows, then made NOT NULL + unique,
-- so the migration works on a table that already has meetings.
ALTER TABLE `Meeting` ADD COLUMN `recurrenceUid` VARCHAR(36) NULL,
    ADD COLUMN `source` VARCHAR(8) NOT NULL DEFAULT 'dis',
    ADD COLUMN `uid` VARCHAR(36) NULL,
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- Backfill: one random UUID per existing meeting (MySQL 8 and TiDB both have UUID()).
UPDATE `Meeting` SET `uid` = UUID() WHERE `uid` IS NULL;
-- Existing rows start their sync clock at creation, not at migration time.
UPDATE `Meeting` SET `updatedAt` = `createdAt`;

ALTER TABLE `Meeting` MODIFY `uid` VARCHAR(36) NOT NULL;

-- AlterTable
ALTER TABLE `MeetingAttendance` ADD COLUMN `secondsAttended` INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX `Meeting_uid_key` ON `Meeting`(`uid`);

-- CreateIndex
CREATE INDEX `Meeting_updatedAt_idx` ON `Meeting`(`updatedAt`);
