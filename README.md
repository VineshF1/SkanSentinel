# 1. Project title

**SkanSentinel** — a heartbeat monitor that detects when scheduled background jobs crash, never start, or freeze, and sends an alert. Silence is the alarm: if an expected ping does not arrive, SkanSentinel notices on its own, on the server, even with no dashboard open.

# 2. Problem

Scheduled jobs (database backups, payment renewals, hourly rollups) fail silently. A backup that never starts looks identical to a backup that is not needed yet, because in both cases nothing happens. Teams discover the gap days later, from a customer complaint or an empty report, because nothing was watching for absence. Normal monitoring watches things that happen (errors, CPU spikes). Nobody watches the things that should have happened but did not.

# 3. Solution

Give every job a monitor with two things: a secret ping token and a known schedule. The job calls SkanSentinel when it starts and when it finishes. SkanSentinel always knows when the next ping is due. If the due time plus a grace period passes with no ping, the job is marked missed. If a run takes longer than its maximum runtime, it is marked runaway. If it finishes with a non-zero exit code, it is marked failed. Each incident sends exactly one alert, and the next healthy run sends one recovery notice. Detection runs on the server on a timer, so it works with every browser tab closed.

# 4. Features

- **Monitors.** One watched job each: name, slug, cron schedule, timezone (defaults to IST, Asia/Kolkata), grace minutes, max runtime minutes, and an alert channel. The server generates a 64-character secret ping token per monitor.
- **Ping API.** `POST .../start` when a run begins, `POST .../finish` or `/fail` when it ends, plus a one-hit heartbeat on the bare token URL. Public endpoints (the token is the credential), limited to 60 requests per minute per token, bodies capped at 256 KB, unknown tokens get a bare 404.
- **Server-side detection.** A checker runs every 5 seconds and an alert sender every 3 seconds, inside the same server process. `MISSED` and `RUNAWAY` are sticky until the job itself reports back. The same repeating failure never re-alerts while its incident is open.
- **Alert channels.** None (dashboard only), Slack, Discord, generic webhook, and a demo sink. Slack receives `{"text": ...}`, Discord receives `{"content": ...}`, webhooks receive structured JSON with monitor name, alert type, exit code, the last 20 log lines, and a timestamp. Failed deliveries retry with growing delays, then are marked failed. Every alert and its delivery state stays visible in the Recent Alerts panel.
- **Secret redaction.** Before any log or message is stored or sent, passwords, API keys, tokens, private keys, JWTs, and credentials inside URLs are replaced with `[REDACTED_...]` markers. Logs are capped at 64 KB and the redactor cannot throw.
- **Dashboard.** Summary cards (total, healthy, running, missed, failed, runaway), a monitor table with status, last seen, next expected, and pause/resume/delete actions, live data refresh every 3 seconds, and a red banner if the background worker itself stops reporting.
- **Monitor detail page.** Average, median (P50), and P95 run durations; copy-paste integration snippets for curl, Bash, Python, and Node.js; a duration bar chart; execution history with drift (how late each run started versus its slot); and a log viewer that turns every `[REDACTED_...]` marker into a badge.
- **`skansentinel-exec` helper.** Wraps any shell command: sends start, runs the command, prints its output unchanged, sends finish or fail with the last 32 KB of output and the real exit code, and exits with the command's own code. If SkanSentinel is unreachable, the command still runs normally.
- **Demo mode.** Four pre-seeded monitors (healthy, missed, failed, runaway) with realistic history, plus one-click simulations (crash, missed run, hang, secret leak) that travel the same real code paths as genuine pings.

# 5. Tech stack

- **Next.js 16** (App Router, TypeScript) running as one long-lived Node.js server. Not serverless, not the Edge runtime.
- **SQLite** through `better-sqlite3`, listed in `serverExternalPackages` so the native binary is never bundled. One file, write-ahead logging, foreign keys, busy timeout.
- **`cron-parser`** (v5 API) for schedule math and **`cronstrue`** for plain-English schedule text ("At 02:00 AM").
- **Tailwind CSS v4**, system font stack (no webfont downloads), **`lucide-react`** icons on action buttons only.
- **Vitest**: 54 unit tests covering the sanitizer, scheduler, checker, alerts, pings, and auth.

# 6. Architecture

