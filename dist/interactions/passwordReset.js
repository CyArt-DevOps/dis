import { submit } from "./rosterLink.js";
import { EMAIL_RE, RESET_IDS, resetPassword } from "../services/passwordReset.js";
const INVALID_EMAIL = "That doesn't look like an email address. Run /reset-password again and type your portal email.";
/**
 * /reset-password modal submit (EMS spec 2026-11-17 §5). The dispatcher defers it ephemerally (ack "reply"), so the
 * reply — which may hold a temporary password — is private. Failures log the step and status only (never the body).
 */
const resetSubmit = {
    id: RESET_IDS.modal,
    ack: "reply",
    matches: (i) => i.isModalSubmit() && i.customId === RESET_IDS.modal,
    async handle(i) {
        if (!i.isModalSubmit())
            return;
        const email = i.fields.getTextInputValue(RESET_IDS.email).trim();
        if (email.length > 254 || !EMAIL_RE.test(email)) {
            await i.editReply({ content: INVALID_EMAIL, components: [] });
            return;
        }
        await submit(i, "reset", () => resetPassword(i.user.id, email), { command: "/reset-password" });
    },
};
export const passwordResetHandlers = [resetSubmit];
//# sourceMappingURL=passwordReset.js.map