import { logger } from "../core/logger.js";
import { EmsHttpError, describeEmsError } from "../lib/emsErrors.js";
import { EmsCoolingDown } from "../lib/emsBreaker.js";
import { env } from "../config/env.js";
import { ROSTER_IDS, claimModal, claimRoster, rosterComponents, rosterMessage, verifyModal, verifyRoster, } from "../services/rosterLink.js";
const idOf = (i) => (i.isButton() || i.isModalSubmit() ? i.customId : undefined);
/** Never log the error itself: an EmsHttpError message carries part of the response body. */
export function logRosterFailure(step, userId, err) {
    if (err instanceof EmsCoolingDown) {
        logger.info({ user: userId, step, reason: "paused", until: err.retryAt.toISOString() }, "EMS roster link skipped: calls paused");
        return;
    }
    let emsHost;
    try {
        emsHost = env.EMS_API_URL ? new URL(env.EMS_API_URL).host : undefined;
    }
    catch {
        emsHost = "invalid";
    }
    logger.warn({ user: userId, step, status: err instanceof EmsHttpError ? err.status : undefined, reason: describeEmsError(err), emsHost }, "EMS roster link failed");
}
/** What to tell the user when the EMS call threw: "busy" with a time while calls are paused. */
export function failureResult(err) {
    return err instanceof EmsCoolingDown ? { status: "busy", retryAt: err.retryAt.toISOString() } : { status: "error" };
}
/** Shared by /link and the two modals: the reply is ephemeral (deferred with the Ephemeral flag). */
export async function replyWith(i, r) {
    await i.editReply({ content: rosterMessage(r), components: rosterComponents(r) });
}
async function submit(i, step, call) {
    try {
        await replyWith(i, await call());
    }
    catch (err) {
        logRosterFailure(step, i.user.id, err);
        await replyWith(i, failureResult(err));
    }
}
const verifyButton = {
    id: ROSTER_IDS.verify,
    matches: (i) => i.isButton() && idOf(i) === ROSTER_IDS.verify,
    async handle(i) {
        if (i.isButton())
            await i.showModal(verifyModal());
    },
};
const verifySubmit = {
    id: ROSTER_IDS.verifyModal,
    ack: "reply",
    matches: (i) => i.isModalSubmit() && idOf(i) === ROSTER_IDS.verifyModal,
    async handle(i) {
        if (!i.isModalSubmit())
            return;
        await submit(i, "verify", () => verifyRoster(i.user.id, i.fields.getTextInputValue("email"), i.fields.getTextInputValue("phone")));
    },
};
const claimButton = {
    id: ROSTER_IDS.claim,
    matches: (i) => i.isButton() && idOf(i) === ROSTER_IDS.claim,
    async handle(i) {
        if (i.isButton())
            await i.showModal(claimModal());
    },
};
const claimSubmit = {
    id: ROSTER_IDS.claimModal,
    ack: "reply",
    matches: (i) => i.isModalSubmit() && idOf(i) === ROSTER_IDS.claimModal,
    async handle(i) {
        if (!i.isModalSubmit())
            return;
        await submit(i, "claim", () => claimRoster(i.user.id, i.fields.getTextInputValue("name"), i.fields.getTextInputValue("email"), i.fields.getTextInputValue("phone")));
    },
};
export const rosterLinkHandlers = [verifyButton, verifySubmit, claimButton, claimSubmit];
//# sourceMappingURL=rosterLink.js.map