import type { FilterOptions, Scope } from "../api";
import { Button, Select } from "./ui";

const ALL = "";

/**
 * Batch / project / module / pod filters plus the name search. Scope is owned
 * by App so every view stays in sync when the user switches tabs.
 */
export function FilterBar({
  options,
  scope,
  onChange,
}: {
  options: FilterOptions | null;
  scope: Scope;
  onChange: (next: Scope) => void;
}) {
  const set = (patch: Partial<Scope>) => onChange({ ...scope, ...patch });
  const active =
    scope.batch || scope.project || scope.module !== undefined || scope.pod !== undefined || scope.q;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-72">
        <svg className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
        <input
          aria-label="Search members"
          value={scope.q ?? ""}
          onChange={(e) => set({ q: e.target.value || undefined })}
          placeholder="Search members by name…"
          className="h-9 w-full rounded-full border border-line-strong bg-panel pr-3 pl-10 text-sm text-fg outline-none placeholder:text-dim focus-visible:ring-2 focus-visible:ring-white/30"
        />
      </div>
      <Select
        label="Batch"
        className="min-w-[9rem]"
        value={scope.batch ?? ALL}
        onChange={(v) => set({ batch: v || undefined })}
        options={[{ value: ALL, label: "All batches" }, ...(options?.batches ?? []).map((b) => ({ value: b, label: b }))]}
      />
      <Select
        label="Project"
        className="min-w-[10rem]"
        value={scope.project ?? ALL}
        onChange={(v) => set({ project: v || undefined })}
        options={[{ value: ALL, label: "All projects" }, ...(options?.projects ?? []).map((p) => ({ value: p, label: p }))]}
      />
      <Select
        label="Module"
        className="min-w-[8.5rem]"
        value={scope.module === undefined ? ALL : String(scope.module)}
        onChange={(v) => set({ module: v ? Number(v) : undefined })}
        options={[{ value: ALL, label: "All modules" }, ...(options?.modules ?? []).map((m) => ({ value: String(m), label: `Module ${m}` }))]}
      />
      <Select
        label="Pod"
        className="min-w-[7.5rem]"
        value={scope.pod === undefined ? ALL : String(scope.pod)}
        onChange={(v) => set({ pod: v ? Number(v) : undefined })}
        options={[{ value: ALL, label: "All pods" }, ...(options?.pods ?? []).map((p) => ({ value: String(p), label: `Pod ${p}` }))]}
      />
      {active ? (
        <Button size="sm" variant="ghost" onClick={() => onChange({})}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}
