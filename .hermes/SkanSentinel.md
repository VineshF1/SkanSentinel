# AGENT BUILD PROMPT: SkanSentinel (Dead-Man's Switch Monitor)

Build a full-stack web application called **SkanSentinel**. It is a heartbeat monitor that detects when scheduled background jobs (database backups, payment renewals, hourly rollups) **crash, never start, or freeze**, and then sends an alert.

**Core principle: silence is the alarm.** If an expected ping does not arrive, SkanSentinel must notice on its own, on the server, even if nobody has the dashboard open.

---

## 0. Working Rules for the Agent

1. Build exactly what is listed here. Do not add features from Section 13 (Out of Scope).
2. All detection logic (missed, runaway, alerting) runs **on the server**, never in the browser.
3. Demo buttons must call the **same real code paths** that real pings use. They may move timestamps, but they must never write a fake status directly.
4. Do not claim anything you did not run. In your final message, paste the real results of the checks in Section 12.
5. If anything in this spec is contradictory or impossible, stop and report it. Do not silently change behavior.

---

## 1. How It Works

1. Each job has a monitor with a unique, secret **ping token** (long, random, unguessable).
2. When the job runs, it calls SkanSentinel: **start** when it begins, **finish** or **fail** when it ends.
3. SkanSentinel knows the job's cron schedule and timezone.
4. If the expected ping does not arrive within the grace period, or a job runs longer than its allowed time, or it exits with an error, SkanSentinel changes the status and sends **one** alert.
5. When the job recovers, SkanSentinel sends one **recovery** message.

---

## 2. Tech Stack

- **Framework:** Next.js (App Router, TypeScript, Tailwind CSS), running as a single long-lived Node.js server (not the Edge runtime, not serverless).
- **Database:** SQLite through `better-sqlite3`, stored at `./data/skansentinel.db`. The `data/` folder is git-ignored.
- **Schedule parsing:** `cron-parser` (with timezone support) and `cronstrue` (turns `0 2 * * *` into "At 02:00 AM"). Check the installed version's documentation before using its API, because the API differs between major versions.
- **UI:** Lucide React icons. Dark, modern developer look: near-black background, charcoal cards, emerald green for healthy, crimson red for failure.
- **Build note:** `better-sqlite3` is a native module. Use **Next.js 15 or newer** and list `better-sqlite3` in the `serverExternalPackages` option of the Next.js config file, so the bundler never tries to bundle the native binary. (On Next.js 14 the equivalent is the experimental `serverComponentsExternalPackages` option; prefer 15+.) All database code must run only in server code (route handlers, server components, the background worker), never in client components.

---

## 3. Status Definitions

Every monitor is always in exactly one of these states:

| Status | Meaning |
|---|---|
| `PENDING` | Created, no ping received yet, not yet overdue |
| `HEALTHY` | Last run finished with exit code 0 and the next run is not yet due |
| `RUNNING` | A start ping arrived and the job has not finished yet |
| `LATE` | The expected time has passed but the grace period is still open (no alert yet) |
| `MISSED` | The expected time plus grace period passed with no ping. Alert sent once |
| `FAILED` | The job finished with a non-zero exit code. Alert sent once |
| `RUNAWAY` | The job has been `RUNNING` longer than its maximum runtime. Alert sent once |
| `PAUSED` | Monitoring switched off by the user. Never changes, never alerts |

`MISSED` and `RUNAWAY` are **sticky**: they stay until a finish or fail ping arrives.

---

## 4. Data Model (SQLite)

Enable WAL mode, foreign keys, and a busy timeout. Wrap every multi-step write in a transaction. **All timestamps are stored as epoch seconds, never milliseconds.** JavaScript's `Date.now()` returns milliseconds, so always convert (divide by 1000 and round down) before reading, writing or comparing against stored values. Create one shared "now in seconds" helper and use it everywhere; mixing units would make every job look overdue by decades. Convert back to milliseconds only when displaying in the UI.

