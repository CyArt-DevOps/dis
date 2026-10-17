import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * shadcn/ui-flavoured primitives in the BagUI look. Kept local and tiny: the
 * dashboard needs buttons, panels, badges and a select — not a component
 * framework.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "outline" | "ghost";

export function Button({
  variant = "outline",
  size = "md",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-4 text-sm",
        variant === "primary" && "bg-white text-black hover:bg-zinc-200",
        variant === "outline" && "border border-line-strong bg-panel text-fg hover:bg-panel-3",
        variant === "ghost" && "text-muted hover:bg-white/5 hover:text-fg",
        className
      )}
    >
      {children}
    </button>
  );
}

export function Card({
  className,
  children,
  as: Tag = "div",
}: {
  className?: string;
  children: ReactNode;
  as?: "div" | "section";
}) {
  return (
    <Tag className={cx("rounded-2xl border border-line bg-panel", className)}>{children}</Tag>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex items-start justify-between gap-3 px-5 pt-5", className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-fg">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-xs text-dim">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "leave" | "info";

const TONE: Record<Tone, string> = {
  neutral: "border-line-strong bg-white/[0.03] text-muted",
  good: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
  warn: "border-amber-400/20 bg-amber-400/10 text-amber-300",
  bad: "border-rose-400/25 bg-rose-400/10 text-rose-300",
  leave: "border-orange-400/20 bg-orange-400/10 text-orange-300",
  info: "border-indigo-300/20 bg-indigo-300/10 text-indigo-200",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  dot,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        TONE[tone],
        className
      )}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function Select({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <div className={cx("relative", className)}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full appearance-none rounded-full border border-line-strong bg-panel pr-8 pl-3.5 text-sm text-fg outline-none hover:bg-panel-3 focus-visible:ring-2 focus-visible:ring-white/30"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-dim"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
      >
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-full border border-line bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            "h-7 rounded-full px-3 text-xs font-medium transition-colors",
            o.value === value ? "bg-white text-black" : "text-muted hover:text-fg"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
}) {
  const color =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-rose-300"
          : tone === "info"
            ? "text-indigo-200"
            : tone === "leave"
              ? "text-orange-300"
              : "text-gradient";
  return (
    <div className="relative min-w-0 bg-panel p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-dim uppercase">{label}</span>
        {icon ? <span className="text-dim">{icon}</span> : null}
      </div>
      <div className={cx("mt-2 truncate text-[26px] leading-none font-semibold tracking-tight tabular-nums", color)}>
        {value}
      </div>
      {hint ? <div className="mt-2 truncate text-xs text-dim">{hint}</div> : null}
    </div>
  );
}

/** Stats separated by hairlines inside one bordered panel — the BagUI grid. */
export function StatStrip({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 | 5 | 6 }) {
  const grid =
    cols === 6
      ? "2xl:grid-cols-6"
      : cols === 5
        ? "xl:grid-cols-5"
        : cols === 3
          ? "lg:grid-cols-3"
          : "xl:grid-cols-4";
  return (
    <div
      className={cx(
        "grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3",
        grid
      )}
    >
      {children}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton rounded-lg", className)} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-8 text-center text-sm text-dim">{children}</p>;
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-rose-400/25 bg-rose-400/5 px-5 py-4 text-sm text-rose-300">
      {message}
    </div>
  );
}

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials = name
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  // Stable hue per name so the same person always gets the same tint.
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <div
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full border border-line-strong font-semibold text-fg"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        background: `radial-gradient(circle at 30% 25%, hsl(${h} 45% 32%), hsl(${h} 30% 12%))`,
      }}
    >
      {initials || "?"}
    </div>
  );
}

/** Thin horizontal meter. */
export function Meter({ value, tone = "good" }: { value: number; tone?: Tone }) {
  const bg =
    tone === "bad" ? "bg-rose-400" : tone === "warn" ? "bg-amber-400" : tone === "info" ? "bg-indigo-300" : "bg-emerald-400";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div className={cx("h-full rounded-full", bg)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function rateTone(rate: number): Tone {
  return rate >= 70 ? "good" : rate >= 40 ? "warn" : "bad";
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="relative">
      <div className="bg-grid pointer-events-none absolute inset-x-0 -top-6 h-40" />
      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted">
              {eyebrow}
            </div>
          ) : null}
          <h1 className="text-gradient text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          {description ? <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p> : null}
        </div>
        {action}
      </div>
    </div>
  );
}
