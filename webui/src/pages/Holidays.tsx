import { useState } from "react";
import { dayLabel, get, type Holiday } from "../api";
import { useHrPost } from "../lib/hr";
import { useAsync } from "../lib/useAsync";
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, PageHeader, Skeleton, Stat, StatStrip } from "../components/ui";

export function HolidaysPage({ today }: { today: string }) {
  const { data, error, loading, reload } = useAsync(() => get<Holiday[]>("/api/holidays"), []);
  const [day, setDay] = useState("");
  const [name, setName] = useState("");
  const hp = useHrPost();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  const all = data ?? [];
  const upcoming = all.filter((h) => h.day >= today);
  const past = all.filter((h) => h.day < today).reverse();
  const next = upcoming[0];

  const add = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const row = await hp<Holiday>("/api/holidays", { day, name }, `Add holiday ${name}`);
      setMsg({ tone: "good", text: `${row.name} on ${dayLabel(row.day, { weekday: "long", day: "numeric", month: "long" })} added. Nobody is marked absent that day.` });
      setDay("");
      setName("");
      reload();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (h: Holiday) => {
    if (!window.confirm(`Remove ${h.name} (${h.day})? That day becomes a normal working day again.`)) return;
    try {
      await hp(`/api/holidays/${h.id}/delete`, {}, `Remove holiday ${h.name}`);
      setMsg({ tone: "good", text: `${h.name} removed.` });
      reload();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    }
  };

  const Row = ({ h, faded }: { h: Holiday; faded?: boolean }) => (
    <li className="flex items-center gap-4 px-5 py-3">
      <div className={`w-14 shrink-0 rounded-xl border border-line bg-panel-2 py-1.5 text-center ${faded ? "opacity-60" : ""}`}>
        <div className="text-[10px] tracking-wide text-sky-300 uppercase">{dayLabel(h.day, { month: "short" })}</div>
        <div className="text-lg leading-tight font-semibold tabular-nums">{Number(h.day.slice(-2))}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className={`truncate text-sm font-medium ${faded ? "text-muted" : ""}`}>{h.name}</div>
        <div className="text-xs text-dim">
          {dayLabel(h.day, { weekday: "long", year: "numeric" })}
          {h.addedBy ? ` · added by ${h.addedBy}` : ""}
        </div>
      </div>
      {h.day === today ? <Badge tone="info">Today</Badge> : null}
      <button type="button" onClick={() => remove(h)} className="text-xs text-dim hover:text-rose-300">
        remove
      </button>
    </li>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Public holidays"
        description="Holidays count like weekends everywhere: no absences, no short days, no warnings, and they don't break a streak."
      />
      {error ? <ErrorNote message={error} /> : null}

      <StatStrip cols={3}>
        <Stat label="Upcoming" value={upcoming.length} tone="info" />
        <Stat
          label="Next holiday"
          value={next ? dayLabel(next.day, { day: "numeric", month: "short" }) : "—"}
          hint={next ? next.name : "none scheduled"}
        />
        <Stat label="Past" value={past.length} />
      </StatStrip>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader title="Add a holiday" subtitle="Applies to the whole organisation" />
          <div className="space-y-3 p-5">
            <label className="block text-xs text-muted">
              Date
              <input
                type="date"
                value={day}
                onChange={(e) => setDay(e.target.value)}
                className="mt-1.5 h-9 w-full rounded-full border border-line-strong bg-panel px-3.5 text-sm text-fg [color-scheme:dark]"
              />
            </label>
            <label className="block text-xs text-muted">
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                placeholder="e.g. Diwali"
                className="mt-1.5 h-9 w-full rounded-full border border-line-strong bg-panel px-3.5 text-sm text-fg outline-none placeholder:text-dim"
              />
            </label>
            {msg ? (
              <p
                className={`rounded-lg border px-3 py-2 text-xs ${msg.tone === "good" ? "border-emerald-400/25 bg-emerald-400/5 text-emerald-300" : "border-rose-400/25 bg-rose-400/5 text-rose-300"}`}
              >
                {msg.text}
              </p>
            ) : null}
            <Button variant="primary" className="w-full" disabled={busy || !day || !name.trim()} onClick={add}>
              {busy ? "Adding…" : "Add holiday"}
            </Button>
          </div>
        </Card>

        <Card className="min-w-0 lg:col-span-3">
          <CardHeader title="Calendar" subtitle="Upcoming first" action={<Badge>{all.length}</Badge>} />
          <div className="scroll-thin mt-3 max-h-[60vh] overflow-y-auto border-t border-line">
            {loading && !data ? (
              <div className="space-y-2 p-5">
                {Array.from({ length: 4 }, (_, k) => (
                  <Skeleton key={k} className="h-12" />
                ))}
              </div>
            ) : all.length === 0 ? (
              <Empty>No holidays yet. Add one on the left.</Empty>
            ) : (
              <>
                <ul className="divide-y divide-line/60">
                  {upcoming.map((h) => (
                    <Row key={h.id} h={h} />
                  ))}
                </ul>
                {past.length ? (
                  <>
                    <div className="border-y border-line px-5 py-2 text-[11px] tracking-[0.08em] text-dim uppercase">Past</div>
                    <ul className="divide-y divide-line/60">
                      {past.map((h) => (
                        <Row key={h.id} h={h} faded />
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
