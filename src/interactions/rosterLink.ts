import type { Interaction, InteractionEditReplyOptions, ModalSubmitInteraction } from "discord.js";
import type { InteractionHandler } from "../core/registry.js";
import { logger } from "../core/logger.js";
import { EmsHttpError } from "../lib/emsErrors.js";
import {
  ROSTER_IDS,
  claimModal,
  claimRoster,
  rosterComponents,
  rosterMessage,
  verifyModal,
  verifyRoster,
  type RosterResult,
} from "../services/rosterLink.js";

const idOf = (i: Interaction) => (i.isButton() || i.isModalSubmit() ? i.customId : undefined);

/** Never log the error itself: an EmsHttpError message carries part of the response body. */
export function logRosterFailure(step: string, userId: string, err: unknown): void {
  logger.warn({ user: userId, step, status: err instanceof EmsHttpError ? err.status : undefined }, "EMS roster link failed");
}

/** Shared by /link and the two modals: the reply is ephemeral (deferred with the Ephemeral flag). */
export async function replyWith(i: { editReply(o: InteractionEditReplyOptions): Promise<unknown> }, r: RosterResult) {
  await i.editReply({ content: rosterMessage(r), components: rosterComponents(r) });
}

async function submit(i: ModalSubmitInteraction, step: string, call: () => Promise<RosterResult>) {
  try {
    await replyWith(i, await call());
  } catch (err) {
    logRosterFailure(step, i.user.id, err);
    await replyWith(i, { status: "error" });
  }
}

const verifyButton: InteractionHandler = {
  id: ROSTER_IDS.verify,
  matches: (i) => i.isButton() && idOf(i) === ROSTER_IDS.verify,
  async handle(i) {
    if (i.isButton()) await i.showModal(verifyModal());
  },
};

const verifySubmit: InteractionHandler = {
  id: ROSTER_IDS.verifyModal,
  ack: "reply",
  matches: (i) => i.isModalSubmit() && idOf(i) === ROSTER_IDS.verifyModal,
  async handle(i) {
    if (!i.isModalSubmit()) return;
    await submit(i, "verify", () =>
      verifyRoster(i.user.id, i.fields.getTextInputValue("email"), i.fields.getTextInputValue("phone")));
  },
};

const claimButton: InteractionHandler = {
  id: ROSTER_IDS.claim,
  matches: (i) => i.isButton() && idOf(i) === ROSTER_IDS.claim,
  async handle(i) {
    if (i.isButton()) await i.showModal(claimModal());
  },
};

const claimSubmit: InteractionHandler = {
  id: ROSTER_IDS.claimModal,
  ack: "reply",
  matches: (i) => i.isModalSubmit() && idOf(i) === ROSTER_IDS.claimModal,
  async handle(i) {
    if (!i.isModalSubmit()) return;
    await submit(i, "claim", () =>
      claimRoster(i.user.id, i.fields.getTextInputValue("name"), i.fields.getTextInputValue("email"), i.fields.getTextInputValue("phone")));
  },
};

export const rosterLinkHandlers: InteractionHandler[] = [verifyButton, verifySubmit, claimButton, claimSubmit];