**monitors**
`id`, `name`, `slug` (unique), `ping_token` (unique), `cron_expression`, `timezone` (default `UTC`), `grace_minutes` (default 5), `max_runtime_minutes` (default 30), `status`, `paused`, `alert_channel_type` (nullable), `alert_channel_url` (nullable), `open_incident` (nullable, the kind of alert currently open), `last_ping_at`, `last_start_at`, `next_expected_at`, `created_at`

**executions**
`id`, `monitor_id` (cascade delete), `status` (`RUNNING`, `SUCCESS`, `FAILED`, `ABANDONED`), `scheduled_for`, `started_at`, `finished_at`, `duration_seconds`, `exit_code`, `sanitized_output`

Keep only the newest 200 executions per monitor.

**alerts**
`id`, `monitor_id` (cascade delete), `alert_type` (`FAILED`, `MISSED`, `RUNAWAY`, `RECOVERED`), `message` (already sanitized), `delivery_status` (`PENDING`, `DELIVERED`, `FAILED`, `SKIPPED`), `attempts`, `next_try_at`, `created_at`, `sent_at`

**meta**
`key`, `value`. Used to store the background worker's last heartbeat time.

---

## 5. Core Features

### 5.1 Dashboard (`/`)

- **Summary cards:** Total Monitors, Healthy, Running, Missed, Failed, Runaway. A missing count shows 0.
- **Judge Demo Bar** (visible only in demo mode): a dropdown to pick a monitor, and 4 one-click buttons plus a reset button:
  - *Simulate Crash*: a start ping followed by a finish ping with exit code 137 and an out-of-memory log.
  - *Simulate Missed Run*: makes a healthy job appear overdue past its grace period.
  - *Simulate Hang / Runaway*: makes a job appear to have been running past its maximum runtime.
  - *Simulate Secret Leak*: sends a successful run whose log contains fake secrets, to show automatic redaction. The status does not change; the log shows redaction badges.
  - *Reset demo data*: deletes everything and re-seeds.
- **Monitor table:** Name, Human-readable schedule (cronstrue text plus timezone), Status badge, Last Seen ("3m ago"), Next Expected ("in 12m" or "25m overdue"), and actions: Details, Pause/Resume, Delete (with a confirmation). `RUNNING`, `FAILED`, `MISSED` and `RUNAWAY` badges show a small pulsing dot.
- **"+ New monitor" button** opening a form (see 5.2).
- **Recent Alerts panel:** time, monitor, type, delivery status.
- **Worker offline banner:** shown in red if the background worker heartbeat is older than 30 seconds.
- The page refreshes its data automatically every 3 seconds without losing open dialogs or scroll position.

### 5.2 Creating and managing monitors

Users must be able to add, pause, resume and delete monitors from the UI.

**New monitor form fields:** name; slug (auto-filled from the name, editable); cron expression with a **live preview** of the next 3 run times and the plain-English text (or a red error if invalid); timezone (default `UTC`); grace minutes (default 5); max runtime minutes (default 30); alert channel (None, Slack, Discord, Generic webhook, plus Demo sink in demo mode only) and a webhook URL field when a real channel is chosen.

**Validation:**
- Name required, at most 100 characters.
- Slug: lowercase letters, digits and dashes only; must be unique.
- Cron: exactly 5 fields and valid. Timezone must be a valid IANA name.
- Grace 0 to 1440 minutes; max runtime 1 to 10080 minutes.
- Show clear error messages inside the form.

**Pause/Resume:** a paused monitor is skipped by the checker. **Resuming** must reset it to `PENDING`, clear any open incident, and recalculate the next expected time from now, so it does not instantly become `MISSED`.

### 5.3 Monitor Detail Page (`/monitors/[id]`)

- Header: name, status badge, human schedule.
- **Statistics:** average duration, plus median (P50) and P95 if there are enough successful runs. Show "n/a" when there is no data. Never show made-up numbers.
- **Connect your job** tabs with copy buttons:
  - `curl`: start, run the job, finish.
  - `Bash wrapper`: a one-line usage example of a small helper script (see 5.4).
  - `Python` and `Node.js` short examples that send start before the work, finish on success, and fail with the error text on exception. Pinging must never break the user's job (short timeout, errors ignored).
