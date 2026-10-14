# Deployment — MonkeyBytes + Cloudflare

Production target for the CyArt intern bot and its dashboard.

| Piece | Value |
|---|---|
| Panel | https://dash.monkey-network.xyz · server **Intern Bot** (`18955455`) |
| Allocation | `us.monkey-network.xyz:5015` (1 of 1) |
| Repo | `https://github.com/CyArt-DevOps/dis` (public, branch `main`) |
| Runtime | Pterodactyl Node.js egg, Docker image **Nodejs 25** |
| Dashboard URL | https://dis.cyart.io |
| Database | TiDB Cloud Starter `cyart-intern-bot`, us-east-1, free ($0 spend limit) |

## Database

Data lives in TiDB Cloud, not on this server. The host is disposable: if
MonkeyBytes deletes the container, reinstall and start — nothing is lost but
uptime. `DATABASE_URL` in the host `.env` is the TiDB connection string.

Notes that matter when changing the schema:

- The provider is `mysql` with `relationMode = "prisma"`, so foreign keys are
  emulated by the client. Writes must go through Prisma.
- Free-text columns are `@db.Text`; MySQL's default `VARCHAR(191)` is too short
  for real leave reasons (the longest in production is 1572 characters).
- `remindersSent` is `VARCHAR(500)` on purpose: MySQL forbids `DEFAULT` on TEXT.
- The attendance upsert in `services/attendance.ts` is hand-written MySQL
  (`ON DUPLICATE KEY UPDATE`, `LEAST()`), not portable SQL.
- `DATABASE_URL` must carry `&connect_timeout=30&pool_timeout=30`. TiDB Starter
  scales to zero when idle and the first connection waits for it to resume;
  Prisma's 5s default surfaces that as `P1001: Can't reach database server`.
- `connectDb` retries unreachable-database errors indefinitely with capped
  backoff. Nothing restarts this process if it exits, so a transient blip used
  to take the bot down until someone pressed Start.

`prisma/data/app.db` on the host is the pre-cutover SQLite file, kept as a
rollback. It stops being current the moment the bot runs on TiDB.

### Rollback

1. `git revert` the TiDB merge on `main` and push.
2. Put the old `DATABASE_URL=file:./data/app.db?...` back in the host `.env`.
3. Restart. Anything written to TiDB after cutover is not in that file.

## How it fits together

The panel runs `npm install --production` and then `node dist/index.js` — it
never runs `npm start`. Three consequences drive the setup:

1. **`dist/` and `webui/dist` are committed.** `--production` omits typescript
   and vite, so the host cannot build. Run `npm run build && npm run build:ui`
   locally and commit the output with every change.
2. **`prisma` is a runtime dependency**, not a dev one, so `postinstall` can run
   `prisma generate` on the host.
3. **Migrations run at boot**, from `applyMigrations()` in `src/index.ts`, which
   is the only hook that executes with `.env` loaded.

The bot process also serves the dashboard (`startDashboard()` on ClientReady),
so one process covers both and fits the single allocated port.

## Cloudflare (done)

- `dis.cyart.io` → **CNAME** → `usa.monkey-network.xyz`, **Proxied**
- Configuration Rule *"dis.cyart.io - SSL Full for MonkeyBytes origin"*:
  `http.host eq "dis.cyart.io"` → SSL: **Full**

The zone stays on **Full (strict)**; only this hostname is relaxed to Full, which
is what MonkeyBytes requires. Do not change the zone-wide mode — the other eight
cyart.io hostnames rely on strict validation.

## Panel (done)

Startup → `GIT REPO ADDRESS` = repo URL, `INSTALL BRANCH` = `main`,
`MAIN FILE` = `dist/index.js`, `AUTO UPDATE` = on, `USER UPLOADED FILES` = off.
Whitelabel → `dis.cyart.io` on port `5015`.

## Remaining steps (need credentials — do these yourself)

1. **Install.** Settings → Reinstall Server. This clones the repo and runs
   `npm install --production`. The repo is public, so no git credentials are
   needed — leave `GIT USERNAME` and `GIT ACCESS TOKEN` empty.
2. **`.env`.** Files tab → New File named `.env`, using `.env.example` as the
   shape. For production it must contain:

   ```
   DISCORD_TOKEN=<the bot token>
   DISCORD_CLIENT_ID=1491834973416591370
   DISCORD_GUILD_ID=1520702519049982042
   DATABASE_URL=file:./data/app.db?connection_limit=1&socket_timeout=20
   WEB_HOST=0.0.0.0
   WEB_PASSWORD=<a strong password, 8+ chars>
   WEB_SECURE_COOKIE=1
   NODE_ENV=production
   ```

   `WEB_HOST=0.0.0.0` is what makes the dashboard reachable; without
   `WEB_PASSWORD` it refuses to start rather than serve member data unguarded.
3. **Database.** Stop the local bot, then:

   ```bash
   npm run db:snapshot
   ```

   Upload the resulting `prisma/data/snapshot/app.db` to `prisma/data/app.db`
   on the host (Files tab → navigate into `prisma/data` → Upload).

   Do not hand-copy `app.db`: SQLite runs in WAL mode here, so recent writes sit
   in `app.db-wal` and a plain copy loses them. The snapshot folds the WAL in and
   compacts the file. It holds every member, meeting, attendance and leave
   record — starting without it gives an empty bot.
4. **Start**, then watch Console for `Attendance dashboard listening` with
   `authenticated: true`, and visit https://dis.cyart.io.

## Important

- **The repo is public.** Nothing secret lives in it (`.env` and the database are
  gitignored), but the source, org structure in `config/org.json` and the guild
  id are all readable. Keep it that way: never commit `.env`, `prisma/data/`, or
  a backup dump.

- **One bot at a time.** Stop the local `npm run dev` before starting the host,
  or two processes answer every interaction and both write to their own copy of
  the database.
- The database becomes authoritative **on the server** once it runs there. Local
  runs after that point diverge; pull a fresh copy down before working locally.
- Renewal bytes: the server costs 1 byte per cycle. If the balance runs out the
  bot stops. Check the panel's Bytes page periodically.

## Updating

```bash
npm run build && npm run build:ui
git add -A && git commit -m "..." && git push
```

Then restart the server in the panel — `AUTO UPDATE` pulls `main` on boot.
