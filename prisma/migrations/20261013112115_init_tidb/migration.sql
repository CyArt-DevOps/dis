-- CreateTable
CREATE TABLE `Member` (
    `id` VARCHAR(191) NOT NULL,
    `guildId` VARCHAR(191) NOT NULL,
    `tag` VARCHAR(191) NULL,
    `fullName` VARCHAR(191) NULL,
    `displayName` VARCHAR(191) NULL,
    `batch` VARCHAR(191) NULL,
    `project` VARCHAR(191) NULL,
    `module` INTEGER NULL,
    `pod` INTEGER NULL,
    `registrationDate` DATETIME(3) NULL,
    `verificationStatus` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `flagged` BOOLEAN NOT NULL DEFAULT false,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Member_guildId_idx`(`guildId`),
    UNIQUE INDEX `Member_guildId_id_key`(`guildId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Ticket` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guildId` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NULL,
    `type` VARCHAR(191) NOT NULL,
    `subject` TEXT NOT NULL,
    `openerId` VARCHAR(191) NOT NULL,
    `claimedById` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,
    `closedById` VARCHAR(191) NULL,

    INDEX `Ticket_guildId_status_idx`(`guildId`, `status`),
    INDEX `Ticket_openerId_idx`(`openerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VoiceSession` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guildId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NOT NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `leftAt` DATETIME(3) NULL,
    `seconds` INTEGER NULL,
    `creditedUpTo` DATETIME(3) NULL,

    INDEX `VoiceSession_userId_idx`(`userId`),
    INDEX `VoiceSession_guildId_userId_idx`(`guildId`, `userId`),
    INDEX `VoiceSession_guildId_joinedAt_idx`(`guildId`, `joinedAt`),
    INDEX `VoiceSession_leftAt_idx`(`leftAt`),
    INDEX `VoiceSession_guildId_channelId_joinedAt_idx`(`guildId`, `channelId`, `joinedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Attendance` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guildId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `day` VARCHAR(191) NOT NULL,
    `seconds` INTEGER NOT NULL DEFAULT 0,

    INDEX `Attendance_userId_idx`(`userId`),
    INDEX `Attendance_guildId_day_idx`(`guildId`, `day`),
    UNIQUE INDEX `Attendance_guildId_userId_day_key`(`guildId`, `userId`, `day`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Warn` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guildId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `modId` VARCHAR(191) NOT NULL,
    `reason` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Warn_guildId_userId_idx`(`guildId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VoiceGrant` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guildId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NOT NULL,
    `grantedById` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revoked` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `VoiceGrant_guildId_revoked_idx`(`guildId`, `revoked`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Meeting` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guildId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `durationMin` INTEGER NOT NULL,
    `audienceType` VARCHAR(191) NOT NULL,
    `audienceBatch` VARCHAR(191) NULL,
    `audienceProject` VARCHAR(191) NULL,
    `audienceModule` INTEGER NULL,
    `audiencePod` INTEGER NULL,
    `audienceMemberIds` TEXT NULL,
    `office` VARCHAR(191) NULL,
    `notifyChannelId` VARCHAR(191) NULL,
    `voiceChannelId` VARCHAR(191) NOT NULL,
    `mandatory` BOOLEAN NOT NULL DEFAULT true,
    `attendanceWindowMin` INTEGER NOT NULL DEFAULT 10,
    `reminderIntervalMin` INTEGER NULL,
    `remindersSent` VARCHAR(500) NOT NULL DEFAULT '',
    `status` VARCHAR(191) NOT NULL DEFAULT 'scheduled',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Meeting_guildId_status_idx`(`guildId`, `status`),
    INDEX `Meeting_startAt_idx`(`startAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MeetingAttendance` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `meetingId` INTEGER NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `fullName` VARCHAR(191) NULL,
    `batch` VARCHAR(191) NULL,
    `project` VARCHAR(191) NULL,
    `module` INTEGER NULL,
    `pod` INTEGER NULL,
    `scheduledStart` DATETIME(3) NOT NULL,
    `actualJoinAt` DATETIME(3) NULL,
    `leaveStatus` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL,
    `minutesLate` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `MeetingAttendance_userId_idx`(`userId`),
    UNIQUE INDEX `MeetingAttendance_meetingId_userId_key`(`meetingId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeaveRequest` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guildId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'casual',
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `reason` TEXT NOT NULL,
    `documentUrl` TEXT NULL,
    `channelId` VARCHAR(191) NULL,
    `approvedDays` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `reviewedById` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LeaveRequest_guildId_status_idx`(`guildId`, `status`),
    INDEX `LeaveRequest_userId_status_idx`(`userId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ScheduledMessage` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guildId` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NOT NULL,
    `authorId` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `sendAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `sentAt` DATETIME(3) NULL,
    `messageId` VARCHAR(191) NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ScheduledMessage_status_sendAt_idx`(`status`, `sendAt`),
    INDEX `ScheduledMessage_guildId_authorId_status_idx`(`guildId`, `authorId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
