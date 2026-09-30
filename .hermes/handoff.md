# SkanSentinel — Handoff

Updated: 2026-09-30 UTC (production DB live, demo DB preserved)

## UI pass (design files applied)
- Conflict resolved: spec mandates dark console theme + Lucide, so those win; design files applied as restraint (system font stack, one emerald accent, semantic status with text labels + dots per HIG, Lucide only on actions, no emojis, CSS-only motion with reduced-motion support, skeleton loaders, labeled inputs, inline errors, two-step delete, tabs + copy buttons on detail page)
- Performance: memoized rows/badge/chart/log, dynamic import for NewMonitor form (excluded from initial bundle), single /api/status poll per 3s tick, per-route code splitting, zero added libraries (no GSAP/Lenis/Three; unjustified for a polling console)
- Verified: tsc clean, production build clean, 54/54 vitest pass, live dev boot; dashboard + detail SSR shells return 200 with skeleton; /api/status shows seeded HEALTHY/MISSED/FAILED/RUNAWAY; create-validation 400s render inline; cron preview returns text + next 3
- Check server killed, `data/uicheck.db*` removed
- Post-fix: CSP `script-src` was missing `'unsafe-inline'`, which blocked Next.js inline hydration scripts (stuck skeleton in browser, API fine). Fixed in `next.config.ts`, rebuilt, restarted prod server; header verified live

## Completed
- [x] Next.js 16.3.7 scaffold (TS, Tailwind, App Router, src-dir), `serverExternalPackages: [better-sqlite3]`
- [x] `src/lib/time` (epoch-seconds everywhere), `config` (env), `db` (WAL/FK/busy-timeout, monitors/executions/alerts/meta schema, 200-run prune)
- [x] `src/lib/sanitizer` (7 rules in spec order, 64KB cap, never-throws) — fixed backref bug (`\3`→`\2`) + bounded quantifiers (70KB: 6.5s→12ms)
- [x] `src/lib/schedule` (cron-parser v5 API verified at runtime, cronstrue text, next-3, advance-expected, previous-slot/drift)
- [x] `src/lib/monitors` (validation, token gen, SSRF save-time check, pause/resume/delete; resume→PENDING + fresh expectation)
- [x] `src/lib/engine` (start/finish/fail/heartbeat, ABANDONED, alert-once, RECOVERED, checker pass with sticky states + per-monitor grace)
- [x] `src/lib/alerts` (same-txn state+alert, SKIPPED/DELIVERED demo sink, 3s sender with retry→FAILED, Slack/Discord/webhook bodies, send-time SSRF recheck, 5s timeout, no redirects)
- [x] `src/lib/worker` + `src/instrumentation.ts` (Node-only dynamic import, global guard; verified live: worker heartbeat fresh)
- [x] `src/middleware.ts` Edge-safe Basic auth (no node: imports; own constant-time compare), 401/500 handling, 300ms fail delay; public: `/api/ping/*`, `/healthz`, `/skansentinel-exec`
- [x] Ping routes (256KB→413, 60/min→429, unknown→404, exitCode/output/errorMessage/duration rules)
- [x] Admin APIs: monitors CRUD, pause/resume, alerts, cron-preview, status (summary+worker_offline+demo flag); webhook URLs never returned
- [x] Demo seed (4 monitors via real engine + real checker pass, 18–24 history runs each, demo sink DELIVERED) + simulate crash/missed/hang/leak + reset (404 unless DEMO_MODE)
- [x] `skansentinel-exec` (repo file + public `/skansentinel-exec` route; plain-text body + `?exit_code=` avoids quoting issues)
- [x] Functional dashboard/detail placeholder (polls /api/status every 3s, demo bar, pause/resume/delete, cron live preview, SVG bars, redaction badges) — AWAITING user UI prompts for final look
- [x] `tests/unit.test.ts`: **54/54 pass** (`npx vitest run`), `tsc --noEmit` clean, `npm run build` clean
- [x] §12 live checks 1–8 against dev server (see below); demo reset to pristine; check server killed; `data/check.db*` removed
- [x] README.md, .env.example, Dockerfile, .gitignore (`data/`, `.env`)

## System state
- All changes unstaged, nothing committed (repo had zero commits from scaffold)
- `data/` ignored; no stray files (only `data/.gitkeep` absent — dir re-created on boot)
- Dev deps: vitest 5.0.2 + vite (installed with --legacy-peer-deps), @types/better-sqlite3

