import { useEffect, useState } from "react";

/**
 * Minimal history router. The app has three routes (dashboard, calendars,
 * profile), which doesn't justify pulling in react-router — the server already
 * serves index.html for any non-/api path, so deep links reload correctly.
 */
export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export interface Route {
  name: "overview" | "members" | "calendar" | "meetings" | "meeting" | "profile" | "warnings" | "holidays";
  userId?: string;
  meetingId?: number;
}

export function parseRoute(path: string): Route {
  const m = /^\/member\/([^/]+)/.exec(path);
  if (m) return { name: "profile", userId: decodeURIComponent(m[1]!) };
  if (path.startsWith("/calendar")) return { name: "calendar" };
  if (path.startsWith("/members")) return { name: "members" };
  const mt = /^\/meetings\/(\d+)/.exec(path);
  if (mt) return { name: "meeting", meetingId: Number(mt[1]) };
  if (path.startsWith("/meetings")) return { name: "meetings" };
  if (path.startsWith("/warnings")) return { name: "warnings" };
  if (path.startsWith("/holidays")) return { name: "holidays" };
  return { name: "overview" };
}