One Node.js process does three jobs. It serves the dashboard pages, it serves the API routes, and it runs a background worker started once from `src/instrumentation.ts` (Node.js runtime only, guarded against duplicate timers on hot reload). The worker has two loops: the **checker** (every 5 seconds: LATE/MISSED/RUNAWAY transitions, worker heartbeat write) and the **alert sender** (every 3 seconds: delivery, retries, final failure marking). Keeping everything in one process guarantees alerts can never double-fire from two instances; the price is that monitoring stops if the process dies, so an outside uptime checker should watch `/healthz`.

The database has four tables. `monitors` stores one row per watched job: schedule, tolerances, token, current status, the currently open incident, and timing fields. `executions` stores one row per run and keeps the newest 200 per monitor. `alerts` stores every incident and recovery notice with delivery state and retry counters. `meta` is a small key-value shelf holding the worker heartbeat. Every timestamp is epoch seconds, produced by one shared helper, because mixing milliseconds and seconds would make every job look decades overdue. Each state change and its alert row are written in the same database transaction, so a crash can never lose an alert.

Only three things are public: the ping routes, `/healthz`, and the `skansentinel-exec` download. Everything else requires the admin password over HTTP Basic login, checked in constant time with a delay on failures. Webhook URLs are never returned by any API and never shown in the UI.

# 7. Setup

Prerequisites: Node.js 22 or newer, npm, and Git.

```powershell
git clone <your-repo-url>
cd SkanSentinel
npm install
Copy-Item .env.example .env
```

Open `.env` and set `ADMIN_PASSWORD` to a long random secret. The server refuses to start while it is empty or still the placeholder. On Windows, generate one with:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

Leave `DEMO_MODE=0` for real use. `DATABASE_PATH` already points at `./data/production.db`; the folder is created automatically on boot. `ALLOW_PRIVATE_WEBHOOKS` stays `0` unless you are testing webhooks against localhost.

# 8. Environment variables

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_PASSWORD` | Yes | Password for the dashboard login and every admin API. Compared in constant time; failed attempts are slowed down. |
| `DEMO_MODE` | No | `1` seeds 4 fake monitors on first boot, shows the demo control bar, and enables the demo alert sink (alerts are marked delivered without network calls). `0` or unset is production mode. |
| `DATABASE_PATH` | No | Filesystem path of the SQLite database. Default `./data/skansentinel.db`. Use `./data/production.db` locally and a mounted volume path (e.g. `/app/data/skansentinel.db`) in Docker. The old demo database is simply a different file; switching paths switches datasets. |
| `ALLOW_PRIVATE_WEBHOOKS` | No | `1` permits `http://` and localhost webhook URLs for local testing. Production must stay `0`, which enforces `https` URLs resolving to public addresses only, checked both when the URL is saved and again at send time. |

Next.js reads these from the `.env` file automatically at boot. Command-line variables with the same names override the file.

# 9. Run instructions

## Key concepts, in detail

**Cron expression.** Five fields separated by spaces: `minute hour day-of-month month day-of-week`. Each field is a number, a list (`1,15`), a range (`1-5`), a step (`*/15`), or `*` for every value. Examples: `0 2 * * *` means 02:00 every day; `*/30 * * * *` means every 30 minutes; `0 9 * * 1` means 09:00 every Monday. The New monitor form shows a live preview of the next 3 run times plus the plain-English text, or a red error if the expression is invalid. Exactly 5 fields are required.

**Timezone.** An IANA name such as `Asia/Kolkata`, `UTC`, or `America/New_York`. The schedule is interpreted in this zone, so `0 9 * * *` with `Asia/Kolkata` fires at 9 AM IST. The app default is IST; change it per monitor if the job runs in another region.

**Grace minutes.** How late a ping may be before it counts as missed. A daily backup over a slow network might allow 15; a job every 5 minutes might allow 1 or 2. While a monitor is past its expected time but inside grace, it shows `LATE` and stays silent.

**Max runtime minutes.** How long a single run may stay in `RUNNING` before it is declared `RUNAWAY`. Set it above the job's worst normal duration with headroom.

**Ping token.** A 64-character secret that identifies the monitor. It is shown once on the Details page as part of the Ping URL. Anyone holding it can report runs, so treat it like a password and never log it.