- **Ping URL** displayed with a Copy button ("Copied!" for 1.5 seconds).
- **Duration bar chart** for the last 30 runs (plain SVG, no chart library; failed runs red, successful green).
- **Execution history table:** start time, duration, exit code, status, and **drift** (how many seconds late the run started compared with its scheduled time; "n/a" if unknown).
- **Log viewer:** monospace box for the newest run's output. Highlight every `[REDACTED_...]` token as a small purple badge.

### 5.4 Ping API (public, no login)

All routes live under `/api/ping/[token]` and identify the monitor by its secret token only.

| Route | Behavior |
|---|---|
| `POST .../start` | Marks the job `RUNNING` and records the start time |
| `POST .../finish` | Ends the run. Exit code 0 means success (`HEALTHY`), anything else means `FAILED` |
| `POST .../fail` | Same as finish, but an exit code of 0 is forced to 1 (fail never means success) |
| `GET` or `POST /api/ping/[token]` | Simple one-hit success heartbeat |

**Input rules:**
- Exit code comes from the JSON field `exitCode`, or the query parameter `exit_code`. If missing: 0 for finish and heartbeat, 1 for fail. A value that is not a number counts as 1.
- Log output comes from the JSON field `output`, or from a plain-text request body. Optional JSON fields: `errorMessage`, `duration`.
- Maximum body size 256 KB (larger returns 413). Unknown token returns **404** with no other detail.
- Rate limit: at most 60 requests per minute per token (returns 429 beyond that).
- Response: a small JSON acknowledgement with the job name and new state.

**Behavior rules:**
- A new start ping while an older run is still `RUNNING` marks the older run `ABANDONED`.
- A finish/fail with no earlier start still records a run (duration from the supplied value, else zero).
- After every finish/fail, calculate the next expected time from the **slot that was just satisfied**, not from "now" alone, and skip any slots that are already past their grace window. This prevents both instant false `MISSED` alerts after a long outage and double-counting.
- Success resolves any open incident and sends a `RECOVERED` alert. Failure opens a `FAILED` incident.

**Helper script `skansentinel-exec`** (served publicly from the app and also stored in the repo): runs any command, sends start, captures combined output, prints it unchanged, sends finish or fail with the **last 32 KB** of output and the exit code, and exits with the command's **original exit code**. If SkanSentinel is unreachable, the command still runs normally.

### 5.5 Automatic Secret Redaction

Before saving **any** log, error message, or alert text, remove secrets. Never store or send raw credentials. Redact, in this order:

1. Private key blocks (BEGIN/END PRIVATE KEY) → `[REDACTED_PRIVATE_KEY]`
2. Credentials inside URLs (`scheme://user:password@host`) → `[REDACTED_CREDENTIALS]`
3. JSON Web Tokens → `[REDACTED_JWT]`
4. `Bearer <token>` → `Bearer [REDACTED_TOKEN]`
5. AWS access key IDs (starting `AKIA` or `ASIA`) → `[REDACTED_AWS_KEY]`
6. Common API key prefixes (Stripe `sk_live_`/`sk_test_`/`rk_live_`, GitHub `ghp_`/`gho_`/`github_pat_`, Slack `xox...-`, Google `AIza...`) → `[REDACTED_API_KEY]`
7. Any `name=value` or `name: value` pair where the name contains `password`, `passwd`, `pwd`, `secret`, `token`, `auth` or `api key` (any case, quoted or unquoted values) → `name=[REDACTED_SECRET]`

Also: keep only the last 64 KB of any log; the sanitizer must **never throw** (on any internal error, store a "output withheld" notice instead); normal text must pass through unchanged.

### 5.6 Background Detection Loop

