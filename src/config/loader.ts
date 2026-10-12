import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const projectSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  modules: z.number().int().nonnegative(),
  podsPerModule: z.number().int().nonnegative(),
  active: z.boolean(),
  // Optional display-name overrides per module number, e.g. { "5": "Team Velocity" }.
  // Unlisted modules keep the default "Module N" naming.
  moduleNames: z.record(z.string().min(1)).optional(),
  /**
   * Pod-based projects put all chat and voice at pod level. Set this to give
   * each module a module-wide chat + voice channel as well, for work that spans
   * pods. Ignored when podsPerModule is 0 — those modules always get their own
   * channels.
   */
  // Pod-based projects: add a module-wide chat + resources + voice channel.
  moduleChannels: z.boolean().default(false),
  // Pod-based projects: add ONLY a module-wide voice channel. Use this when
  // every VC is otherwise pod-specific and a module standup has nowhere to
  // meet, but module-wide text is already covered by `#<key>-mN-info`.
  moduleVoice: z.boolean().default(false),
});

const orgSchema = z.object({
  batches: z.array(z.string().min(1)),
  projects: z.array(projectSchema),
  nicknameFormat: z.string().default("{fullName} | {project}"),
  timezone: z.string().default("Asia/Kolkata"),
  roles: z.object({
    admin: z.array(z.string()),
    leadership: z.array(z.string()),
    intern: z.string(),
  }),
  categories: z.object({
    information: z.object({
      name: z.string(),
      channels: z.array(z.string()),
    }),
    hr: z.object({ name: z.string(), channels: z.array(z.string()) }),
    managerOffice: z.object({
      name: z.string(),
      textChannels: z.array(z.string()),
      voiceChannels: z.array(z.string()),
    }),
    hrOffice: z.object({
      name: z.string(),
      textChannels: z.array(z.string()),
      voiceChannels: z.array(z.string()),
    }),
    tickets: z.object({ name: z.string() }),
    archive: z.object({ name: z.string() }),
    logs: z.object({ name: z.string() }),
  }),
  /**
   * Daily voice-presence policy, in the org timezone. Defaults mirror the rules
   * posted in #rules: join between 11:30 and 14:00, serve 5h30m, Mon–Fri.
   */
  attendancePolicy: z
    .object({
      // Earliest the working window opens ("HH:MM"); joining before this is fine.
      windowStart: z.string().regex(/^\d{1,2}:\d{2}$/).default("11:30"),
      // Latest a member may first join and still count as an on-time login.
      loginBy: z.string().regex(/^\d{1,2}:\d{2}$/).default("14:00"),
      // End of the working window, for reference in the UI.
      windowEnd: z.string().regex(/^\d{1,2}:\d{2}$/).default("17:30"),
      // Minimum connected hours expected per working day.
      minHours: z.number().positive().default(5.5),
      // ISO weekdays that are working days (1 = Monday … 7 = Sunday).
      workdays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
      /**
       * First day attendance was actually being recorded (YYYY-MM-DD). Earlier
       * days have no data because nothing was tracking yet, not because anyone
       * was absent, so they are reported as "untracked" instead of "missing".
       */
      trackingStartsOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .default({}),
});

export type OrgConfig = z.infer<typeof orgSchema>;
export type ProjectDef = z.infer<typeof projectSchema>;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Single canonical location for the runtime-mutable org config, anchored at the
 * PROJECT ROOT (`<root>/config/org.json`) — not inside `src`/`dist`.
 *
 * Resolving relative to this module (`src/config` or `dist/config` → up two →
 * root) means the exact same file is read whether the bot runs via tsx or from
 * `dist`, and regardless of `cwd` (pm2/services change it). This is what stops
 * a rebuild or redeploy from silently reverting projects created with
 * `/project create`. Override with ORG_CONFIG_PATH (e.g. a Docker volume mount).
 */
export const CONFIG_PATH = process.env.ORG_CONFIG_PATH ?? resolve(here, "..", "..", "config", "org.json");

const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const parsed = orgSchema.safeParse(raw);
if (!parsed.success) {
  console.error(`Invalid org config at ${CONFIG_PATH}:`, parsed.error.flatten());
  process.exit(1);
}

export const org: OrgConfig = parsed.data;

export function activeProjects(): ProjectDef[] {
  // Active projects may have zero modules/pods (e.g. a new project not yet
  // broken into modules). They still get a category + roles + channels.
  return org.projects.filter((p) => p.active);
}

export function findProject(key: string): ProjectDef | undefined {
  return org.projects.find((p) => p.key === key);
}
