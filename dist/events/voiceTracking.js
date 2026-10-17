import { Events } from "discord.js";
import { handleVoiceJoin, handleVoiceLeave } from "../services/attendance.js";
import { logger } from "../core/logger.js";
import { withDbRetry } from "../core/db.js";
import { cancelVoiceSummary, scheduleVoiceSummary } from "../services/voiceSummary.js";
export function registerVoiceTracking(client) {
    client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
        try {
            const joined = !oldState.channelId && newState.channelId;
            const left = oldState.channelId && !newState.channelId;
            const moved = oldState.channelId &&
                newState.channelId &&
                oldState.channelId !== newState.channelId;
            // Retry through transient DB lock contention: this event is the only
            // notice we get that someone joined or left.
            if (joined) {
                cancelVoiceSummary(newState.id);
                await withDbRetry(() => handleVoiceJoin(newState));
            }
            else if (left) {
                await withDbRetry(() => handleVoiceLeave(oldState));
                // After the session is closed and credited, so the total is current.
                if (!oldState.member?.user.bot)
                    scheduleVoiceSummary(oldState.guild.id, oldState.id);
            }
            else if (moved) {
                // close the old-channel session, open a new one
                await withDbRetry(() => handleVoiceLeave(oldState));
                await withDbRetry(() => handleVoiceJoin(newState));
            }
        }
        catch (err) {
            // The reconcile sweep re-derives state from Discord every 60s, so a lost
            // event self-heals; log it rather than letting it look like data loss.
            logger.error({ err }, "voiceTracking failed — reconcile sweep will repair within 60s");
        }
    });
}
//# sourceMappingURL=voiceTracking.js.map