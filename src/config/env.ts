import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN required"),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID required"),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID required"),
  DATABASE_URL: z.string().min(1).default("file:./data/app.db"),
  // Pterodactyl (and most panels) hand the allocated port in SERVER_PORT; fall
  // back to it so the dashboard binds what the host actually routes.
  WEB_PORT: z.coerce.number().int().positive().default(8090),
  // Host to bind. Unset = loopback only (127.0.0.1 + ::1), the safe local
  // default. Set to 0.0.0.0 to expose it, which REQUIRES WEB_PASSWORD.
  WEB_HOST: z.string().optional(),
  // Password for the dashboard gate. Unset disables the gate, which is only
  // acceptable while bound to loopback.
  WEB_PASSWORD: z.string().min(8).optional(),
  // Send the session cookie as Secure. On behind TLS (Cloudflare), off for
  // plain-HTTP local testing.
  WEB_SECURE_COOKIE: z
    .enum(["0", "1"])
    .default("1")
    .transform((v) => v === "1"),
  // EMS integration. Unset = integration off (v1 API answers 503, outbox idle).
  // Key EMS sends as `Authorization: Bearer` when it reads /api/v1/*.
  DIS_API_KEY: z.string().min(32).optional(),
  // Base URL of the EMS backend, no trailing slash, e.g. http://localhost:5000
  EMS_API_URL: z.string().url().optional(),
  // Shared HMAC secret for requests the bot sends to EMS (same value in EMS .env).
  INTEGRATION_SECRET: z.string().min(32).optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = schema.safeParse({
  ...process.env,
  WEB_PORT: process.env.WEB_PORT ?? process.env.SERVER_PORT,
});
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
