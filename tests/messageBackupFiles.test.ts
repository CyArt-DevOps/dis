import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listMessageBackups, messageBackupName, resolveMessageBackup, safeProjectName } from "../src/services/messageBackupFiles.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mbf-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("messageBackupName", () => {
  it("uses a safe project name and an IST timestamp", () => {
    // 2026-11-17 06:30:05 UTC = 12:00:05 IST
    expect(messageBackupName("CyBreach 2.0 / M1", new Date("2026-11-17T06:30:05Z"))).toBe(
      "CyBreach-2-0-M1-messages-2026-11-17-120005.html"
    );
  });

  it("falls back when nothing safe is left", () => {
    expect(safeProjectName("✨✨")).toBe("project");
  });
});

describe("resolveMessageBackup", () => {
  it("returns the path of an existing backup", () => {
    writeFileSync(join(dir, "Alpha-messages-2026-11-17-120005.html"), "x");
    expect(resolveMessageBackup("Alpha-messages-2026-11-17-120005.html", dir)).toBe(join(dir, "Alpha-messages-2026-11-17-120005.html"));
  });

  it("rejects traversal, separators, other files and missing files", () => {
    writeFileSync(join(dir, "dissolve-alpha-1.json"), "{}");
    for (const bad of ["../Alpha-messages-2026-11-17-120005.html", "a/Alpha-messages-1.html", "a\\Alpha-messages-1.html", "dissolve-alpha-1.json", "Alpha-messages-2026-11-17-999999.html", ""]) {
      expect(resolveMessageBackup(bad, dir)).toBeNull();
    }
  });
});

describe("listMessageBackups", () => {
  it("lists only message backups, newest first, with project and size", () => {
    writeFileSync(join(dir, "Alpha-messages-2026-11-16-100000.html"), "aaaa");
    writeFileSync(join(dir, "Beta-Two-messages-2026-11-17-100000.html"), "bb");
    writeFileSync(join(dir, "dissolve-alpha-1.json"), "{}");
    utimesSync(join(dir, "Alpha-messages-2026-11-16-100000.html"), new Date("2026-11-16T04:30:00Z"), new Date("2026-11-16T04:30:00Z"));
    utimesSync(join(dir, "Beta-Two-messages-2026-11-17-100000.html"), new Date("2026-11-17T04:30:00Z"), new Date("2026-11-17T04:30:00Z"));
    const list = listMessageBackups(dir);
    expect(list.map((f) => f.file)).toEqual(["Beta-Two-messages-2026-11-17-100000.html", "Alpha-messages-2026-11-16-100000.html"]);
    expect(list[0]).toMatchObject({ project: "Beta-Two", size: 2 });
    expect(typeof list[0]!.createdAt).toBe("string");
  });

  it("returns an empty list when the folder does not exist", () => {
    expect(listMessageBackups(join(dir, "nope"))).toEqual([]);
  });
});
