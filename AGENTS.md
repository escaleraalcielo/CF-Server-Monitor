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

### Password hashing is bounded by the platform, not by the guidance

`PASSWORD_HASH_ITERATIONS` is **50 000**, not the OWASP figure of 600 000. That is not an
oversight — **workerd hard-caps PBKDF2 at 100 000 iterations**
(`cloudflare/workerd#1346`, a DoS guard). Above that, `crypto.subtle.deriveBits` throws
`NotSupportedError`, the login endpoint 500s, and the panel becomes unreachable.

Measured on the edge with a throwaway probe worker on this account (and deleted afterwards):

| Iterations | Result | Cloudflare `cpuTime` | `outcome` |
|---|---|---|---|
| 50 000 | 200 | 7 ms | ok |
| 100 000 | 200 | 13 ms | ok |
| 300 000 | **1101** | 0 ms | **exception** |
| 600 000 | **1101** | 0 ms | **exception** |

Two things worth keeping straight:

- The failure is an **exception**, not `exceededCpu`. It is a runtime API limit, so
  **upgrading the plan does not unlock 600 000** — there is no plan that allows it.
- 50 000 is half the platform ceiling and costs **7 ms of CPU per login**, inside the
  10 ms single-request budget of the Workers Free plan. 100 000 would also work (13 ms)
  but sits over the documented budget and is closer to the runtime's tolerance.

> The iteration count is stored inside the hash (`pbkdf2_sha256$<iterations>$<salt>$<hash>`),
> so changing the constant never invalidates an existing password: old hashes still verify
> and are flagged for a re-hash, so they upgrade themselves on the next successful login.
> A hash below the current count is only flagged for a rewrite when the password was
> **correct** — matching the legacy-MD5 branch — so a failed login never rewrites the row.

### Where heavy work belongs: the DO has 30 s, a Worker request has ~1 s

Measured on this account (Workers Free) on 2026-10-28 with a throwaway probe worker, burning
CPU in repeated 100 000-iteration PBKDF2 derivations (13 ms of accounted CPU each) and reading
Cloudflare's own `cpuTime`/`outcome` from `wrangler tail`:

| Path | Effective CPU ceiling | Reported at failure |
|---|---|---|
| Worker request (stateless) | ~1 s — 624 ms survived, ~1 s+ killed | `exceededCpu`, cpuTime 126–2058 ms |
| Durable Object invocation | **30 s** | `exceededCpu`, cpuTime exactly **30000 ms** |

The Free plan *documents* 10 ms of CPU per Worker request, and the runtime enforces it with far
more tolerance than that — a Worker request survived 624 ms of real CPU here. But that is
**not** the same budget as a Durable Object's, which is enforced exactly at 30 s. So:

- Anything that has to burn more than a few ms of CPU belongs in the **Durable Object**, not
  in the Worker request path.
- The 30 s is the DO class's `limits.cpu_ms` default, not a plan allowance — it is the same on
  Free and Paid.

The current split already respects this: the per-minute cron and the `/update` handler stay in
the Worker and measure **6.5 ms average / 39 ms max**, while the metric fan-out to WebSocket
subscribers runs in `MetricsBroadcaster` (**6.1 ms average / 14 ms max**). Both sit far below
the ceiling that actually bites, which is why the panel has run two days with zero errors
despite exceeding the documented 10 ms on its tail.

### What the browser may see (2026-10-28)

`get_settings` no longer returns `api_secret`. That value is the shared key every agent
authenticates with and it sits in `config.conf` on every monitored host, so anything that
can read the admin panel could read it too. It now comes from a separate
`get_install_secret` action that the admin UI calls **only when the install-command
dialog opens**, and drops when it closes.

`turnstile_secret_key` and `cloudflare_token` are returned **masked**
(`••••••••`) with a `*_configured` flag. Saving a masked value means "unchanged":
`stripMaskedSecrets` drops it from the update so the spread in `saveSiteOptions` keeps the
stored value. A newly typed value still replaces it. The mask is deliberately non-empty so
the form does not read as "unset".

> `tg_bot_token` is **not** masked. It doubles as the SMTP channel carrier
> (`smtp://user:pass@host:port`), so masking it breaks channel detection and the
> "switch back to builtin" path that clears the field. Redacting it properly needs a
> separate field for the SMTP config, not a mask — left as a known gap.

> The admin API is behind Cloudflare Access, so it cannot be driven from a plain
> `curl`. To exercise it end-to-end, run the worker locally against a D1 seeded with a
> copy of the production `site_options` row:
> `npx wrangler d1 execute server-monitor-db --local --persist-to <dir> --file seed.sql`
> then `npx wrangler dev --local --persist-to <dir> --port 8802 --var API_SECRET:...`.
> `https://localhost:8802` uses a local TLS cert, so use `curl -k`.

