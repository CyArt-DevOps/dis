-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guildId" TEXT NOT NULL,
    "tag" TEXT,
    "batch" TEXT,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT,
    "type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "openerId" TEXT NOT NULL,
    "claimedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "closedById" TEXT
);

-- CreateTable
CREATE TABLE "VoiceSession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" DATETIME,
    "seconds" INTEGER,
    CONSTRAINT "VoiceSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Warn" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "modId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Member_guildId_idx" ON "Member"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_guildId_id_key" ON "Member"("guildId", "id");

-- CreateIndex
CREATE INDEX "Ticket_guildId_status_idx" ON "Ticket"("guildId", "status");

-- CreateIndex
CREATE INDEX "Ticket_openerId_idx" ON "Ticket"("openerId");

-- CreateIndex
CREATE INDEX "VoiceSession_guildId_userId_idx" ON "VoiceSession"("guildId", "userId");

-- CreateIndex
CREATE INDEX "VoiceSession_guildId_joinedAt_idx" ON "VoiceSession"("guildId", "joinedAt");

-- CreateIndex
CREATE INDEX "Attendance_guildId_day_idx" ON "Attendance"("guildId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_guildId_userId_day_key" ON "Attendance"("guildId", "userId", "day");

-- CreateIndex
CREATE INDEX "Warn_guildId_userId_idx" ON "Warn"("guildId", "userId");
