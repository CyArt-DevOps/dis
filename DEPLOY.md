# Deploying the bot (Hostinger VPS / any Ubuntu VPS)

The bot needs a machine that stays on 24/7 with a persistent disk. **Shared web
hosting (Hostinger "Business Web Hosting", cPanel, etc.) will NOT work** — it
kills background processes and has no Docker. Use a **VPS** (Hostinger KVM VPS,
or any Ubuntu 22.04+ VPS).

The SQLite database is a file at `data/app.db`. Docker keeps it on a mounted
volume so it survives restarts and redeploys.

---

## 1. Create the VPS

- Hostinger → **VPS** → pick a KVM plan (KVM 1 is plenty) → OS template
  **Ubuntu 22.04** (or "Ubuntu 24.04 with Docker" if offered — skips step 3).
- Note the server IP and root password (or add your SSH key).

## 2. Connect

```bash
ssh root@YOUR_SERVER_IP
```

## 3. Install Docker (skip if you chose a Docker template)

```bash
curl -fsSL https://get.docker.com | sh
```

Verify: `docker --version` and `docker compose version`.

## 4. Get the code onto the server

**Option A — git (recommended):** push this folder to a private GitHub repo, then:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/<you>/<repo>.git bot
cd bot
```

**Option B — direct copy (from your Windows machine):**

```bash
# run locally, in the project folder
scp -r ./* root@YOUR_SERVER_IP:/root/bot/
```

(Do NOT copy `node_modules`, `dist`, or `.env` into git; `.dockerignore`
already excludes them for the image build.)

## 5. Create the .env on the server

```bash
cd /root/bot
nano .env
```

Paste (use your **rotated** token — never the one shared in chat):

```
DISCORD_TOKEN=your-new-bot-token
DISCORD_CLIENT_ID=1491834973416591370
DISCORD_GUILD_ID=1520702519049982042
DATABASE_URL=file:./data/app.db
NODE_ENV=production
LOG_LEVEL=info
# optional web dashboard
WEB_TOKEN=some-long-random-string
```

Save (Ctrl-O, Enter, Ctrl-X).

## 6. Start it

```bash
docker compose up -d --build
```

- `--build` compiles TypeScript inside the image.
- On start the container runs `prisma migrate deploy` (creates/updates the DB) then launches the bot.
- `-d` = detached (keeps running after you log out).

Check it's alive:

```bash
docker compose logs -f          # follow logs; look for "Bot ready"
docker compose ps               # STATUS should be "running"
```

## 7. First-time server setup (once)

Register slash commands + build the Discord structure. Run these inside the container:

```bash
docker compose exec bot npx tsx scripts/register-commands.ts
docker compose exec bot npx tsx scripts/build-server.ts
```

> If `tsx` isn't in the production image, run them from a dev copy, or
> temporarily `docker compose exec bot sh` and use `node dist/...`.
> Alternatively run `npm run register` / `npm run build:server` once from your
> local machine (they only talk to Discord's API, not the server's DB) —
> simplest. In Discord you can also just run `/setup` as the owner.

## 8. It now runs 24/7

- Survives reboots: `restart: unless-stopped` is set in `docker-compose.yml`.
- **Update later:**
  ```bash
  cd /root/bot && git pull        # (or re-scp)
  docker compose up -d --build
  ```
- **Stop:** `docker compose down`  · **Logs:** `docker compose logs -f`

## 9. Back up the database

The whole DB is one file. Copy it off the server on a schedule:

```bash
# from your local machine
scp root@YOUR_SERVER_IP:/root/bot/data/app.db ./backup-$(date +%F).db
```

Or a cron on the VPS that copies `data/app.db` to a dated file / cloud storage.

## 10. (Optional) Web dashboard

The dashboard is a separate process. To expose it, add a service to
`docker-compose.yml` running `npm run web`, publish port `8090`, and put it
behind the firewall or a reverse proxy. Only enable if you set a strong
`WEB_TOKEN`. For most users the Discord `/attendance` commands are enough — skip this.

---

### If you only have shared hosting (no VPS)

You cannot run this bot there. Cheapest fixes:
1. Add a Hostinger **KVM VPS** (~$5/mo) and follow the steps above.
2. Or use a free always-on VM (Oracle Cloud Free Tier) — same Docker flow.
