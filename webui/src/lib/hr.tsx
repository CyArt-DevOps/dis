import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { get } from "../api";
import { Badge, Button, Select, cx } from "../components/ui";

/**
 * HR sign-off. Sensitive actions (leave, warnings, terminations, holidays)
 * call `withHr(token => ...)`; if nobody is verified, a dialog asks for the HR
 * member's name and their own password. The server returns a 10-minute token,
 * held in memory only, never in storage, so closing the tab signs out.
 */

interface Session {
  token: string;
  name: string;
  expiresAt: number;
}

export class HrError extends Error {
  constructor(message: string, readonly hrAuth: boolean) {
    super(message);
  }
}

/** POST with the HR token attached; marks auth failures so we can re-prompt. */
export async function hrPost<T>(path: string, body: unknown, token: string): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-HR-Token": token },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; hrAuth?: boolean };
  if (!res.ok) throw new HrError(data.error ?? `Request failed (${res.status})`, Boolean(data.hrAuth));
  return data as T;
}

interface Ctx {
  session: Session | null;
  withHr: <T>(fn: (token: string) => Promise<T>, purpose?: string) => Promise<T>;
  signOut: () => void;
}

const HrContext = createContext<Ctx | null>(null);

export function useHr(): Ctx {
  const c = useContext(HrContext);
  if (!c) throw new Error("useHr outside HrProvider");
  return c;
}

const NAME_KEY = "dash.hrName";

export function HrProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [prompt, setPrompt] = useState<{ purpose: string } | null>(null);
  const pending = useRef<{ resolve: (s: Session) => void; reject: (e: Error) => void } | null>(null);

  // Drop the session when it expires.
  useEffect(() => {
    if (!session) return;
    const t = window.setTimeout(() => setSession(null), Math.max(0, session.expiresAt - Date.now()));
    return () => window.clearTimeout(t);
  }, [session]);

  const ask = useCallback(
    (purpose: string) =>
      new Promise<Session>((resolve, reject) => {
        pending.current = { resolve, reject };
        setPrompt({ purpose });
      }),
    []
  );

  const withHr = useCallback(
    async <T,>(fn: (token: string) => Promise<T>, purpose = "Confirm this action"): Promise<T> => {
      let s = session && session.expiresAt > Date.now() + 5000 ? session : null;
      if (!s) s = await ask(purpose);
      try {
        return await fn(s.token);
      } catch (e) {
        // Token rejected (expired, account disabled, bot restarted): verify again once.
        if (e instanceof HrError && e.hrAuth) {
          setSession(null);
          const fresh = await ask(purpose);
          return fn(fresh.token);
        }
        throw e;
      }
    },
    [session, ask]
  );

  const close = (err?: Error, s?: Session) => {
    setPrompt(null);
    if (s) {
      setSession(s);
      pending.current?.resolve(s);
    } else pending.current?.reject(err ?? new Error("HR verification cancelled."));
    pending.current = null;
  };

  return (
    <HrContext.Provider value={{ session, withHr, signOut: () => setSession(null) }}>
      {children}
      {prompt ? <VerifyDialog purpose={prompt.purpose} onDone={(s) => close(undefined, s)} onCancel={() => close()} /> : null}
    </HrContext.Provider>
  );
}

