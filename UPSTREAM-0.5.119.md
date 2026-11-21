# Upstream v0.5.119 integration

Selected upstream tag: `v0.5.119` (not a claim about GitHub latest).
Merge commit: `26ab05da`. All build/tests ran in Docker Cloud Sandbox
`9router-update`, source `/home/agent/9router`; no production credentials or deployment.

## Preserved behavior

- Prompt Injection dashboard, backend, scoped config, backup/restore and retry idempotence remain.
- Exact configured prefixes beat built-in short aliases; full native provider IDs stay reserved. Upstream Claude OAuth bare-model fallback also remains.
- Sole merge conflict: `openai-to-claude.js`. Accepted upstream shared tool-result builder: always emits boolean `is_error`, preserves explicit true, additionally recognizes `status: "error"`. Existing Zed regression passes.
- `Dockerfile.unified` pins `decolua/9router:0.5.119`; overlays standalone without replacing base node_modules. Base manifest used: `sha256:38e58865ff111599f409f44430084ad0016c2ba530757ef545848d4bbe0cf007`.

## Verification

- Node backend/DB: 9 passed, 0 failed (`custom-backend.log`).
- Front HTTP fixtures: 4 passed, 0 failed (`custom-front.log`).
- UI compile/hook/fetch fixtures: PASS (`custom-ui.log`); not browser E2E.
- Routing, Claude fallback, Zed wire and lazy-runtime regressions: 24 passed across 4 files (`custom-routing-regression.log`).
- Production `npm run build`: exit 0, includes dashboard and both injection API routes (`build.log`).
- Docker unified build: exit 0 (`docker-build.log`).
- Final-image isolated smoke: health 200, unauthenticated injection API 401, authenticated CRUD/dashboard 200, native `node:sqlite` integrity `ok` (`image-smoke.log`, `image-runtime.log`). `wreq-js`, `playwright-core`, `undici` resolve and import successfully inside image. No real provider request tested.
- Full Vitest: exit 1. 419 passed / 20 failed / 17 skipped files; 4564 passed / 51 failed / 14 expected fail / 101 skipped / 1 todo tests. All 20 failed files rerun against pristine tag `v0.5.119`: same 51 failed tests plus same 3 suite failures. Compared all 54 `FAIL` entries programmatically: zero integration-only differences (`upstream-failures.log`).
- Existing blockers include absent `lowdb`, missing cloud embedding module, node:test file collected by Vitest, missing host ffmpeg, live/network/mock transport expectations, stale version/platform header snapshots, API-key masking assertion, request-normalization assertions and response tool-delta assertion. They were not hidden, patched or blessed by updating snapshots. Full-run snapshot writes remain sandbox-only.
- Sandbox npm 9 peer resolver crashed (`edgesOut`) installing Vitest. Isolated test runner installed with `--legacy-peer-deps`; no repository dependency change. Custom tests require `TMPDIR=/home/agent/tmp`.

## State and migration review

`git diff v0.5.112 v0.5.119 -- src/lib/db src/lib/localDb.js` is empty.
No migration/schema/adapter/repository change from selected upstream update; existing schema chain remains initial migration plus additive startup sync. Existing Prompt Injection uses `kv`, no added table migration.

Unchanged hazards still apply: startup prunes old backups and writes metadata; schema backup failure logs and continues; explicit import/restore deletes and replaces configuration tables and scopes (including prompt injections). Do not use import/restore as startup migration, overwrite live SQLite, share rotating OAuth writers, or drop WAL. Parent must take current online backup, queue/drain old writer, preserve sidecars and enforce single state owner before cutover. No production migration executed here. Existing native Gemini TTS/stored-alias scope limitations remain outside verified chat paths.

## Artifact

Sandbox image: `9router-unified:0.5.119-custom`
Image ID: `sha256:e616ef9b641ffb57ae4742633eb2fb5c1014cd17f2ff48bf08af8bf8938a9319`
Archive: `/home/agent/9router-update-final.tar.gz` (346261772 bytes)
SHA256: `08fd6477ff32c25fcfa39f44e081769ea69ce61d41f93451e52f2fb71f460bf8`
`gzip -t` passed. Archive contains image, not sandbox smoke container state.
Parent owns transfer/cutover; artifact not deployed.