**Statuses.** `PENDING` (created, nothing seen yet) · `HEALTHY` (last run succeeded, next not due) · `RUNNING` (started, unfinished) · `LATE` (overdue but inside grace, no alert) · `MISSED` (overdue past grace, alert sent) · `FAILED` (non-zero exit, alert sent) · `RUNAWAY` (over max runtime, alert sent) · `PAUSED` (switched off by you; never changes, never alerts; resuming returns to `PENDING` with a fresh expectation).

**Alert channels.** None means dashboard-only (alerts still recorded as `SKIPPED`). Slack needs an incoming-webhook URL, Discord a channel webhook URL, generic webhook any `https` endpoint that accepts JSON. In demo mode an extra Demo sink marks alerts delivered without network calls.

## Running the server

Development (compiles on demand, slower first load):

```powershell
npm run dev
```

Production (prebuilt, fast; rebuild after every code change):

```powershell
npm run build
npm run start -- -p 3000
```

Open http://localhost:3000 and log in with the `ADMIN_PASSWORD` (any username works).

## Running with Docker

```powershell
docker build -t skansentinel .
docker run -p 3000:3000 `
  -e ADMIN_PASSWORD='pick-a-strong-password' `
  -v skansentinel-data:/app/data `
  skansentinel
```

The `-v` flag mounts a named volume at `/app/data` so the SQLite file survives container restarts and redeploys. Without it, every container replacement wipes all monitors and history.

## Adding a job, end to end

1. Dashboard → **New monitor**. Fill name, slug, cron (watch the live preview), timezone, grace, max runtime, and channel. Create.
2. Open its **Details** page and copy the **Ping URL**.
3. Wrap the job. With the helper:

```bash
./skansentinel-exec http://your-server:3000 <PING_TOKEN> -- ./your-job.sh
```

Manually with curl:

```bash
curl -X POST <PING_URL>/start
# ... do the work ...
curl -X POST <PING_URL>/finish
```

On failure send the exit code: `curl -X POST "<PING_URL>/finish?exit_code=3"` or `POST <PING_URL>/fail`. The Details page also gives Python and Node.js snippets that ping start before the work, finish on success, and fail with the error text on exception, all with short timeouts so pinging can never break the job.

4. Watch the dashboard row move `PENDING` → `RUNNING` → `HEALTHY`. Then test the alarms: stop the job and wait past grace to see `MISSED`, or let one run overrun to see `RUNAWAY`. The next good run sends `RECOVERED`.

## Running the tests

```bash
npm test
```

54 tests covering redaction rules, schedule math, checker transitions, alert-once/recovery/retry behavior, webhook body shapes and safety rejections, ping lifecycles, rate limits, and auth helpers.

# 10. Demo link

No public demo URL is deployed. To run the demo locally:

```powershell
$env:DEMO_MODE='1'
npm run dev
```

Open http://localhost:3000: four pre-seeded monitors (healthy, missed, failed, runaway) with realistic history, plus a demo control bar with one-click crash, missed-run, hang, and secret-leak simulations. Every simulation travels the same real code paths as genuine pings; only timestamps are moved. Reset demo data wipes everything and re-seeds. Do not enable demo mode on a production database.

# 11. Team members

Solo project. (Replace this line with the team list before submitting.)

# 12. Known limitations

- Run **one** server process with persistent disk (VPS, Render, Railway, Fly.io). It will **not** work on serverless hosts like Vercel.
- Login is basic HTTP auth; put it behind HTTPS in production and choose a strong `ADMIN_PASSWORD`.
- Webhook host checks happen at save and send time; DNS changes between the two checks are not covered.
- If the server dies, monitoring stops; point an outside uptime checker at `/healthz`.
- `docker build` was not exercised here (the Docker daemon is offline on the build host); verify it before shipping the image.
- Native execution of `skansentinel-exec` was verified at the HTTP layer only (no POSIX shell on the build host); run it on Linux or macOS to confirm end to end.
- The default timezone is IST (`Asia/Kolkata`), which differs from the original spec's UTC default; per-monitor timezones still accept any valid IANA name.

# 13. AI/tool disclosure

Built with AI-assisted coding (OpenCode agent harness, Muse Spark model) under the author's direction: the author supplied the full product spec, the UI design briefs, the timezone and database decisions, and every verification call. All tests and live checks reported here were actually executed and their real output reviewed; items that could not be verified are listed under Known limitations instead of claimed.
