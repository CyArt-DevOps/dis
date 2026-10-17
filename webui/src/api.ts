/** Types mirrored from the bot's services, and a tiny fetch helper. */

export type DayStatus =
  | "good"
  | "partial"
  | "missing"
  | "leave"
  | "off"
  | "untracked"
  | "future";

export interface CalendarDay {
  day: string;
  status: DayStatus;
  seconds: number;
  firstJoinAt: string | null;
  onTime: boolean;
}

export interface MemberCalendar {
  userId: string;
  fullName: string;
  batch: string | null;
  project: string | null;
  module: number | null;
  pod: number | null;
  days: CalendarDay[];
  totals: { good: number; partial: number; missing: number; leave: number };
  trackedFrom: string;
}

/** Compact wire format from /api/calendar — see compactCalendar on the server. */
export interface CompactCalendar {
  userId: string;
  fullName: string;
  batch: string | null;
  project: string | null;
  module: number | null;
  pod: number | null;
  status: string;
  detail: Record<string, { s: number; f: string | null; o: boolean }>;
  totals: { good: number; partial: number; missing: number; leave: number };
  trackedFrom: string;
}

const CODE_STATUS: Record<string, DayStatus> = {
  g: "good",
  p: "partial",
  m: "missing",
  l: "leave",
  o: "off",
  u: "untracked",
  f: "future",
};

export function expandCalendar(c: CompactCalendar, days: string[]): MemberCalendar {
  return {
    userId: c.userId,
    fullName: c.fullName,
    batch: c.batch,
    project: c.project,
    module: c.module,
    pod: c.pod,
    totals: c.totals,
    trackedFrom: c.trackedFrom,
    days: days.map((day, i) => {
      const d = c.detail[day];
      return {
        day,
        status: CODE_STATUS[c.status[i] ?? "o"] ?? "off",
        seconds: d?.s ?? 0,
        firstJoinAt: d?.f ?? null,
        onTime: d?.o ?? false,
      };
    }),
  };
}

export interface FilterOptions {
  batches: string[];
  projects: string[];
  modules: number[];
  pods: number[];
  policy: {
    windowStart: string;
    loginBy: string;
    windowEnd: string;
    minHours: number;
    workdays: number[];
    trackingStartsOn: string | null;
  };
}

export interface ComplianceRow {
  userId: string;
  fullName: string;
  batch: string | null;
  project: string | null;
  module: number | null;
  pod: number | null;
  seconds: number;
  requiredSeconds: number;
  firstJoinAt: string | null;
  lastSeenAt: string | null;
  live: boolean;
  loginOnTime: boolean;
  metHours: boolean;
  status: string;
}

export interface ComplianceReport {
  day: string;
  workday: boolean;
  policy: { windowStart: string; loginBy: string; windowEnd: string; minHours: number };
  rows: ComplianceRow[];
}

export interface Overview {
  voice: {
    from: string;
    to: string;
    today: string;
    liveNow: number;
    activeToday: number;
    totalSeconds: number;
    trackedMembers: number;
  };
  meetings: {
    records: number;
    totalMeetings: number;
    present: number;
    late: number;
    absent: number;
    excused: number;
    attendancePct: number;
    avgDelayMin: number;
  };
}

export interface LiveRow {
  userId: string;
  fullName: string;
  project: string | null;
  module: number | null;
  pod: number | null;
  channelId: string;
  joinedAt: string;
  seconds: number;
}

export interface VoiceDay {
  day: string;
  seconds: number;
  members: number;
}

export interface Profile {
  member: {
    userId: string;
    fullName: string;
    displayName: string | null;
    tag: string | null;
    batch: string | null;
    project: string | null;
    module: number | null;
    pod: number | null;
    verificationStatus: string;
    joinedAt: string;
  } | null;
  calendar: MemberCalendar | null;
  live: boolean;
  lastSeenAt: string | null;
  meetings: {
    meetingId: number;
    title: string;
    status: string;
    minutesLate: number;
    scheduledStart: string;
  }[];
  leaves: {
    id: number;
    type: string;
    status: string;
    startAt: string;
    endAt: string;
    reason: string;
    approvedDays: string | null;
    reviewedById: string | null;
    reviewedAt: string | null;
  }[];
  insights: MemberInsights | null;
}

export type ViolationKind =
  | "absent"
  | "late-login"
  | "short-hours"
  | "meeting-absent"
  | "meeting-late"
  | "warning";

export interface Violation {
  kind: ViolationKind;
  severity: "high" | "medium" | "low";
  day: string;
  detail: string;
  minutesLate?: number;
  servedSeconds?: number;
  requiredSeconds?: number;
}

