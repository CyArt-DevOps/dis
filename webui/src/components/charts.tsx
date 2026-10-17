import { useState, type ReactNode } from "react";
import { cx } from "./ui";

/**
 * Small purpose-built SVG charts. Each one answers a single question, renders
 * in the dashboard's own tokens, and shows a hover readout — enough that a
 * chart library (and its bundle) isn't needed.
 */

const C = {
  good: "#34d399",
  warn: "#fbbf24",
  bad: "#fb7185",
  leave: "#fb923c",
  info: "#a5b4fc",
  grid: "rgba(255,255,255,0.06)",
  axis: "#71717a",
  off: "rgba(255,255,255,0.06)",
};

function shortDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

function weekday(day: string): string {
  return new Date(day + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
}

function hours(seconds: number): string {
  return `${(seconds / 3600).toFixed(seconds >= 36000 ? 0 : 1)}h`;
}

/** Hover readout pinned above the chart. */
function Readout({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none mb-2 flex min-h-[20px] flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {children}
    </div>
  );
}

function Key({ color, label, value }: { color: string; label: string; value?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-sm" style={{ background: color }} />
      {label}
      {value !== undefined ? <b className="font-medium text-fg tabular-nums">{value}</b> : null}
    </span>
  );
}

// ------------------------------------------------------------ compliance

export interface TrendDay {
  day: string;
  workday: boolean;
  settled: boolean;
  good: number;
  partial: number;
  missing: number;
  leave: number;
  rate: number;
  active: number;
  seconds: number;
}

/** Stacked good / partial / missing per working day, with the rate on hover. */
export function ComplianceTrend({ days }: { days: TrendDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.good + d.partial + d.missing + d.leave));
  const H = 160;
  const n = days.length;
  const gap = n > 60 ? 1 : 3;
  const w = 100 / n;
  const h = hover !== null ? days[hover] : null;
  const labelEvery = Math.ceil(n / 8);

  return (
    <div>
      <Readout>
        {h ? (
          <>
            <b className="font-medium text-fg">
              {weekday(h.day)} {shortDay(h.day)}
            </b>
            {h.workday ? (
              <>
                <Key color={C.good} label="Completed" value={h.good} />
                <Key color={C.warn} label="Partial" value={h.partial} />
                <Key color={C.bad} label="Absent" value={h.missing} />
                <Key color={C.leave} label="Leave" value={h.leave} />
                <span>
                  rate <b className="font-medium text-fg">{h.rate}%</b>
                </span>
                {!h.settled ? <span className="text-amber-300">in progress</span> : null}
              </>
            ) : (
              <span>Non-working day · {h.active} joined anyway</span>
            )}
          </>
        ) : (
          <>
            <Key color={C.good} label="Completed" />
            <Key color={C.warn} label="Partial (late / short)" />
            <Key color={C.bad} label="Absent" />
            <Key color={C.leave} label="Leave" />
          </>
        )}
      </Readout>
      <div className="relative" style={{ height: H }} onMouseLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75].map((f) => (
          <div key={f} className="absolute inset-x-0 border-t border-dashed" style={{ top: H * f, borderColor: C.grid }} />
        ))}
        <div className="absolute inset-0 flex items-end">
          {days.map((d, i) => {
            const total = d.good + d.partial + d.missing + d.leave;
            const pct = (v: number) => `${(v / max) * 100}%`;
            return (
              <div
                key={d.day}
                className="flex h-full flex-col justify-end"
                style={{ width: `${w}%`, paddingLeft: gap / 2, paddingRight: gap / 2 }}
                onMouseEnter={() => setHover(i)}
              >
                {d.workday && total > 0 ? (
                  <div
                    className={cx(
                      "flex w-full flex-col-reverse overflow-hidden rounded-[3px] transition-opacity",
                      hover !== null && hover !== i && "opacity-40",
                      !d.settled && "opacity-50"
                    )}
                    style={{ height: pct(total) }}
                  >
                    <div style={{ height: `${(d.good / total) * 100}%`, background: C.good }} />
                    <div style={{ height: `${(d.partial / total) * 100}%`, background: C.warn }} />
                    <div style={{ height: `${(d.missing / total) * 100}%`, background: C.bad }} />
                    <div style={{ height: `${(d.leave / total) * 100}%`, background: C.leave }} />
                  </div>
                ) : (
                  <div className="h-1 w-full rounded-full" style={{ background: C.off }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="relative mt-2 h-3 text-[10px] text-dim">
        {days.map((d, i) =>
          i % labelEvery === 0 ? (
            <span
              key={d.day}
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${(i + 0.5) * w}%` }}
            >
              {shortDay(d.day)}
            </span>
          ) : null
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ voice area

export function VoiceArea({ days }: { days: TrendDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 150;
  const n = days.length;
  const maxS = Math.max(1, ...days.map((d) => d.seconds));
  const maxA = Math.max(1, ...days.map((d) => d.active));
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const yS = (s: number) => H - (s / maxS) * (H - 10);
  const yA = (a: number) => H - (a / maxA) * (H - 10);
  const line = days.map((d, i) => `${i ? "L" : "M"}${x(i)},${yS(d.seconds)}`).join(" ");
  const area = `${line} L${x(n - 1)},${H} L${x(0)},${H} Z`;
  const active = days.map((d, i) => `${i ? "L" : "M"}${x(i)},${yA(d.active)}`).join(" ");
  const h = hover !== null ? days[hover] : null;

  return (
    <div>
      <Readout>
        {h ? (
          <>
            <b className="font-medium text-fg">
              {weekday(h.day)} {shortDay(h.day)}
            </b>
            <Key color={C.info} label="Voice" value={hours(h.seconds)} />
            <Key color="#fafafa" label="Members present" value={h.active} />
            <span>avg {h.active ? hours(h.seconds / h.active) : "0h"} each</span>
          </>
        ) : (
          <>
            <Key color={C.info} label="Total voice hours" />
            <Key color="#fafafa" label="Members present" />
          </>
        )}
      </Readout>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[150px] w-full overflow-visible"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
          setHover(Math.max(0, Math.min(n - 1, i)));
        }}
      >
        <defs>
          <linearGradient id="va" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={C.info} stopOpacity="0.35" />
            <stop offset="100%" stopColor={C.info} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke={C.grid} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={area} fill="url(#va)" />
        <path d={line} fill="none" stroke={C.info} strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
        <path d={active} fill="none" stroke="#fafafa" strokeOpacity="0.55" strokeWidth="1.25" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        {hover !== null ? (
          <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke="rgba(255,255,255,0.25)" vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      <div className="mt-2 flex justify-between text-[10px] text-dim">
        <span>{days[0] ? shortDay(days[0].day) : ""}</span>
        <span>{days[n - 1] ? shortDay(days[n - 1]!.day) : ""}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ arrivals

export function ArrivalHistogram({
  buckets,
  cutoff,
}: {
  buckets: { label: string; count: number; late: boolean }[];
  cutoff: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const total = buckets.reduce((a, b) => a + b.count, 0);
  const late = buckets.filter((b) => b.late).reduce((a, b) => a + b.count, 0);
  const h = hover !== null ? buckets[hover] : null;
  return (
    <div>
      <Readout>
        {h ? (
          <>
            <b className="font-medium text-fg">
              {h.label}–{bucketEnd(h.label)}
            </b>
            <span>
              <b className="font-medium text-fg tabular-nums">{h.count}</b> first logins (
              {total ? Math.round((h.count / total) * 100) : 0}%)
            </span>
            {h.late ? <span className="text-rose-300">after {cutoff}</span> : null}
          </>
        ) : (
          <span>
            <b className="font-medium text-rose-300 tabular-nums">{total ? Math.round((late / total) * 100) : 0}%</b> of
            first logins land after the {cutoff} cutoff
          </span>
        )}
      </Readout>
      <div className="flex h-[120px] items-end gap-[3px]" onMouseLeave={() => setHover(null)}>
        {buckets.map((b, i) => (
          <div key={b.label} className="flex h-full flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
            <div
              className={cx("w-full rounded-t-[3px] transition-opacity", hover !== null && hover !== i && "opacity-40")}
              style={{
                height: `${Math.max(b.count ? 3 : 0, (b.count / max) * 100)}%`,
                background: b.late ? C.bad : "rgba(255,255,255,0.75)",
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex text-[10px] text-dim">
        {buckets.map((b, i) => (
          <div key={b.label} className="flex-1 text-center">
            {i % 4 === 0 ? b.label.replace(":00", "") : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function bucketEnd(label: string): string {
  const [h, m] = label.split(":").map(Number);
  const t = h! * 60 + m! + 30;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------ donut

export function Donut({
  segments,
  center,
  sub,
  size = 160,
}: {
  segments: { label: string; value: number; color: string }[];
  center: ReactNode;
  sub?: ReactNode;
  size?: number;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const r = 42;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="size-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="9" />
        {total > 0
          ? segments.map((s) => {
              const len = (s.value / total) * circ;
              const el = (
                <circle
                  key={s.label}
                  cx="50"
                  cy="50"
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="9"
                  strokeDasharray={`${Math.max(0, len - 0.6)} ${circ}`}
                  strokeDashoffset={-offset}
                >
                  <title>
                    {s.label}: {s.value}
                  </title>
                </circle>
              );
              offset += len;
              return el;
            })
          : null}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="text-2xl font-semibold tracking-tight tabular-nums">{center}</div>
          {sub ? <div className="text-[11px] text-dim">{sub}</div> : null}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ profile

export interface DailyPoint {
  day: string;
  seconds: number;
  firstJoin: string | null;
  status: string;
}

const STATUS_COLOR: Record<string, string> = {
  good: C.good,
  partial: C.warn,
  missing: C.bad,
  leave: C.leave,
  off: "rgba(255,255,255,0.18)",
  untracked: "rgba(255,255,255,0.06)",
  future: "rgba(255,255,255,0.04)",
};

/** Hours per day against the required line, coloured by the day's verdict. */
export function DailyHours({
  days,
  requiredHours,
  loginBy,
}: {
  days: DailyPoint[];
  requiredHours: number;
  loginBy: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const maxH = Math.max(requiredHours * 1.4, ...days.map((d) => d.seconds / 3600));
  const reqPct = (requiredHours / maxH) * 100;
  const h = hover !== null ? days[hover] : null;
  return (
    <div>
      <Readout>
        {h ? (
          <>
            <b className="font-medium text-fg">
              {weekday(h.day)} {shortDay(h.day)}
            </b>
            <span>
              served <b className="font-medium text-fg tabular-nums">{hours(h.seconds)}</b> / {requiredHours}h
            </span>
            <span>
              first join{" "}
              <b className={cx("font-medium tabular-nums", h.firstJoin && h.firstJoin > loginBy ? "text-rose-300" : "text-fg")}>
                {h.firstJoin ?? "—"}
              </b>
            </span>
          </>
        ) : (
          <>
            <Key color={C.good} label="Completed" />
            <Key color={C.warn} label="Partial" />
            <Key color={C.bad} label="Absent" />
            <span className="inline-flex items-center gap-1.5">
              <span className="w-4 border-t border-dashed border-white/50" /> {requiredHours}h target
            </span>
          </>
        )}
      </Readout>
      <div className="relative h-[140px]" onMouseLeave={() => setHover(null)}>
        <div className="absolute inset-x-0 border-t border-dashed border-white/40" style={{ bottom: `${reqPct}%` }} />
        <div className="absolute inset-0 flex items-end gap-[3px]">
          {days.map((d, i) => (
            <div key={d.day} className="flex h-full flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
              <div
                className={cx("w-full rounded-t-[3px] transition-opacity", hover !== null && hover !== i && "opacity-40")}
                style={{
                  height: d.seconds > 0 ? `${Math.max(2, (d.seconds / 3600 / maxH) * 100)}%` : "3px",
                  background: d.seconds > 0 || d.status === "missing" ? STATUS_COLOR[d.status] : STATUS_COLOR.off,
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex text-[10px] text-dim">
        {days.map((d, i) => (
          <div key={d.day} className="flex-1 text-center">
            {i % 5 === 0 ? Number(d.day.slice(-2)) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

/** First-join time per day vs the cutoff — shows lateness drifting. */
export function JoinTimeline({ days, loginBy }: { days: DailyPoint[]; loginBy: string }) {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const lo = 8 * 60;
  const hi = 20 * 60;
  const W = 600;
  const H = 120;
  const n = days.length;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * (W - 12) + 6);
  const y = (m: number) => ((Math.min(hi, Math.max(lo, m)) - lo) / (hi - lo)) * (H - 12) + 6;
  const cut = y(toMin(loginBy));
  const pts = days.map((d, i) => ({ d, i })).filter((p) => p.d.firstJoin);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[120px] w-full">
        <rect x="0" y={cut} width={W} height={H - cut} fill="rgba(251,113,133,0.06)" />
        <line x1="0" x2={W} y1={cut} y2={cut} stroke={C.bad} strokeOpacity="0.6" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        {pts.length > 1 ? (
          <path
            d={pts.map((p, k) => `${k ? "L" : "M"}${x(p.i)},${y(toMin(p.d.firstJoin!))}`).join(" ")}
            fill="none"
            stroke="rgba(255,255,255,0.25)"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {pts.map((p) => {
          const m = toMin(p.d.firstJoin!);
          const late = m > toMin(loginBy);
          return (
            <circle key={p.d.day} cx={x(p.i)} cy={y(m)} r="3.5" fill={late ? C.bad : C.good} vectorEffect="non-scaling-stroke">
              <title>
                {p.d.day} — joined {p.d.firstJoin}
                {late ? " (late)" : ""}
              </title>
            </circle>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-dim">
        <span>08:00 (top)</span>
        <span className="text-rose-300/80">cutoff {loginBy}</span>
        <span>20:00</span>
      </div>
    </div>
  );
}
