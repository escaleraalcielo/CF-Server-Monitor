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

### The public payload is an allowlist, not a denylist

Unauthenticated responses are built by `toPublicServer()` in `src/utils/publicPayload.js`,
which starts from an **empty object** and copies only the fields named in
`PUBLIC_SERVER_FIELDS`. A field added to the `servers` table later is therefore private by
default, instead of being published until somebody remembers to delete it.

- The machine hostname, the private note, tags, price/billing/expiry, the agent configuration
  and the traffic corrections are never public, and the server id is not in the public
  payload.
- `ip_v4` / `ip_v6` appear only as a reachability flag (`'1'` / `'0'`).
- A server the operator marked private does not appear in the public list at all.
- The HTTP public response's live-update frames carry no `serverId`. The live WebSocket
  stream still identifies a server by its internal id — a UUID, not a host name or an address
  — and its IP fields are masked to a reachability flag there as well.

The authenticated admin view is unaffected: it still returns every field.

`test/public-payload.test.js` seeds a row whose private fields contain a marker string and
asserts that the marker appears in no public response body.

### The agent config channel has one source of truth

`src/utils/agentConfig.js` defines `AGENT_CONFIG_FIELD_SPECS`: an ordered list where each
entry names one key, the minimum negotiated schema version that may receive it, and how its
value is resolved. `buildAgentConfig()` walks that list to assemble the payload, and
`serializeAgentConfig()` walks the same list to render the body whose MD5 the agent
verifies — so the two can never diverge, and a key cannot be added to one and forgotten in
the other.

Only inert configuration is on that list. It never contains an update trigger (`update`,
`auto_update`), a download URL (`update_proxy`), a credential (`secret`), or any key that is
not explicitly named: the panel cannot become a channel that makes an agent act.

The serialized output is **byte-identical** to the pre-refactor implementation for existing
configs, so the MD5 a deployed agent verifies does not change and no agent re-applies its
config.

### The traffic baseline rebaselines itself when the counter identity changes

Agents report lifetime byte counters, and the panel derives usage from the difference between
consecutive readings. That difference is only meaningful while the counter is the same
counter, so the baseline is rebaselined whenever that stops being true.

The baseline lives in the `servers.traffic_baseline` column (JSON), so it survives a Durable
Object restart and a Worker cold start. `src/utils/trafficBaseline.js` holds the state
machine; `stepTrafficBaseline()` is pure — same input, same decision — and the D1 read/write
lives in `loadTrafficBaseline()` / `saveTrafficBaseline()`.

Rebaseline reasons, in the order they are checked:

| Reason | Trigger |
|---|---|
| `reset_day` | the billing period rolled over — the existing behaviour, unchanged |
| `boot_id_changed` | the agent reported a different boot id |
| `interface_digest_changed` | the agent reported a different set of counted interfaces |
| `counter_regression` | the counter went **backwards** — a reboot, with no agent change at all |

**A rebaseline does not wipe the period's usage.** The amount accumulated so far
(`carry + (last - baseline)`) is carried into the new baseline, so a machine that reboots
mid-period keeps its traffic for that period and does not report its counters twice.

The two agent-side fields are **optional**. `boot_id` and `interface_digest` are read when
present and ignored when absent — which is the case for every agent in production today,
since there is no `cfsm-agent` fork that reports them. Regression detection covers the
reboot case on its own, so the feature works today and gets sharper when the agent side
lands.

### Where heavy work belongs: the DO has 30 s, a Worker request has no clean ceiling

Measured on this account (Workers Free) on 2026-10-28 with a throwaway probe worker, burning
CPU in repeated 100 000-iteration PBKDF2 derivations (13 ms of accounted CPU each) and reading
Cloudflare's own `cpuTime`/`outcome` from `wrangler tail`:

| Path | Ceiling | Reported at failure |
|---|---|---|
| Durable Object invocation | **30 s**, exactly | `exceededCpu`, cpuTime exactly **30000 ms** |
| Worker request (stateless) | no clean per-request figure | `exceededCpu`, cpuTime 126–2058 ms for the same sweep |

Only the Durable Object number is quotable. The Worker side is **erratic**: 624 ms of real CPU
survived, the kills came later, and the `cpuTime` Cloudflare reported for the killed
invocations ranged from 126 ms to 2058 ms — so the runtime is terminating on a per-isolate
budget rather than on a fixed per-request wall, and the reported figure is not the amount of
work that was attempted. Treat the Worker side as "well under the DO's 30 s and comfortably
above what this Worker uses", not as a precise number.

What is not in doubt: the Free plan *documents* 10 ms of CPU per Worker request, and the runtime
enforces it with far more tolerance than that. The Durable Object's 30 s is a separate budget
that was **measured here** (exactly 30000 ms, `exceededCpu`); the DO limits table also lists
30 s as the default, and describes the same number as the DO class's `limits.cpu_ms` default
rather than a plan allowance. The two sources are not fully consistent with each other — the
DO FAQ says Durable Objects share the per-invocation limits of any Worker, while the limits
table gives Durable Objects 30 s — so trust the measurement over the prose.

So:

