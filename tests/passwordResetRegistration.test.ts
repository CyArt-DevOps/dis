import { describe, it, expect } from "vitest";

// EMS spec 2026-11-17 §5: /reset-password is registered with the other commands (guild sync publishes it on start).
const { registry } = await import("../src/core/registry.js");
const { registerAllCommands } = await import("../src/commands/index.js");

describe("command registration", () => {
  it("registerAllCommands includes /reset-password next to /link", () => {
    registerAllCommands();
    expect(registry.commands.has("link")).toBe(true);
    expect(registry.commands.get("reset-password")?.data.toJSON().description).toBe("Reset your CyArt portal password");
  });
});