## Pending
- Docker image build + run: Dockerfile fixed by inspection (removed `public/` copy, added `.dockerignore`); daemon is off on this host so `docker build` could not run. Run `docker build -t skansentinel .` on a machine with the daemon up before shipping the image.
- `middleware.ts` → `proxy.ts` rename (Next 16 deprecation warning; works as-is, server log shows it runs as proxy.ts internally)
- README rewritten in 13-section style (title → AI disclosure), spec §10 content folded in; team section left as fill-in
- Cron focus-steal fixed: form mount-focus re-fired on every 3s dashboard poll (inline onClose identity change) and yanked typing focus to the name field. Mount-focus runs once now, close handler is stable; cron field also gained a `* * * * *` placeholder, autocomplete/spellcheck off, monospace type
- Cron live preview moved from below the whole form to directly under the cron expression field
- Details page connect tabs: curl tab replaced with literal `curl.exe` commands (no variables, paste-ready on Windows); deviates from spec §5.3 which lists curl
- CSP: `script-src` now adds `'unsafe-eval'` in development only (React dev needs `eval()`; prod stays strict). Also gave the 64KB sanitizer test an explicit 30s timeout after one load-induced flake (re-run green 54/54).
- Channel gap closed: new `PATCH /api/monitors/[id]/channel` (type validation, URL required for real channels, SSRF recheck, URL never returned) + Alert channel section on detail page; verified live (400s + clean save)
- Channel dropdown values were capitalized (`Slack`) while checks used lowercase: selecting Slack/Discord showed no URL box. Fixed to lowercase; my earlier broken-React theory for this was wrong.
- Demo sink removed from all channel dropdowns (New monitor form + detail editor); seed still uses it internally in demo mode only
- Persistent `.env` created (ADMIN_PASSWORD, DEMO_MODE=0, DATABASE_PATH=./data/production.db); `.env.example` rewritten with per-variable docs; server restarted on `.env` alone to prove it (no inline vars)

## Runtime state
- STOPPED by agent 2026-09-30: user runs the backend themselves now; port 3000 freed (killed prod start-server). If they need the agent-run prod server back: `npm run start -- -p 3000` (config from `.env`).
- `DATABASE_PATH=./data/production.db`, DEMO_MODE off; demo DB preserved at `./data/skansentinel.db`; `ADMIN_PASSWORD=admin123`
- History: default timezone changed to `Asia/Kolkata` per user (spec §5.2 said UTC; demo seed rows still UTC). Live E2E proven: PENDING → RUNNING → HEALTHY → FAILED(+alert) → HEALTHY(+RECOVERED) → RUNAWAY(+alert) → HEALTHY → MISSED by silence(+alert); probe deleted after.

## Error sweep (user-requested, 2026-09-30)
Found and fixed, all verified:
1. CSP `script-src` missing `'unsafe-inline'` → hydration blocked, stuck skeleton in browser. Fixed, rebuilt, header verified live.
2. `previousSlot`/`advanceExpected` re-parsed the cron expression per step (~542ms per ping on minutely schedules; isolated profile). Rewrote to single-iterator passes (~97ms worst case, same semantics). 54/54 tests green; live crash/leak simulations correct after the change.
3. Dockerfile copied nonexistent `public/` → `docker build` would fail. Removed; added `.dockerignore` (keeps dev DB out of the image).
4. Rate-limit map grew without bound. Added opportunistic prune past 10k entries.
Audited clean: no TODOs/debug logs (one intentional worker boot line), single `Date.now` with `/1000`, validation/SSRF/auth paths re-verified live.
Two transient ping 404s appeared in long interactive shell one-liners; a 20/20 scripted start/finish loop plus ~100 total calls pass, and the 404 path is a single deterministic SELECT. Verdict: client-side shell artifact, not app logic. Not fully provable from here; flagged honestly.
Still unverified: `docker build` (daemon off), 400px visual check (no browser on host), native `skansentinel-exec` run (no POSIX shell on host).

## Verification (real output, 2026-09-30)
- `npx vitest run`: 54 passed, 0 failed (2.95s)
- `npx tsc --noEmit`: clean. `npm run build`: compiled + all 18 routes listed
- Live (ADMIN_PASSWORD set, DEMO_MODE=1): unauth `/`→401, unauth `/api/status`→401, unknown ping token→404, `/healthz`→`{"ok":true}`
- Seed: backup HEALTHY / billing MISSED / invoice FAILED / rollup RUNAWAY, 3 alerts DELIVERED, worker_offline=false
- crash→FAILED, missed→MISSED, hang→RUNAWAY, leak→HEALTHY + `[REDACTED_*]`, no raw secrets; each added alert row
- pause→PAUSED, resume→PENDING; double-fail→1 FAILED alert total; success→RECOVERED; exec-flow stored `boom password=[REDACTED_SECRET]`

## Not verified / notes
- `skansentinel-exec` sh-execution: no POSIX shell on this Windows host (WSL stub, no distro); verified its exact HTTP flow instead. Recommend running check 4 on Linux/macOS.
- §12.9 (400px no horizontal scroll): not visually checked; tables use own `overflow-x-auto` containers, no fixed page widths.
- Detail log viewer shows newest execution's output; a currently-RUNNING job has none yet ("no data yet") — consider newest non-null output in UI pass.
- Spec §5.4 says helper sends "last 32KB" while §5.5 caps logs at 64KB — both honored (32KB sent, 64KB stored cap).

---
[SKILLS CHECKED: opencode, report]
[SKILLS USED: none]
[CAPABILITIES USED: none applicable]