- Anything that has to burn more than a few ms of CPU belongs in the **Durable Object**, not
  in the Worker request path.
- Do not quote a Worker-request CPU ceiling from a single probe run; the number moves with
  what the isolate did before it.

The current split already respects this: the per-minute cron and the `/update` handler stay in
the Worker and measure **6.5 ms average / 39 ms max**, while the metric fan-out to WebSocket
subscribers runs in `MetricsBroadcaster` (**6.1 ms average / 14 ms max**). Both are far below
the Durable Object's 30 s and far below anything that has killed an invocation here, which is
why the panel has run two days with zero errors despite exceeding the documented 10 ms on its
tail.

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

### Per-node agent tokens (transition window)

Each monitored server can now have **its own** upload credential instead of sharing
`API_SECRET`. Ingest accepts **either**:

- the shared `API_SECRET` (what the four deployed agents still know), or
- that server's own token (`cfsat_…`).

| Piece | Where |
|---|---|
| Storage (`agent_tokens`, SHA-256 digest only) | `src/database/schema.js` → `ensureAgentTokenSchema` |
| Token logic (`generate` / `authenticate` / `revoke` / usage counter) | `src/utils/agentTokens.js` |
| HTTP ingest (header `X-API-Secret`, body `secret`) | `src/handlers/update.js` → `authenticateAgentCredential` |
| Admin actions | `src/handlers/admin.js` → `create_agent_token` / `rotate_agent_token` / `revoke_agent_token` / `get_agent_token_status` |
| Install command embeds the node token | `src/frontend/views/admin/index.vue` → `resolveAgentInstallSecret` |

Rules that must keep holding:

- The **plaintext** token is returned exactly once (create/rotate response) and is
  never retrievable again — the database only holds `sha256(token)`.
- Comparison is constant-time (`timingSafeEqualString`); never `===` / `!==` on a secret.
- A node token authenticates **one** server: presenting node A's token for server B is 401.
- Revoking is immediate — there is no token cache on the ingest path.

**Shared-secret usage counter.** `settings` key `api_secret_usage` holds
`{ total, hour, hour_count, last_used_at }`. `hour_count` counts uses in the current
UTC hour and **falls back to 0** once the hour rolls over, so an operator can watch it
reach zero and then retire the shared secret. `get_agent_token_status` returns
`shared_secret_usage_count` (this hour), `shared_secret_usage_total` and
`shared_secret_usage_last_used_at`; every shared-secret report also logs the count.

Both ingest paths go through the **same** credential check — `authenticateAgentCredential()`
in `src/utils/agentTokens.js` — so HTTP and WSS reports both move the counter and both
accept a node token. The Durable Object path is covered by `test/agent-token-ws.test.js`:
a valid node token is accepted, a node token used for another server is rejected with 401,
the shared secret is accepted **and counted**, and an unknown credential is rejected.
Reverting the Durable Object to the old shared-secret-only comparison fails two of those
four.

> **This work is not deployed.** Production still runs the pre-token build, and there is no
> `cfsm-agent` fork that can send a node token yet. The shared secret is still accepted, so
> the deployed agents keep working either way — but **do not retire `API_SECRET` on the
> counter alone**: every host has to be re-provisioned with its own token first, and the
> token plaintext cannot be read back from the panel.

> Migrating a host to its own token means re-provisioning it: `cf-probe install -id=<UUID>
> -secret='<node token>' …`, then restart `cf-probe.service`. The node token plaintext is
> only shown once, so copy it at creation time — it cannot be read back from the panel.

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
- **One shared `API_SECRET` for all agents** — being phased out. Per-node tokens exist
  now (see *Per-node agent tokens* above), but the shared secret still authenticates
  every report and is still present in each host's `config.conf` until every agent is
  re-provisioned. Until then, any compromised agent host can still write metrics for any
  server and can reset traffic-correction state.
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
2. On the target host, install the agent with that UUID and the same `API_SECRET`
   (or with the server's own node token — see *Per-node agent tokens* above).
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
npm test                  # the node:test suite (26 files)
npm run test:agent-config # the agent config serialization suite (a plain script)
npm run test:history-query
npm run test:all          # all three, chained with &&
```

**`npm run test:all` is the gate.** `npm test` alone leaves two suites out: `test/agent-config.js`
(runs as a plain script, `node test/agent-config.js` — it is the suite that pins the agent config
serialization and its MD5) and `test/history-query.test.js`. `src/utils/agentConfig.js` is covered
**only** by the first of those, so a refactor of the config channel can look green under `npm test`
and still be broken.

The `&&` chain short-circuits on the first failure, and in this environment `npm test` always fails
on the mkcert test below — so `npm run test:all` never reaches the other two. Until that failure is
fixed, run `npm run test:agent-config` and `npm run test:history-query` directly.

`test/security-hardening.test.js` covers the patches in §4 and **must stay green**.
One upstream test (`frontend-live-socket.test.js`) fails in this environment because
`vite-plugin-mkcert` needs an interactive `sudo` to install a CA — unrelated to any
change in this clone. It fails identically on the base commit, so compare against the
base before blaming a change.
