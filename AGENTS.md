# CF-Server-Monitor — Project Guide (isengard deployment)

> **Upstream:** https://github.com/huilang-me/CF-Server-Monitor (MIT) · fork-free local clone
> **Worker:** `cf-server-monitor` · **URL:** https://monitor.cachorro-server.stream (Cloudflare Access gated)
> **D1:** `server-monitor-db` · **DO:** `MetricsBroadcaster` (SQLite, single global instance)
> **Deployed:** 2026-10-27

---

## 1. What this is

Cloudflare Workers + D1 + Durable Objects server-monitoring panel. Servers run the
`cfsm-agent` probe, which pushes metrics **one-way** to `POST /update`. There is no
WebSSH, no remote command channel, no inbound listener on the agent.

---

## 2. Local deployment (this repo is the deploy source)

```bash
cd /home/daniel/projects/cloudflare/CF-Server-Monitor
npm install
npm run build:frontend          # required before deploy
npx wrangler deploy
```

`wrangler.toml` (local overrides vs upstream):
- `workers_dev = false` — the `*.workers.dev` hostname is **not** reachable; only the
  Access-gated custom domain is. Access apps do not govern `workers.dev` hostnames,
  so leaving it on would bypass the gate entirely.
- `routes = [{ pattern = "monitor.cachorro-server.stream", custom_domain = true }]`
- `[[d1_databases]]` pinned to `database_id = 8ecb1f63-bdd4-4d74-9d3c-75e0dee5ee38`
- `[vars] CORS_ALLOWED_ORIGINS` — self-origin only.

> **`workers_dev` and `routes` must be top-level TOML keys.** Putting them inside
> `[vars]` silently turns them into plain env vars — the deploy still succeeds but the
> route is never created. Symptom: `env.workers_dev (false)` listed under
> *Environment Variable* and `https://<name>.<subdomain>.workers.dev` still printed.

### Secrets
`API_SECRET` and `JWT_SECRET` are **encrypted Worker secrets**, set with
`wrangler secret put` — never in `[vars]`, never in `wrangler.toml`.

```bash
npx wrangler secret put API_SECRET
npx wrangler secret put JWT_SECRET
```

Local copies of the live credentials live at `~/.config/cf-server-monitor/credentials.env` (mode 600).

---

## 3. Cron budget — READ BEFORE ADDING TRIGGERS

Workers **Free** allows **5 cron triggers per account**. Already consumed:

| Worker | Triggers | Count |
|---|---|---|
| `cf-ledger` | `17 3 * * *` | 1 |
| `inkstone` | `0 * * * *`, `15,45 * * * *` | 2 |
| `zerolink-api` | `0 * * * *` | 1 |
| `cf-server-monitor` | `*/1 * * * *` | 1 |

**One slot free.** `cf-server-monitor` therefore registers a **single** `*/1 * * * *`
trigger; the hourly work (table rotation, expiry reminders) is folded into
`src/index.js` `scheduled()` under `if (minute === 0)`. Do not re-add `0 * * * *`
without first removing a trigger elsewhere.

---

## 4. Security posture (post-audit hardening)

A security review of the upstream code produced findings that were fixed **in this
local clone** — keep these when pulling upstream changes:

| File | Change |
|---|---|
| `src/handlers/update.js` | Authenticate from `X-API-Secret` **before** parsing the body; hard byte cap enforced while *reading* the stream (not via `Content-Length`, which chunked requests can forge). Secret compared with a constant-time helper. |
| `src/middleware/auth.js` | Login **fails closed** when no independent admin password is set (it no longer falls back to `API_SECRET`). JWT signing **never** falls back to `API_SECRET`; it requires `sys.jwt_secret` or the `JWT_SECRET` Worker secret. JWTs use **base64url** so `?token=` query params survive. |
| `src/index.js` | The Turnstile-verified path no longer reflects an arbitrary `Origin` with `Access-Control-Allow-Credentials: true` — every response goes through the CORS allowlist. |
| `src/handlers/admin.js` + `src/utils/loginRateLimit.js` | Per-client exponential backoff on failed logins (Turnstile is **not** available on this account — widget creation returns error 7003). |
| `src/durable/MetricsBroadcaster.js` | Constant-time `API_SECRET` comparison on the agent WebSocket path. |

