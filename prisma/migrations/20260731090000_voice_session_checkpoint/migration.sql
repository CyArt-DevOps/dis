-- Checkpointed voice-session crediting: `creditedUpTo` is the high-water mark of
-- time already written into Attendance, so open sessions count toward "today"
-- while still connected and a crash loses at most one flush interval.
ALTER TABLE "VoiceSession" ADD COLUMN "creditedUpTo" DATETIME;

-- CreateIndex
CREATE INDEX "VoiceSession_leftAt_idx" ON "VoiceSession"("leftAt");

-- CreateIndex
CREATE INDEX "VoiceSession_guildId_channelId_joinedAt_idx" ON "VoiceSession"("guildId", "channelId", "joinedAt");
