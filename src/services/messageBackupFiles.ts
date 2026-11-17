import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Where dissolve backups (settings JSON + message HTML) are kept on the bot host. */
export function backupDir(): string {
  return resolve(process.cwd(), "data", "backups");
}

const FILE_RE = /^([A-Za-z0-9_-]+)-messages-(\d{4}-\d{2}-\d{2}-\d{6})\.html$/;

export function safeProjectName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "project";
}

/** `<Project>-messages-YYYY-MM-DD-HHmmss.html`, stamped in IST. */
export function messageBackupName(project: string, at: Date = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value])
  );
  return `${safeProjectName(project)}-messages-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}${p.second}.html`;
}

/** Absolute path of an existing message backup, or null for anything else (no path traversal). */
export function resolveMessageBackup(file: string, dir: string = backupDir()): string | null {
  if (typeof file !== "string" || !FILE_RE.test(file)) return null;
  const full = resolve(dir, file);
  return existsSync(full) ? full : null;
}

export interface MessageBackupFile {
  file: string;
  project: string;
  size: number;
  createdAt: string;
}

export function listMessageBackups(dir: string = backupDir()): MessageBackupFile[] {
  if (!existsSync(dir)) return [];
  const out: MessageBackupFile[] = [];
  for (const file of readdirSync(dir)) {
    const m = FILE_RE.exec(file);
    if (!m) continue;
    const st = statSync(resolve(dir, file));
    out.push({ file, project: m[1]!, size: st.size, createdAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
