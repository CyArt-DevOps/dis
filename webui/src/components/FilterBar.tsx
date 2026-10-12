import { Button, ListBox, ListBoxItem, SearchField, Select } from "@heroui/react";
import type { FilterOptions, Scope } from "../api";

const ALL = "__all__";

function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { key: string; label: string }[];
  onChange: (key: string | undefined) => void;
}) {
  return (
    <Select
      aria-label={label}
      className="min-w-[9.5rem]"
      selectedKey={value || ALL}
      onSelectionChange={(key) => onChange(key === ALL ? undefined : String(key))}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBoxItem id={ALL} textValue={`All ${label.toLowerCase()}`}>
            All {label.toLowerCase()}
          </ListBoxItem>
          {options.map((o) => (
            <ListBoxItem key={o.key} id={o.key} textValue={o.label}>
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/**
 * Batch / project / module / pod filters plus the global name search. Scope is
 * owned by the page so every view stays in sync when the user switches tabs.
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
      <SearchField
        aria-label="Search members"
        className="w-full sm:w-72"
        value={scope.q ?? ""}
        onChange={(v) => set({ q: v || undefined })}
      >
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder="Search members by name…" />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>

      <Picker
        label="Batches"
        value={scope.batch ?? ALL}
        options={(options?.batches ?? []).map((b) => ({ key: b, label: b }))}
        onChange={(v) => set({ batch: v })}
      />
      <Picker
        label="Projects"
        value={scope.project ?? ALL}
        options={(options?.projects ?? []).map((p) => ({ key: p, label: p }))}
        onChange={(v) => set({ project: v })}
      />
      <Picker
        label="Modules"
        value={scope.module === undefined ? ALL : String(scope.module)}
        options={(options?.modules ?? []).map((m) => ({ key: String(m), label: `Module ${m}` }))}
        onChange={(v) => set({ module: v === undefined ? undefined : Number(v) })}
      />
      <Picker
        label="Pods"
        value={scope.pod === undefined ? ALL : String(scope.pod)}
        options={(options?.pods ?? []).map((p) => ({ key: String(p), label: `Pod ${p}` }))}
        onChange={(v) => set({ pod: v === undefined ? undefined : Number(v) })}
      />

      {active ? (
        <Button size="sm" variant="ghost" onPress={() => onChange({})}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}
