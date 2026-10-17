import { useEffect, useMemo, useState, type ReactNode } from "react";
import { get, monthKey, type FilterOptions, type Scope } from "./api";
import { useAsync } from "./lib/useAsync";
import { navigate, parseRoute, usePath } from "./lib/router";
import { cx } from "./components/ui";
import { OverviewPage } from "./pages/Overview";
import { MembersPage } from "./pages/Members";
import { CalendarsPage } from "./pages/Calendars";
import { ProfilePage } from "./pages/Profile";
import { MeetingsPage } from "./pages/Meetings";
import { MeetingDetailPage } from "./pages/MeetingDetail";

const ICON: Record<string, ReactNode> = {
  overview: <path d="M3 13h4v8H3zM10 8h4v13h-4zM17 3h4v18h-4z" />,
  members: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.8a3.3 3.3 0 0 1 0 6.4M18.5 14.8c1.6.8 2.6 2.5 3 5.2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </>
  ),
  meetings: (
    <>
      <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
      <path d="M15.5 10.5 21.5 7v10l-6-3.5" />
    </>
  ),
};

const TABS = [
  { path: "/", name: "overview", label: "Overview" },
  { path: "/members", name: "members", label: "Members" },
  { path: "/calendar", name: "calendar", label: "Calendars" },
  { path: "/meetings", name: "meetings", label: "Meetings" },
] as const;

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICON[name]}
    </svg>
  );
}

function Logo() {
  return (
    <button type="button" onClick={() => navigate("/")} className="flex items-center gap-2.5 text-left">
      <img src="/logo.png" alt="CyArt" width={32} height={32} className="size-8 shrink-0 drop-shadow-[0_4px_12px_rgba(255,107,44,0.18)]" />
      <span className="leading-tight">
        <span className="block text-sm font-semibold tracking-tight">CyArt\Ops</span>
        <span className="block text-[11px] text-dim">Intern attendance</span>
      </span>
    </button>
  );
}

export default function App() {
  const path = usePath();
  const route = useMemo(() => parseRoute(path), [path]);

  const [scope, setScope] = useState<Scope>({});
  const [month, setMonth] = useState(monthKey());
  const [day, setDay] = useState("");
  const [days, setDays] = useState("30");

  const config = useAsync(() => get<{ timezone: string; today: string }>("/api/config"), []);
  const filters = useAsync(() => get<FilterOptions>("/api/filters"), []);

  // The member table defaults to today, which only the server knows in the
  // org's timezone — the browser may well be somewhere else.
  // On a weekend, open on the last working day instead: an off day shows
  // nothing but zeros.
  useEffect(() => {
    if (!config.data || !filters.data || day) return;
    const workdays = filters.data.policy.workdays;
    let d = config.data.today;
    for (let k = 0; k < 7; k++) {
      const wd = new Date(d + "T00:00:00Z").getUTCDay() || 7;
      if (workdays.includes(wd)) break;
      const prev = new Date(d + "T00:00:00Z");
      prev.setUTCDate(prev.getUTCDate() - 1);
      d = prev.toISOString().slice(0, 10);
    }
    setDay(d);
  }, [config.data, filters.data, day]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [path]);

  // Don't let the month pager walk back past the day tracking began.
  const minMonth = filters.data?.policy.trackingStartsOn?.slice(0, 7) ?? null;
  const isActive = (name: string) =>
    route.name === name ||
    (name === "members" && route.name === "profile") ||
    (name === "meetings" && route.name === "meeting");

  return (
    <div className="min-h-full lg:flex">
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-panel/60 px-4 py-5 lg:flex">
        <Logo />
        <nav className="mt-8 space-y-0.5">
          <div className="px-2 pb-2 text-[11px] font-medium tracking-[0.08em] text-dim uppercase">Workspace</div>
          {TABS.map((t) => (
            <button
              key={t.path}
              type="button"
              onClick={() => navigate(t.path)}
              className={cx(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                isActive(t.name) ? "bg-white/[0.07] text-fg" : "text-muted hover:bg-white/[0.04] hover:text-fg"
              )}
            >
              <Icon name={t.name} />
              {t.label}
            </button>
          ))}
        </nav>
        {filters.data ? (
          <div className="mt-auto rounded-xl border border-line bg-panel p-3 text-xs text-muted">
            <div className="mb-1.5 text-[11px] font-medium tracking-[0.08em] text-dim uppercase">Attendance rules</div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <span>Join by</span>
                <b className="font-medium text-fg">{filters.data.policy.loginBy}</b>
              </div>
              <div className="flex justify-between">
                <span>Minimum</span>
                <b className="font-medium text-fg">{filters.data.policy.minHours}h / day</b>
              </div>
              <div className="flex justify-between">
                <span>Window</span>
                <b className="font-medium text-fg">
                  {filters.data.policy.windowStart}–{filters.data.policy.windowEnd}
                </b>
              </div>
            </div>
          </div>
        ) : null}
        <div className="mt-3 px-1 text-[11px] text-dim">{config.data ? `${config.data.timezone} · ${config.data.today}` : ""}</div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Top bar (mobile) */}
        <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <Logo />
            <span className="text-[11px] text-dim">{config.data?.today ?? ""}</span>
          </div>
          <nav className="scroll-thin flex gap-1 overflow-x-auto px-3 pb-2.5">
            {TABS.map((t) => (
              <button
                key={t.path}
                type="button"
                onClick={() => navigate(t.path)}
                className={cx(
                  "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium",
                  isActive(t.name) ? "bg-white text-black" : "border border-line text-muted"
                )}
              >
                <Icon name={t.name} />
                {t.label}
              </button>
            ))}
          </nav>
        </header>

        <main className="mx-auto max-w-[1360px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {route.name === "overview" ? <OverviewPage days={days} onDays={setDays} /> : null}
          {route.name === "members" && day ? (
            <MembersPage scope={scope} onScope={setScope} filters={filters.data} day={day} onDay={setDay} />
          ) : null}
          {route.name === "calendar" ? (
            <CalendarsPage
              scope={scope}
              onScope={setScope}
              filters={filters.data}
              month={month}
              onMonth={setMonth}
              minMonth={minMonth}
            />
          ) : null}
          {route.name === "profile" && route.userId ? (
            <ProfilePage
              userId={route.userId}
              month={month}
              onMonth={setMonth}
              minMonth={minMonth}
              policy={filters.data?.policy ?? null}
              today={config.data?.today ?? new Date().toISOString().slice(0, 10)}
            />
          ) : null}
          {route.name === "meetings" ? <MeetingsPage /> : null}
          {route.name === "meeting" && route.meetingId ? <MeetingDetailPage id={route.meetingId} /> : null}
        </main>
      </div>
    </div>
  );
}
