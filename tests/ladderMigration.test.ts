import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Hand-written so it stays safe on a Warn table that already has rows: the new
// column is nullable and its unique index ignores NULLs.
const sql = readFileSync(new URL("../prisma/migrations/20261028090000_strictness_ladder/migration.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

describe("strictness_ladder migration", () => {
  it("adds Warn.externalUid nullable with a unique index", () => {
    expect(sql).toContain("ALTER TABLE `Warn` ADD COLUMN `externalUid` VARCHAR(36) NULL;");
    expect(sql).toContain("CREATE UNIQUE INDEX `Warn_externalUid_key` ON `Warn`(`externalUid`);");
    expect(sql).not.toMatch(/externalUid` VARCHAR\(36\) NOT NULL/);
  });
  it("creates BotSetting (key, value, updatedAt)", () => {
    expect(sql).toMatch(/CREATE TABLE `BotSetting` \(\s+`key` VARCHAR\(64\) NOT NULL,\s+`value` TEXT NOT NULL,\s+`updatedAt` DATETIME\(3\) NOT NULL,/);
    expect(sql).toContain("PRIMARY KEY (`key`)");
  });
  it("the schema matches: externalUid @unique, model BotSetting", () => {
    expect(schema).toMatch(/externalUid String\? @unique @db\.VarChar\(36\)/);
    expect(schema).toMatch(/model BotSetting \{/);
  });
});