> **`API_SECRET` was rotated 2026-10-28.** The previous value had been written into an
> agent session log and was therefore uploaded to MEGA inside the AgentsView archive
> (`~/.agentsview/sessions.db`, backed up nightly). Rotating invalidated it — every
> candidate in that log is now rejected with 401 by `/update`. Because `API_SECRET` is
> the **shared ingest secret**, the rotation is only safe if every agent is
> re-provisioned in the same window: the worker, the local agent, and each remote
> agent's `SECRET=` line (then restart its `cf-probe.service`).
>
> When rotating, keep the value out of transcripts and argv:
> - generate it to a `umask 077` file, never echo it;
> - `wrangler secret put API_SECRET < file`;
> - ship it to a remote host over **stdin** (`ssh host 'cat > ~/.cf-probe/.newsec' < file`),
>   not in a command line — the agent's own install template puts it in argv, which shows
>   up in `ps` and in shell history;
> - verify by hashing the value on each host, not by printing it.
>
> The agent config's `SECRET=` line has no spaces around `=` (`SECRET="..."`); a `sed`
> pattern written for `SECRET = ...` silently matches nothing and leaves the host
> reporting with the old secret.

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

### Monitored servers

All four run the agent as a **non-root** systemd user unit, config mode 0600,
`loginctl enable-linger` set so they survive logout and reboot.

| Host | SSH | User | Server UUID | Install dir |
|------|-----|------|-------------|-------------|
| isengard | `isengard` | daniel | `1b7ed4aa-a16f-410d-9c98-545e12a3fd3c` | `~/.cf-probe/` |
| rivendell | `rivendell` | ubuntu | `40b59591-5142-4142-8eab-e10e7641dc8e` | `~/.cf-probe/` |
| erebor | `erebor` | ubuntu | `4804745b-6f12-4d68-a07a-2d3adcfe6e86` | `~/.cf-probe/` |
| gondor | `gondor` | root → `cfsm` | `08439a19-f66f-40d7-883a-645a270d9cf0` | `/home/cfsm/.cf-probe/` |

- Status: `systemctl --user status cf-probe` · Logs: `journalctl --user -u cf-probe -f`
- `gondor` runs as a dedicated `cfsm` system user (not root).

### Inspecting a user systemd unit over SSH

`systemctl --user` always talks to **the calling user's** user manager. Running it as
root inspects root's manager, so another user's unit looks missing even when it is
healthy. Always run it as the service owner with that user's runtime dir:

```bash
# on the target host, as root
runuser -u cfsm -- env XDG_RUNTIME_DIR=/run/user/$(id -u cfsm) \
  systemctl --user is-enabled cf-probe.service
runuser -u cfsm -- env XDG_RUNTIME_DIR=/run/user/$(id -u cfsm) \
  journalctl --user -u cf-probe --no-pager -n 20
```

### The installer can leave a unit present but not enabled

When the installer runs under `sudo -u`/`runuser` without `XDG_RUNTIME_DIR`, it writes
the unit file but the `systemctl --user enable` step silently no-ops. The unit exists,
the agent runs, and it still dies on reboot. After every install check both:

```bash
systemctl --user is-enabled cf-probe.service          # must print "enabled"
ls -l ~/.config/systemd/user/default.target.wants/cf-probe.service   # symlink must exist
```

`is-active` alone is not enough — it says nothing about boot persistence.

### Verifying the agent binary

Fetch the pinned release and its `checksums.txt`, verify, then run. A single `sed`
strips the `dist/` prefix; do **not** substitute the filename a second time or the
line is corrupted and verification fails:

```bash
grep 'dist/cf-probe-linux-amd64$' checksums.txt | sed 's|dist/||' | sha256sum -c -
# -> cf-probe-linux-amd64: OK
```

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

# NOTE: the Durable Object singleton (idFromName('global')) can keep serving the
# OLD secret for a couple of minutes after the rotation, while the Worker's HTTP
# path already accepts the new one. The agent then logs
#   server error code=401 Invalid secret
# and recovers by itself on the next retry (backoff caps at 5m). Do NOT re-issue the
# rotation in response — check with:
#   curl -X POST https://monitor.cachorro-server.stream/update -H "X-API-Secret: <NEW>" ...
# (200 = the Worker is already on the new secret) and wait for `WSS connected`.
# Re-running `secret put` restarts the clock and extends the outage.

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
