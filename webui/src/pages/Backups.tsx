import { useEffect, useState } from "react";
import { useHr, useHrDownload, useHrPost } from "../lib/hr";
import { Button, Card, CardHeader, Empty, ErrorNote, PageHeader, Skeleton } from "../components/ui";

interface BackupRow {
  file: string;
  project: string;
  size: number;
  createdAt: string;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const size = (b: number) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`);

/**
 * Message backups saved by /project dissolve: one Discord-style HTML file per
 * dissolved project. They hold everyone's messages, so HR verification is required.
 */
export function BackupsPage() {
  const { session } = useHr();
  const hp = useHrPost();
  const download = useHrDownload();
  const [rows, setRows] = useState<BackupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      setRows(await hp<BackupRow[]>("/api/backups/list", {}, "View message backups"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (session && rows === null && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const get = async (file: string) => {
    setBusy(file);
    setError(null);
    try {
      await download("/api/backups/download", { file }, "Download a message backup", file);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Backups"
        description="Every message of a dissolved project, saved by /project dissolve before its channels were deleted. Open the file in any browser."
      />
      {error ? <ErrorNote message={error} /> : null}

      {rows === null ? (
        <Card>
          <div className="flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted">These files hold everyone's messages. Verify as HR to view them.</p>
            <Button variant="primary" disabled={loading} onClick={load}>
              {loading ? "Loading…" : "Verify and view"}
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="min-w-0">
          <CardHeader
            title="Message backups"
            subtitle="Latest first"
            action={
              <Button onClick={load} disabled={loading}>
                {loading ? "Refreshing…" : "Refresh"}
              </Button>
            }
          />
          <div className="mt-3 border-t border-line">
            {loading && !rows.length ? (
              <div className="space-y-2 p-5">
                {Array.from({ length: 3 }, (_, k) => (
                  <Skeleton key={k} className="h-10" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <Empty>No project has been dissolved yet.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {rows.map((r) => (
                  <li key={r.file} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="font-medium text-fg">{r.project.replace(/-/g, " ")}</div>
                      <div className="truncate text-xs text-dim">
                        {when(r.createdAt)} · {size(r.size)} · {r.file}
                      </div>
                    </div>
                    <Button size="sm" disabled={busy === r.file} onClick={() => get(r.file)}>
                      {busy === r.file ? "Downloading…" : "Download"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
