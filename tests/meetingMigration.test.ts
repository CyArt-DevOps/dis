import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The migration runs on a table that already holds meetings, so the uid must be
// added nullable, backfilled, and only then made NOT NULL + unique.
const sql = readFileSync(new URL("../prisma/migrations/20261027090000_meeting_sync/migration.sql", import.meta.url), "utf8");
const at = (needle: string) => {
  const i = sql.indexOf(needle);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
};

describe("meeting_sync migration", () => {
  it("adds uid nullable, backfills with UUID(), then enforces NOT NULL and uniqueness", () => {
    const add = at("ADD COLUMN `uid` VARCHAR(36) NULL");
    const fill = at("UPDATE `Meeting` SET `uid` = UUID() WHERE `uid` IS NULL");
    const notNull = at("MODIFY `uid` VARCHAR(36) NOT NULL");
    const unique = at("CREATE UNIQUE INDEX `Meeting_uid_key`");
    expect(add).toBeLessThan(fill);
    expect(fill).toBeLessThan(notNull);
    expect(notNull).toBeLessThan(unique);
  });
  it("adds source, updatedAt, recurrenceUid and secondsAttended", () => {
    at("ADD COLUMN `source` VARCHAR(8) NOT NULL DEFAULT 'dis'");
    at("ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)");
    at("ADD COLUMN `recurrenceUid` VARCHAR(36) NULL");
    at("ADD COLUMN `secondsAttended` INTEGER NOT NULL DEFAULT 0");
  });
});
