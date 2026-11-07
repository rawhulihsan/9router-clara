# Prompt Injection fork

Based on upstream v0.5.112. Dashboard: `/dashboard/prompt-injection`.

Supports global, API-key, model/combo and key+model targets; single system prepend/append or alternating user/assistant script. Disabled entries do not apply. Backups include injection config.

## Installed topology

- Original `9router` remains running on host port 20128; provider credentials, OAuth refresh and routing remain solely owned by it.
- `9router-injection` runs fork front mode on 20129 with isolated `/opt/9router-docker/front-data` and shared dashboard JWT secret supplied through root-only env file. No provider credentials copied.
- Front upstream uses `http://127.0.0.2:20128`, deliberately excluded from redirect rules.
- IPv4 new connections targeting host .19 or local .1/.18/.19 port 20128 redirect to 20129; established flows remain untouched. Original container not stopped/restarted.
- Routing unit: `9router-injection-routing.service`; waits for front health before applying rules at boot.

## Verification

Node backend/db tests: 9 passed. Front HTTP tests: 4 passed. UI check passed. Production Next build exit 0. Real authenticated models, CRUD, completion injection marker and SSE finished successfully on 20129 and redirected 20128. Cutover probe: 100/100 health responses HTTP 200. Test injection removed afterward.

## Limits

Front currently buffers inference JSON with 4 MiB cap, unlike upstream's 128 MiB cap. Compressed inference bodies return 415. Upstream idle timeout 120 seconds; incoming body read timeout 30 seconds. These are deliberate bounds, not parity for large image/audio payloads. Live end-to-end provider check covered Gemini chat completion/SSE; Claude, Responses and Gemini native body transforms covered unit tests, not all upstream providers live. No claim of absolute zero defects or zero downtime beyond measured checks. Host reboot and public Cloudflare hostname were not exercised.

## Rollback (does not stop either container)

```bash
ssh root@192.168.1.19 'systemctl disable --now 9router-injection-routing.service'
```

New connections return to original. Existing front connections must drain; do not kill containers to rollback. Do not restore stale SQLite snapshots over a live writer.

## Rebuild

Full source image: original Dockerfile. Installed front uses Dockerfile.front over immutable locally tagged original image plus production standalone build. Build on glibc may emit incompatible better-sqlite3 binaries on Alpine; tested runtime falls back to native node:sqlite (not sql.js).

```bash
npm ci --no-audit --no-fund
NODE_OPTIONS=--max-old-space-size=1536 npm run build
node --experimental-loader ./tests/prompt-injection-loader.mjs --test tests/prompt-injection-backend.test.mjs tests/prompt-injection-db.test.mjs
node --test tests/prompt-injection-front.test.cjs
node tests/prompt-injection-ui.test.cjs
```
