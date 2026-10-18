-- HR contact email (optional, for the account list).
ALTER TABLE `HrUser` ADD COLUMN `email` VARCHAR(191) NULL;

-- Details HR adds to an issued warning; kind "revoke" records why it was revoked.
CREATE TABLE `WarnNote` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `warnId` INTEGER NOT NULL,
    `author` VARCHAR(80) NOT NULL,
    `body` TEXT NOT NULL,
    `kind` VARCHAR(16) NOT NULL DEFAULT 'note',
    `notified` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WarnNote_warnId_idx`(`warnId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
