import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags } from "discord.js";

// EMS spec 2026-11-17 §5: /reset-password opens the email modal as its first (and only) response.
const emsPost = vi.fn();
let enabled = true;
vi.mock("../src/services/emsClient.js", () => ({ emsPost: (...a: unknown[]) => emsPost(...a), integrationEnabled: () => enabled }));

const { resetPasswordCommand } = await import("../src/commands/resetPassword.js");
const { RESET_IDS } = await import("../src/services/passwordReset.js");

function slash() {
  return { user: { id: "100000000000000001" }, reply: vi.fn(async () => {}), deferReply: vi.fn(async () => {}), showModal: vi.fn(async () => {}) };
}

beforeEach(() => { emsPost.mockReset(); enabled = true; });

describe("/reset-password", () => {
  it("is named reset-password with the spec description", () => {
    const json = resetPasswordCommand.data.toJSON();
    expect(json.name).toBe("reset-password");
    expect(json.description).toBe("Reset your CyArt portal password");
  });
  it("shows the reset modal without deferring and without calling EMS", async () => {
    const i = slash();
    await resetPasswordCommand.execute(i as never);
    expect(i.deferReply).not.toHaveBeenCalled();
    expect(i.reply).not.toHaveBeenCalled();
    expect((i.showModal.mock.calls[0]![0] as { toJSON: () => { custom_id: string } }).toJSON().custom_id).toBe(RESET_IDS.modal);
    expect(emsPost).not.toHaveBeenCalled();
  });
  it("integration off → plain ephemeral reply, no modal", async () => {
    enabled = false;
    const i = slash();
    await resetPasswordCommand.execute(i as never);
    expect(i.reply).toHaveBeenCalledWith({ content: "Password reset isn't available right now.", flags: MessageFlags.Ephemeral });
    expect(i.showModal).not.toHaveBeenCalled();
  });
});