A single worker runs inside the same server process, started once when the server boots (implement it in Next.js's `instrumentation` file using its `register` function; start the timers only when the runtime is Node.js, importing the worker module dynamically inside that check so database code never reaches the Edge bundle; and guard with a flag stored on the global object so development hot reloads cannot start duplicate timer loops. Do not start it from a client component, layout, or middleware). It must not run in a separate process that could duplicate alerts.

**Checker (every 5 seconds)**, for every monitor that is not paused:
- `RUNNING` and the run time exceeds `max_runtime_minutes` → `RUNAWAY`.
- `PENDING`, `HEALTHY`, `LATE` or `FAILED`, and now is past the next expected time plus that monitor's **own** `grace_minutes` → `MISSED`.
- Past the expected time but still inside grace → `LATE` (no alert).
- After each pass, save a worker heartbeat timestamp.

**Alerting rules:**
- **Alert once per incident:** if the same kind of incident is already open, do not alert again.
- Write the state change and the alert row in the **same transaction** (so a crash cannot lose an alert).
- Recovery closes the incident and queues one `RECOVERED` alert.
- Monitors with no channel record the alert as `SKIPPED` (it still appears in the dashboard panel).

**Alert sender (every 3 seconds):** sends `PENDING` alerts, retries up to 3 times with growing delay, then marks `FAILED`.
- Slack gets `{"text": ...}`, Discord gets `{"content": ...}` (not `text`), generic webhook gets structured JSON with monitor name, slug, alert type, exit code, last 20 log lines, and timestamp.
- Message format: a warning icon for problems, a check icon for recovery, monitor name, plain-English label, and the exit code when non-zero.
- Timeout 5 seconds, **never follow redirects**.
- **Webhook safety (SSRF):** only `https` URLs; the host must resolve to public addresses only (reject private, loopback, link-local, reserved and multicast addresses). Check when saving **and again when sending**. A local-testing environment flag may relax this, and must be documented as never for production.
- Webhook URLs are **never** returned by any API and never shown in the UI.

---

## 6. Security Requirements

- **Dashboard and all admin APIs require a login.** Use a single admin password from the `ADMIN_PASSWORD` environment variable (HTTP Basic auth or a simple login page). The server refuses to start if it is not set. Compare passwords in constant time and slow down failed attempts.
- Only the ping routes and a health endpoint (`/healthz`) are public.
- Ping tokens are generated with a cryptographically secure random source and are never logged.
- All demo routes return **404** unless `DEMO_MODE=1`.
- Job output and names come from outside: render them as plain text (never as raw HTML) everywhere.
- Set safe response headers (no framing, no content sniffing, restrictive content security policy).

---

## 7. Pre-Seeded Demo Data

When `DEMO_MODE=1` and the database is empty, create these 4 monitors using the **real engine** (real pings and a real checker pass, not hand-written statuses). Give each 15 to 25 past runs with slightly varied durations so charts and averages look real. Use the demo alert sink so no real network calls happen, and mark seeded alerts as delivered.

| Monitor | Schedule | Final status |
|---|---|---|
| **Nightly Database Backup** | daily at 02:00, grace 15 | `HEALTHY` (last run about 4 hours ago, about 3.5 minutes long) |
| **Stripe Billing Renewal** | every 30 minutes | `MISSED` (expected time 25 minutes past, grace 5) |
| **Invoice PDF Generator** | daily at 08:00, grace 10 | `FAILED` (exit code 137, out-of-memory log containing fake secrets that appear redacted) |
| **Hourly Metric Rollup** | hourly, max runtime 20 minutes | `RUNAWAY` (started about 68 minutes ago, never finished) |

All demo secrets must be obviously fake.

---

## 8. Configuration

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Required. Dashboard and admin API password |
| `DEMO_MODE` | `1` enables demo data, demo bar and demo alert sink |
| `DATABASE_PATH` | SQLite file path. Default `./data/skansentinel.db` |
| `ALLOW_PRIVATE_WEBHOOKS` | `1` allows http and localhost webhooks. Local testing only |

Provide a `.env.example` with these variables.

---

## 9. Build Order

1. Project setup, database connection, schema, and demo-mode config.
2. Secret sanitizer (`lib/sanitizer`) with its tests.
3. Schedule helpers: validate cron and timezone, next slot, next 3 slots, advance-expected rule.
4. Monitor create, update, pause/resume, delete logic.
5. Ping handlers (start, finish, fail, heartbeat) with body limits and rate limit.
6. Incident and alert queue (alert once, recovery).
7. Background checker and alert sender started from the server boot hook.
8. Admin API routes and login protection.
9. Demo simulator and seed logic.
10. Dashboard, New monitor form, and monitor detail page.
11. `skansentinel-exec` helper, README, Dockerfile, `.env.example`.
12. Run all checks in Section 12.

---

## 10. Deliverables

Working source code, `README.md`, `.env.example`, `.gitignore` (`data/`, `.env`, `node_modules/`, `.next/`), `Dockerfile`, the `skansentinel-exec` script, and an automated test file.

**README must include:** what it is (3 lines); run locally; run with Docker using a mounted volume for the database; the environment table; how to add a job and use `skansentinel-exec`; how to run tests; and these honest limits:
- Run **one** server process. It needs persistent disk (VPS, Render, Railway, Fly.io). It will **not** work on serverless hosts like Vercel.
- Login is basic; put it behind HTTPS in production.
- Webhook host checks happen at save and send time; DNS tricks between the two are not covered.
- If the server dies, monitoring stops; point an outside uptime checker at `/healthz`.

---

## 11. UI Quality Bar

Dark theme; consistent status colors (`HEALTHY` emerald, `RUNNING` cyan, `LATE` amber, `MISSED` and `FAILED` crimson, `RUNAWAY` purple, `PENDING` and `PAUSED` grey). Tables scroll sideways inside their own container on small screens; the page itself never scrolls horizontally at 400 px width. Loading, empty and error states are handled everywhere. No unexplained numbers: every metric shows "n/a" or "no data yet" when empty.

---

## 12. Automated Tests and Checks (paste real output)

**Unit tests (at least 40) covering:**
- Sanitizer: every redaction rule, normal text unchanged, size cap, never throws.
- Schedule: invalid cron/timezone, strictly-after semantics, timezone handling, advance-expected after on-time, late and long-outage pings.
- Checker: `LATE` in grace, `MISSED` after grace, `RUNAWAY` after max runtime, sticky states, paused monitors ignored, each monitor uses its own grace.
- Alerts: alert once per incident, `RECOVERED` alert, `SKIPPED` without channel, retry and final failure, Slack vs Discord body shape, webhook safety rejections.
- Pings: start then finish, failure with exit code, heartbeat without start, abandoned runs, unknown token, body size limit, output sanitized before storage.

**Manual / scripted checks:**
1. Unauthenticated request to the dashboard or admin API is rejected; ping routes work without login.
2. Unknown ping token returns 404.
3. Four demo monitors appear with statuses `HEALTHY`, `MISSED`, `FAILED`, `RUNAWAY`.
4. Run `skansentinel-exec` on a command that prints `boom password=hunter2` and exits 3: it prints the original text, exits 3, and the stored log contains `[REDACTED_SECRET]` but **not** `hunter2`.
5. Click the four demo buttons: each changes status (Secret Leak shows purple badges instead) and adds an alert row within about 10 seconds.
6. Close all browser tabs, trigger "Simulate Missed Run" through a direct API call, and confirm the monitor still becomes `MISSED`. This proves detection runs on the server.
7. Pause then resume a monitor: it returns to `PENDING`, not `MISSED`.
8. Trigger the same failure twice: only **one** alert is created; then a successful ping creates one `RECOVERED` alert.
9. Open the dashboard at 400 px width: no page-level horizontal scroll.

---

## 13. Out of Scope (do NOT build)

PagerDuty, email alerts, multiple users or roles, OAuth, token rotation, API keys, teams, billing, i18n, dark/light toggle, Gantt charts, chart libraries, import/export, any ORM, and anything not listed above.

---

## 14. Definition of Done

All sections above are implemented and every check passes. Finish with: (1) a short list of files created, (2) the real pasted output of the tests and checks, (3) anything you could not verify or any spec problem you noticed.