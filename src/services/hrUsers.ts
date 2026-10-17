import { randomBytes } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { Lockout, generatePassword, hashPassword, readToken, signToken, verifyPassword, type HrClaims } from "../lib/hrAuth.js";

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
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

export async function activeHrNames(): Promise<string[]> {
  const rows = await prisma.hrUser.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: "asc" } });
  return rows.map((r) => r.name);
}

export async function verifyHr(
  name: string,
  password: string,
  ip: string
): Promise<{ token: string; name: string; expiresAt: number }> {
  const n = name.trim();
  for (const key of [`name:${n.toLowerCase()}`, `ip:${ip}`]) {
    const wait = lockout.lockedFor(key);
    if (wait > 0) throw new HrAuthError(`Too many failed attempts. Try again in ${Math.ceil(wait / 60_000)} min.`, 429);
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

declare module "express-serve-static-core" {
  interface Request {
    hr?: HrClaims;
  }
}

/**
 * Gate for write routes: a valid HR token in `X-HR-Token`, for an account that
 * is still active (disabling someone takes effect immediately).
 */
export const requireHr: RequestHandler = async (req, res, next) => {
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

export function hrName(req: Request): string {
  if (!req.hr) throw new HrAuthError("HR verification required.");
  return req.hr.name;
}

// --------------------------------------------------- account administration

export async function createHr(name: string): Promise<string> {
  const n = name.trim();
  if (n.length < 2 || n.length > 80) throw new Error("Name must be 2–80 characters.");
  const password = generatePassword();
  await prisma.hrUser.create({ data: { name: n, passwordHash: hashPassword(password) } });
  return password;
}

export async function resetHr(name: string): Promise<string> {
  const password = generatePassword();
  await prisma.hrUser.update({ where: { name: name.trim() }, data: { passwordHash: hashPassword(password), active: true } });
  return password;
}

export async function setHrActive(name: string, active: boolean): Promise<void> {
  await prisma.hrUser.update({ where: { name: name.trim() }, data: { active } });
}

export async function listHr() {
  return prisma.hrUser.findMany({ orderBy: { name: "asc" }, select: { name: true, active: true, createdAt: true, lastUsedAt: true } });
}
