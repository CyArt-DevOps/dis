import { randomBytes } from "node:crypto";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { Lockout, generatePassword, hashPassword, readToken, signToken, verifyPassword } from "../lib/hrAuth.js";
/**
 * HR sign-off for sensitive dashboard actions. An HR member picks their name,
 * enters their own password, and gets a 10-minute token; the action records
 * that verified name instead of whatever was typed into a form.
 */
const TOKEN_TTL_MS = 10 * 60_000;
const SECRET = randomBytes(32);
const lockout = new Lockout(5, 15 * 60_000);
// Burned on a failed lookup so a missing name costs the same time as a wrong password.
const DUMMY_HASH = hashPassword(randomBytes(12).toString("hex"));
export class HrAuthError extends Error {
    status;
    constructor(message, status = 401) {
        super(message);
        this.status = status;
    }
}
export async function activeHrNames() {
    const rows = await prisma.hrUser.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: "asc" } });
    return rows.map((r) => r.name);
}
export async function verifyHr(name, password, ip) {
    const n = name.trim();
    for (const key of [`name:${n.toLowerCase()}`, `ip:${ip}`]) {
        const wait = lockout.lockedFor(key);
        if (wait > 0)
            throw new HrAuthError(`Too many failed attempts. Try again in ${Math.ceil(wait / 60_000)} min.`, 429);
    }
    const user = n ? await prisma.hrUser.findUnique({ where: { name: n } }) : null;
    const ok = verifyPassword(password, user?.passwordHash ?? DUMMY_HASH) && Boolean(user?.active);
    if (!user || !ok) {
        lockout.fail(`name:${n.toLowerCase()}`);
        lockout.fail(`ip:${ip}`);
        logger.warn({ name: n, ip }, "HR verification failed");
        throw new HrAuthError("Name or password is incorrect.");
    }
    lockout.clear(`name:${n.toLowerCase()}`);
    await prisma.hrUser.update({ where: { id: user.id }, data: { lastUsedAt: new Date() } });
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    logger.info({ hr: user.name, ip }, "HR verified");
    return { token: signToken({ id: user.id, name: user.name, exp: expiresAt }, SECRET), name: user.name, expiresAt };
}
/**
 * Gate for write routes: a valid HR token in `X-HR-Token`, for an account that
 * is still active (disabling someone takes effect immediately).
 */
export const requireHr = async (req, res, next) => {
    const claims = readToken(String(req.headers["x-hr-token"] ?? ""), SECRET);
    if (!claims) {
        res.status(401).json({ error: "HR verification required.", hrAuth: true });
        return;
    }
    const user = await prisma.hrUser.findUnique({ where: { id: claims.id }, select: { active: true, name: true } });
    if (!user?.active) {
        res.status(401).json({ error: "This HR account is disabled.", hrAuth: true });
        return;
    }
    req.hr = { ...claims, name: user.name };
    next();
};
export function hrName(req) {
    if (!req.hr)
        throw new HrAuthError("HR verification required.");
    return req.hr.name;
}
/** An HR member changes their own password (current password required). */
export async function changeOwnPassword(name, current, next, ip) {
    if (next.length < 9 || next.length > 128)
        throw new HrAuthError("New password must be at least 9 characters.", 400);
    if (!/[A-Za-z]/.test(next) || !/\d/.test(next))
        throw new HrAuthError("New password needs letters and numbers.", 400);
    if (next === current)
        throw new HrAuthError("New password must differ from the current one.", 400);
    await verifyHr(name, current, ip); // same lockout and timing as sign-in
    await prisma.hrUser.update({ where: { name: name.trim() }, data: { passwordHash: hashPassword(next) } });
    logger.info({ hr: name.trim(), ip }, "HR password changed");
}
// --------------------------------------------------- account administration
export async function setHrEmail(name, email) {
    const e = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
        throw new Error("Invalid email.");
    await prisma.hrUser.update({ where: { name: name.trim() }, data: { email: e } });
}
export async function createHr(name) {
    const n = name.trim();
    if (n.length < 2 || n.length > 80)
        throw new Error("Name must be 2–80 characters.");
    const password = generatePassword();
    await prisma.hrUser.create({ data: { name: n, passwordHash: hashPassword(password) } });
    return password;
}
export async function resetHr(name) {
    const password = generatePassword();
    await prisma.hrUser.update({ where: { name: name.trim() }, data: { passwordHash: hashPassword(password), active: true } });
    return password;
}
export async function setHrActive(name, active) {
    await prisma.hrUser.update({ where: { name: name.trim() }, data: { active } });
}
export async function listHr() {
    return prisma.hrUser.findMany({ orderBy: { name: "asc" }, select: { name: true, email: true, active: true, createdAt: true, lastUsedAt: true } });
}
//# sourceMappingURL=hrUsers.js.map