function VerifyDialog({ purpose, onDone, onCancel }: { purpose: string; onDone: (s: Session) => void; onCancel: () => void }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void get<string[]>("/api/hr/names")
      .then((n) => {
        setNames(n);
        setName((cur) => (n.includes(cur) ? cur : n[0] ?? ""));
      })
      .catch(() => setNames([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/hr/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password }),
      });
      const data = (await res.json().catch(() => ({}))) as Session & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Verification failed.");
      try {
        localStorage.setItem(NAME_KEY, data.name);
      } catch {
        /* name not remembered */
      }
      onDone({ token: data.token, name: data.name, expiresAt: data.expiresAt });
    } catch (e) {
      setError((e as Error).message);
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/75 p-4 backdrop-blur-sm" onClick={() => !busy && onCancel()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label="HR verification"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="w-full max-w-sm rounded-2xl border border-line-strong bg-panel p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-line-strong bg-panel-2">
            <svg viewBox="0 0 24 24" className="size-5 text-fg" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
              <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
              <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
            </svg>
          </div>
          <div>
            <h2 className="text-gradient text-lg font-semibold">HR verification</h2>
            <p className="text-xs text-muted">{purpose}. Sign off with your own HR password.</p>
          </div>
        </div>

        {names && names.length === 0 ? (
          <p className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">
            No HR accounts exist yet. An admin must create them first (npm run hr -- add "Name").
          </p>
        ) : (
          <div className="space-y-3">
            <label className="block text-xs text-muted">
              Name
              <Select
                label="HR name"
                className="mt-1.5"
                value={name}
                onChange={setName}
                options={(names ?? []).map((n) => ({ value: n, label: n }))}
              />
            </label>
            <label className="block text-xs text-muted">
              Your HR password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="off"
                placeholder="xxxx-xxxx-xxxx-xxxx"
                className={cx(
                  "mt-1.5 h-10 w-full rounded-full border bg-panel px-4 text-sm text-fg outline-none placeholder:text-dim focus-visible:ring-2 focus-visible:ring-white/30",
                  error ? "border-rose-400/50" : "border-line-strong"
                )}
              />
            </label>
            {error ? <p className="rounded-lg border border-rose-400/25 bg-rose-400/5 px-3 py-2 text-xs text-rose-300">{error}</p> : null}
            <p className="text-[11px] text-dim">Stays verified for 10 minutes in this tab. Every action is recorded under your name.</p>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy || !name || !password}>
            {busy ? "Verifying…" : "Verify"}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Small "Verified as …" pill with sign-out, for the sidebar. */
export function HrBadge() {
  const { session, signOut } = useHr();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!session) return;
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [session]);
  if (!session) return null;
  const mins = Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 60_000));
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-xs">
      <span className="min-w-0">
        <span className="block text-[10px] tracking-[0.08em] text-emerald-300/80 uppercase">HR verified</span>
        <span className="block truncate font-medium text-fg">{session.name}</span>
      </span>
      <span className="flex items-center gap-2">
        <Badge tone="good">{mins}m</Badge>
        <button type="button" onClick={signOut} className="text-dim hover:text-fg" title="Sign out of HR">
          ✕
        </button>
      </span>
    </div>
  );
}

/** `hp(path, body, purpose)`: POST signed off by a verified HR member. */
export function useHrPost() {
  const { withHr } = useHr();
  return useCallback(
    <T = unknown,>(path: string, body: unknown = {}, purpose?: string) => withHr((token) => hrPost<T>(path, body, token), purpose),
    [withHr]
  );
}

/** Lets an HR member replace their password (current one required). */
export function HrPasswordLink() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="px-1 text-[11px] text-dim hover:text-fg">
        Change HR password
      </button>
      {open ? <ChangePasswordDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  useEffect(() => {
    void get<string[]>("/api/hr/names")
      .then((n) => {
        setNames(n);
        setName((cur) => (n.includes(cur) ? cur : n[0] ?? ""));
      })
      .catch(() => setNames([]));
  }, []);

  const problem =
    next && next.length < 9
      ? "At least 9 characters."
      : next && (!/[A-Za-z]/.test(next) || !/\d/.test(next))
        ? "Use letters and numbers."
        : again && again !== next
          ? "Passwords don't match."
          : null;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/hr/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, current, next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not change the password.");
      setMsg({ tone: "good", text: "Password changed. Use the new one from now on." });
      setCurrent("");
      setNext("");
      setAgain("");
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const input =
    "mt-1.5 h-10 w-full rounded-full border border-line-strong bg-panel px-4 text-sm text-fg outline-none placeholder:text-dim focus-visible:ring-2 focus-visible:ring-white/30";
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/75 p-4 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="w-full max-w-sm space-y-3 rounded-2xl border border-line-strong bg-panel p-6 shadow-2xl"
      >
        <h2 className="text-gradient text-lg font-semibold">Change HR password</h2>
        <label className="block text-xs text-muted">
          Name
          <Select label="HR name" className="mt-1.5" value={name} onChange={setName} options={names.map((n) => ({ value: n, label: n }))} />
        </label>
        <label className="block text-xs text-muted">
          Current password
          <input type="password" autoComplete="off" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
        </label>
        <label className="block text-xs text-muted">
          New password
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
        </label>
        <label className="block text-xs text-muted">
          Repeat new password
          <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} className={input} />
        </label>
        {problem ? <p className="text-xs text-amber-300">{problem}</p> : null}
        {msg ? (
          <p className={cx("rounded-lg border px-3 py-2 text-xs", msg.tone === "good" ? "border-emerald-400/25 bg-emerald-400/5 text-emerald-300" : "border-rose-400/25 bg-rose-400/5 text-rose-300")}>
            {msg.text}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button variant="primary" type="submit" disabled={busy || !name || !current || !next || next !== again || Boolean(problem)}>
            {busy ? "Saving…" : "Change password"}
          </Button>
        </div>
      </form>
    </div>
  );
}
