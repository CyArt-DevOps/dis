-- CreateTable
CREATE TABLE "Meeting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "organizerId" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "audienceType" TEXT NOT NULL,
    "audienceBatch" TEXT,
    "audienceProject" TEXT,
    "audienceModule" INTEGER,
    "audiencePod" INTEGER,
    "voiceChannelId" TEXT NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "attendanceWindowMin" INTEGER NOT NULL DEFAULT 10,
    "reminderIntervalMin" INTEGER,
    "remindersSent" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MeetingAttendance" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "meetingId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT,
    "batch" TEXT,
    "project" TEXT,
    "module" INTEGER,
    "pod" INTEGER,
    "scheduledStart" DATETIME NOT NULL,
    "actualJoinAt" DATETIME,
    "leaveStatus" TEXT,
    "status" TEXT NOT NULL,
    "minutesLate" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MeetingAttendance_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedById" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guildId" TEXT NOT NULL,
    "tag" TEXT,
    "fullName" TEXT,
    "displayName" TEXT,
    "batch" TEXT,
    "project" TEXT,
    "module" INTEGER,
    "pod" INTEGER,
    "registrationDate" DATETIME,
    "verificationStatus" TEXT NOT NULL DEFAULT 'pending',
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Member" ("batch", "guildId", "id", "joinedAt", "tag", "updatedAt") SELECT "batch", "guildId", "id", "joinedAt", "tag", "updatedAt" FROM "Member";
DROP TABLE "Member";
ALTER TABLE "new_Member" RENAME TO "Member";
CREATE INDEX "Member_guildId_idx" ON "Member"("guildId");
CREATE UNIQUE INDEX "Member_guildId_id_key" ON "Member"("guildId", "id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Meeting_guildId_status_idx" ON "Meeting"("guildId", "status");

-- CreateIndex
CREATE INDEX "Meeting_startAt_idx" ON "Meeting"("startAt");

-- CreateIndex
CREATE INDEX "MeetingAttendance_userId_idx" ON "MeetingAttendance"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingAttendance_meetingId_userId_key" ON "MeetingAttendance"("meetingId", "userId");

-- CreateIndex
CREATE INDEX "LeaveRequest_guildId_status_idx" ON "LeaveRequest"("guildId", "status");

-- CreateIndex
CREATE INDEX "LeaveRequest_userId_status_idx" ON "LeaveRequest"("userId", "status");
