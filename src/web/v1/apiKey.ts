import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * Machine access for the EMS portal. Separate from the dashboard's password
 * cookie: EMS is a server, not a browser, and must not hold the staff password.
 * `getKey` is injected so tests don't depend on process env.
 */
export function apiKeyGuard(getKey: () => string | undefined): RequestHandler {
  return (req, res, next) => {
    const key = getKey();
    if (!key) {
      res.status(503).json({ error: "integration disabled" });
      return;
    }
    const header = String(req.headers.authorization ?? "");
    const got = Buffer.from(/^bearer /i.test(header) ? header.slice(7) : "");
    const want = Buffer.from(key);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
