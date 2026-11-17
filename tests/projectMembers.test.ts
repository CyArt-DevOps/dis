import { describe, it, expect } from "vitest";
import { pickProjectMembers, type MemberLike } from "../src/lib/projectMembers.js";

const m = (id: string, roleNames: string[], over: Partial<MemberLike> = {}): MemberLike => ({
  id,
  tag: `user${id}`,
  bot: false,
  staff: false,
  roleNames,
  ...over,
});

const projectRoles = new Set(["Alpha", "Alpha Team Lead", "Alpha Module 1", "Alpha M1 P1 Representative"]);
const otherRoles = new Set(["Beta", "Beta Team Lead"]);

describe("pickProjectMembers", () => {
  it("removes interns, pod reps and leads holding a project role", () => {
    const r = pickProjectMembers(
      [m("1", ["Alpha", "Alpha Module 1"]), m("2", ["Alpha M1 P1 Representative"]), m("3", ["Alpha Team Lead"]), m("4", ["Gamer"])],
      projectRoles,
      otherRoles,
      new Set()
    );
    expect(r.remove.map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(r.skipped).toEqual([]);
  });

  it("also removes members the DB lists in the project without roles", () => {
    const r = pickProjectMembers([m("5", []), m("6", [])], projectRoles, otherRoles, new Set(["5"]));
    expect(r.remove.map((x) => x.id)).toEqual(["5"]);
  });

  it("skips bots, staff and members of another project, with reasons", () => {
    const r = pickProjectMembers(
      [
        m("7", ["Alpha"], { bot: true }),
        m("8", ["Alpha", "HR"], { staff: true }),
        m("9", ["Alpha", "Beta"]),
        m("10", ["Alpha"]),
      ],
      projectRoles,
      otherRoles,
      new Set()
    );
    expect(r.remove.map((x) => x.id)).toEqual(["10"]);
    expect(r.skipped).toEqual([
      { id: "7", tag: "user7", reason: "bot" },
      { id: "8", tag: "user8", reason: "staff" },
      { id: "9", tag: "user9", reason: "other project" },
    ]);
  });

  it("skips a member whose role name another project also uses (when in doubt, no kick)", () => {
    const r = pickProjectMembers([m("11", ["Alpha"])], projectRoles, new Set(["Alpha"]), new Set());
    expect(r.remove).toEqual([]);
    expect(r.skipped).toEqual([{ id: "11", tag: "user11", reason: "other project" }]);
  });
});
