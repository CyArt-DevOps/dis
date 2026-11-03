-- HR actions sync (EMS spec 2026-11-03): every warning and leave gets a shared uid and an updatedAt for EMS's pull.
-- AlterTable
ALTER TABLE `Warn` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `Warn` SET `updatedAt` = COALESCE(`sentAt`, `createdAt`);
UPDATE `Warn` SET `externalUid` = UUID() WHERE `externalUid` IS NULL;

-- AlterTable
ALTER TABLE `LeaveRequest` ADD COLUMN `uid` VARCHAR(36) NULL;
ALTER TABLE `LeaveRequest` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `LeaveRequest` SET `uid` = UUID(), `updatedAt` = COALESCE(`reviewedAt`, `createdAt`);
ALTER TABLE `LeaveRequest` MODIFY `uid` VARCHAR(36) NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `LeaveRequest_uid_key` ON `LeaveRequest`(`uid`);
CREATE INDEX `LeaveRequest_guildId_updatedAt_id_idx` ON `LeaveRequest`(`guildId`, `updatedAt`, `id`);
CREATE INDEX `Warn_guildId_updatedAt_id_idx` ON `Warn`(`guildId`, `updatedAt`, `id`);