### Live configuration
- `is_public = 'false'` — the dashboard API requires a session; the site is not public.
- Admin credentials are **separate** from `API_SECRET` (username `daniel`).
- Admin password stored as PBKDF2-HMAC-SHA256, 50 000 iterations, 16-byte salt, 32-byte key.
- `auto_discovery = 'false'` — servers must be created explicitly in the admin panel.
- `custom_head` / `custom_script` empty (both are raw HTML/JS injected into every page).
- Cloudflare Access app `a847d6ff-a7b8-4d16-9d91-951d29c1ef9f`, policy `allow-owner`,
  with a **destination override** making `/update` public so the agent can report
  without an Access session.

### Accepted residual risk
- **One shared `API_SECRET` for all agents.** Any compromised agent host can write
  metrics for any server and can reset traffic-correction state. Mitigated by
  per-host file permissions (0600) and the Access gate, not eliminated.
- The panel still serves a third-party GitHub theme and `custom_script` at panel
  origin. Both are admin-only settings — do not enable them casually.
- PBKDF2 iteration count is upstream's 50 000 (guidance suggests ≥600 000).

---

## 5. Agent installation on monitored hosts

`cfsm-agent` is a **separate repo** (https://github.com/huilang-me/cfsm-agent), cloned
to `cfsm-agent/` inside this directory.

Install as a **non-root user** (`systemd --user`), never root:

```bash
# 1. Fetch the pinned release + checksums (never `curl | sh`)
curl -fsSL -o cf-probe "https://github.com/huilang-me/cfsm-agent/releases/download/v1.1.0/cf-probe-linux-amd64"
curl -fsSL -o checksums.txt "https://github.com/huilang-me/cfsm-agent/releases/download/v1.1.0/checksums.txt"
sha256sum -c <(grep 'dist/cf-probe-linux-amd64$' checksums.txt | sed 's|dist/||' | sed 's|  |  cf-probe |')

# 2. Install (user mode is chosen automatically when not root)
chmod +x cf-probe
./cf-probe install -id=<SERVER_UUID> -secret='<API_SECRET>' \
  -url='https://monitor.cachorro-server.stream/update' -interval=60 -auto_update=1
```

- Config lands in `~/.cf-probe/config.conf` (mode 0600).
- `loginctl enable-linger <user>` is required so the service survives logout.
  On isengard, `daniel` already has `Linger=yes`.
- Auto-update verifies SHA-256 against `checksums.txt` — keep `auto_update=1`.
- The agent's `install` command embeds `-secret` in argv, so it is briefly visible in
  `ps` during installation. Avoid running it from a shared shell history.

### isengard (this host)
- Service: `cf-probe.service` (systemd **user** unit, `daniel`)
- Server UUID: `1b7ed4aa-a16f-410d-9c98-545e12a3fd3c`
- Status: `systemctl --user status cf-probe` · Logs: `journalctl --user -u cf-probe -f`

---

## 6. Adding more servers

1. Admin panel → **+ ADD SERVER** (name, group, region). Record the UUID.
2. On the target host, install the agent with that UUID and the same `API_SECRET`.
3. Confirm it appears ONLINE in the dashboard.

The UUID is required — auto-discovery is disabled. Enabling it would let any host
that knows `API_SECRET` create rows in the panel.

---

## 7. Maintenance

```bash
# Update the panel
git pull && npm install && npm run build:frontend && npx wrangler deploy

# Rotate API_SECRET — invalidates every agent install, re-provision each one
npx wrangler secret put API_SECRET
# then, per host: cf-probe install -id=<UUID> -secret='<NEW>' -url='https://monitor.cachorro-server.stream/update'

# Rotate the admin password
# Admin panel → Settings → Security → password (stored as a PBKDF2 hash)

# Backup the D1 database
npx wrangler d1 export server-monitor-db --remote --output=backup-$(date +%F).sql
```

---

## 8. Tests

```bash
npm test          # full suite
npm run test:all  # + agent-config and history-query suites
```

`test/security-hardening.test.js` covers the patches in §4 and **must stay green**.
One upstream test (`frontend-live-socket.test.js`) fails in this environment because
`vite-plugin-mkcert` needs an interactive `sudo` to install a CA — unrelated to any
change in this clone.