export interface MemberInsights {
  details: {
    userId: string;
    registrationDate: string | null;
    flagged: boolean;
    updatedAt: string | null;
    trackedFrom: string | null;
  };
  period: {
    from: string;
    to: string;
    complianceRate: number;
    workdays: number;
    voiceSeconds: number;
    avgSecondsPerPresentDay: number;
    onTimeRate: number;
    avgFirstJoin: string | null;
    late: number;
    short: number;
    absent: number;
  };
  lifetime: {
    from: string;
    good: number;
    partial: number;
    missing: number;
    leave: number;
    complianceRate: number;
    voiceSeconds: number;
    presentDays: number;
    currentStreak: number;
    bestStreak: number;
    absentStreak: number;
  };
  violations: Violation[];
  lifetimeViolations: {
    absent: number;
    late: number;
    short: number;
    meetingAbsent: number;
    meetingLate: number;
    warnings: number;
  };
  meetingStats: {
    present: number;
    late: number;
    absent: number;
    excused: number;
    pct: number;
    avgMinutesLate: number;
  };
  warns: { reason: string; by: string; at: string }[];
  tickets: {
    id: number;
    type: string;
    subject: string;
    status: string;
    createdAt: string;
    closedAt: string | null;
  }[];
  daily: { day: string; seconds: number; firstJoin: string | null; status: string }[];
  projectRank: { rank: number; of: number } | null;
}

export interface OrgInsights {
  range: { from: string; to: string; settledThrough: string };
  policy: { loginBy: string; minHours: number; windowStart: string; windowEnd: string };
  members: number;
  activeMembers: number;
  inactiveMembers: number;
  unassignedMembers: number;
  totals: {
    good: number;
    partial: number;
    missing: number;
    leave: number;
    late: number;
    short: number;
    lateAndShort: number;
    voiceSeconds: number;
  };
  complianceRate: number;
  avgLateMinutes: number;
  trend: {
    day: string;
    workday: boolean;
    settled: boolean;
    good: number;
    partial: number;
    missing: number;
    leave: number;
    active: number;
    seconds: number;
    rate: number;
  }[];
  arrivals: { label: string; count: number; late: boolean }[];
  projects: {
    project: string;
    members: number;
    active: number;
    good: number;
    partial: number;
    missing: number;
    leave: number;
    rate: number;
    voiceSeconds: number;
    avgSecondsPerPresentDay: number;
  }[];
  topViolators: {
    userId: string;
    fullName: string;
    project: string | null;
    batch: string | null;
    absent: number;
    late: number;
    short: number;
    avgLateMinutes: number;
    rate: number;
    score: number;
  }[];
  topPerformers: {
    userId: string;
    fullName: string;
    project: string | null;
    good: number;
    rate: number;
    voiceSeconds: number;
  }[];
  latestWorkday: {
    day: string;
    good: number;
    late: number;
    short: number;
    lateAndShort: number;
    absent: number;
    leave: number;
  } | null;
  pendingLeaves: number;
  openTickets: number;
  warnings: number;
  meetings: {
    id: number;
    title: string;
    startAt: string;
    status: string;
    present: number;
    late: number;
    absent: number;
    excused: number;
    pct: number;
  }[];
}

export interface MeetingRow {
  id: number;
  title: string;
  startAt: string;
  durationMin: number;
  status: string;
  counts: Record<string, number>;
}

export interface MeetingDetail {
  meeting: {
    id: number;
    title: string;
    description: string | null;
    startAt: string;
    durationMin: number;
    status: string;
    audienceType: string;
    audienceBatch: string | null;
    audienceProject: string | null;
    audienceModule: number | null;
    audiencePod: number | null;
    mandatory: boolean;
    attendanceWindowMin: number;
    organizerName: string;
  };
  attendees: {
    userId: string;
    fullName: string | null;
    batch: string | null;
    project: string | null;
    module: number | null;
    pod: number | null;
    status: string;
    actualJoinAt: string | null;
    minutesLate: number;
    leaveStatus: string | null;
  }[];
}

export interface Scope {
  batch?: string;
  project?: string;
  module?: number;
  pod?: number;
  q?: string;
}

export function scopeQuery(scope: Scope): string {
  const p = new URLSearchParams();
  if (scope.batch) p.set("batch", scope.batch);
  if (scope.project) p.set("project", scope.project);
  if (scope.module !== undefined) p.set("module", String(scope.module));
  if (scope.pod !== undefined) p.set("pod", String(scope.pod));
  if (scope.q) p.set("q", scope.q);
  return p.toString();
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export function hm(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export function dayLabel(
  day: string,
  opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }
): string {
  return new Date(day + "T00:00:00Z").toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}

export function dateOf(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function timeOf(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
