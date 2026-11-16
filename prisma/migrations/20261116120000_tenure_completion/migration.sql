-- Tenure Completed (2026-11-16): interns who report their internship tenure as complete from the EMS access announcement.
-- CreateTable
CREATE TABLE `TenureCompletion` (
    `userId` VARCHAR(32) NOT NULL,
    `guildId` VARCHAR(32) NOT NULL,
    `username` VARCHAR(100) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `handoverDone` BOOLEAN NOT NULL,
    `handoverDate` VARCHAR(10) NULL,
    `project` VARCHAR(100) NULL,
    `moduleNum` INTEGER NULL,
    `podNum` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TenureCompletion_guildId_updatedAt_idx`(`guildId`, `updatedAt`),
    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

