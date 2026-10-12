import { useEffect, useMemo, useState } from "react";
import { Button, ListBox, ListBoxItem, Select } from "@heroui/react";
import { get, monthKey, type FilterOptions, type Scope } from "./api";
import { useAsync } from "./lib/useAsync";
import { navigate, parseRoute, usePath } from "./lib/router";
import { FilterBar } from "./components/FilterBar";
import { OverviewPage } from "./pages/Overview";
import { MembersPage } from "./pages/Members";
import { CalendarsPage } from "./pages/Calendars";
import { ProfilePage } from "./pages/Profile";
import { MeetingsPage } from "./pages/Meetings";

const TABS = [
  { path: "/", name: "overview", label: "Overview" },
  { path: "/members", name: "members", label: "Members" },
  { path: "/calendar", name: "calendar", label: "Calendars" },
  { path: "/meetings", name: "meetings", label: "Meetings" },
] as const;

const RANGES = [
  { key: "1", label: "Today" },
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
  { key: "0", label: "All time" },
];

export default function App() {
  const path = usePath();
  const route = useMemo(() => parseRoute(path), [path]);

  const [scope, setScope] = useState<Scope>({});
  const [month, setMonth] = useState(monthKey());
  const [day, setDay] = useState("");
  const [days, setDays] = useState("7");

  const config = useAsync(
    () => get<{ timezone: string; today: string }>("/api/config"),
    []
  );
  const filters = useAsync(() => get<FilterOptions>("/api/filters"), []);

  // The member table defaults to today, which only the server knows in the
  // org's timezone — the browser may well be somewhere else.
  useEffect(() => {
    if (config.data && !day) setDay(config.data.today);
  }, [config.data, day]);

  const showFilters = route.name === "members" || route.name === "calendar";
  // Don't let the month pager walk back past the day tracking began — there is
  // nothing but empty grids before it.
  const minMonth = filters.data?.policy.trackingStartsOn?.slice(0, 7) ?? null;

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-default bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="text-base font-semibold tracking-tight"
          >
            Attendance <span className="text-indigo-400">Dashboard</span>
          </button>

          <nav className="flex flex-wrap gap-1">
            {TABS.map((t) => {
              const active =
                route.name === t.name || (t.name === "calendar" && route.name === "profile");
              return (
                <Button
                  key={t.path}
                  size="sm"
                  variant={active ? "primary" : "ghost"}
                  onPress={() => navigate(t.path)}
                >
                  {t.label}
                </Button>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {route.name === "overview" ? (
              <Select
                aria-label="Date range"
                className="min-w-[9rem]"
                selectedKey={days}
                onSelectionChange={(k) => setDays(String(k))}
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {RANGES.map((r) => (
                      <ListBoxItem key={r.key} id={r.key} textValue={r.label}>
                        {r.label}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            ) : null}
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {config.data ? `${config.data.timezone} · ${config.data.today}` : ""}
            </span>
          </div>
        </div>

        {showFilters ? (
          <div className="mx-auto max-w-[1400px] border-t border-default px-4 py-3 sm:px-6">
            <FilterBar options={filters.data} scope={scope} onChange={setScope} />
          </div>
        ) : null}
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6">
        {route.name === "overview" ? <OverviewPage days={Number(days)} /> : null}
        {route.name === "members" && day ? (
          <MembersPage scope={scope} day={day} onDay={setDay} />
        ) : null}
        {route.name === "calendar" ? (
          <CalendarsPage
            scope={scope}
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
          />
        ) : null}
        {route.name === "meetings" ? <MeetingsPage /> : null}
      </main>
    </div>
  );
}
