# Remote-development confidence gate

Run `npm run test:remote` before accepting remote changes. CI runs this same command.
The gate discovers all `lib/**/*.test.ts` files, including `lib/db` PostgreSQL
tests, and fails if required Node, Python, or browser tests skip. It also requires
TypeScript checking, a production Next build, operational preflight, and a clean
`git diff --check`. Tests use real PostgreSQL transactions and real FFmpeg; AI,
detector-service, and object-storage network boundaries remain local fixtures.

## Setup

Use Node 22.15.0, pnpm 10.23.0, Python 3.10, PostgreSQL 16, FFmpeg with libx264 and
libass, FFprobe, and fontconfig (`fc-scan`). The checked-in DejaVu font and license
keep caption fixtures consistent. Install dependencies with:

```sh
pnpm install --frozen-lockfile
python3.10 -m venv services/media-api/.venv
services/media-api/.venv/bin/python -m pip install -r services/media-api/requirements-test.lock
pnpm exec playwright install --with-deps chromium
```

Linux also needs `ffmpeg fontconfig libportaudio2`. The pinned Python test lock
captures the media runtime used for these checks; update it deliberately when
upgrading the service, and rerun the real decoder/detector tests.

Provide a disposable loopback database named `disburse_phase1a_test` or
`disburse_phase1a_test_<suffix>`. The role needs CREATEDB because existing migration
and effect-boundary suites create their own disposable databases. PostgreSQL 16
is checked before any suite starts. The gate rejects connection-query overrides.
For example, with Docker already installed:

```sh
docker run --rm --name disburse-remote-tests \
  -e POSTGRES_USER=disburse_test -e POSTGRES_PASSWORD=disposable-test-only \
  -e POSTGRES_DB=disburse_phase1a_test_remote -p 127.0.0.1:54329:5432 \
  --tmpfs /var/lib/postgresql/data postgres:16.14
```

In another shell, wait for that server to become ready, then run:

```sh
PHASE1A_TEST_DATABASE_URL=postgres://disburse_test:disposable-test-only@127.0.0.1:54329/disburse_phase1a_test_remote \
  npm run test:remote
```

Stop the example container with `docker stop disburse-remote-tests`. Never point
the gate at `disburse_dev`, staging, production, or an unknown database.

`REMOTE_TEST_PYTHON` selects a Python executable when using a different venv.
`FFMPEG_PATH`, `FFPROBE_PATH`, and `PLAYWRIGHT_BROWSERS_PATH` support installed
runtime locations. Browser fixtures bind loopback ports 3210 and 3211 and refuse
to reuse an existing app server. Run only one full gate in a checkout at a time.

The gate clears inherited credentials and shadows environment-file keys before
starting tests or Next. No live-provider keys are required. Logs go to
`.test-results/remote`; Playwright retains failure traces/screenshots in
`test-results`. CI uploads these artifacts only on failure for seven days.

## Coverage and source-assertion replacements

- `pipeline-happy-path.postgres.test.ts` starts with no ready transcript and drives
  production claim/dispatch through finalization without reconciliation repairs.
  FFprobe and decoded pixels check audio/silent output, duration, captions, square
  source crop, preferred facecam split, fallback, corrupt input, and cleanup.
- `source-asset-upload.postgres.test.ts` checks real persistence, concurrent and
  repeated completion, verified HEAD recovery after a lost completion response,
  invalid metadata/parts, deletion contention, and one durable thumbnail job.
- `media-delivery-routes.test.ts` executes the handlers used by production routes,
  covering ownership, current artifact authority, unavailable media, byte ranges,
  redirects, attachment headers, and storage failures.
- `clip-review.spec.ts` checks actual upload navigation, generation refresh,
  current-only clip presentation, playback/seek/download, and recovery submission.
  Browser state fixtures supply completed/failed media outcomes; the pipeline
  integration suite separately proves those outcomes arise from production jobs.
  The portable Chromium fixture uses VP9/Opus MP4 because bundled macOS Chromium
  lacks H.264/AAC playback. The pipeline suite verifies production H.264/AAC
  media; deployed codec/device compatibility remains an occasional smoke check.
- Python media tests now decode a loopback video with actual OpenCV/MediaPipe and
  check temporary-file cleanup after download/decode failure.

Keep the transactional lease, authorization, recovery, deletion, reconciliation,
and checkpoint suites. They cover distinct races, rather than redundant test
counts. Legacy multi-layout behavior remains explicitly legacy; snapshot tests
require one current artifact. Source-pattern checks with unique obligations stay
until a corresponding behavioral assertion replaces them.

| Source-pattern obligation | Behavioral replacement / decision |
| --- | --- |
| Render acquire and final-publication locks in `rendered-clip-idempotency.test.ts` | Removed duplicate regex tests; production reclaim/stale-success/stale-failure cases in `recovery-correctness.postgres.test.ts` and superseded-pointer publication in `snapshot-pipeline-lifecycle.postgres.test.ts` prove the transitions. Keep executable storage-key assertions and explicitly legacy index guard. |
| Dashboard new-upload redirect | Browser upload case replaces that assertion; retain resumed-upload source guard until a browser resume case exists. |
| `orchestration-regression.test.ts` generation scoping/order/status projection | Existing PostgreSQL suites overlap but do not replace every endpoint/ordering assertion; retain unique source guards. |
| `video-facecam-refactor.test.ts` and `pipeline-reconciliation-integration.test.ts` | Retain structural dependency/no-page-draining guards; real pipeline test adds execution evidence without claiming every structural obligation is redundant. |
| Upload pause/resume/discard source checks | Retain until dedicated browser pause/resume/discard tests exist; preserve executable completion-contention client tests. |

## Occasional manual smoke tests

| Change | Check |
| --- | --- |
| R2 credentials, bucket/CORS, signing, or deployment | Small non-sensitive multipart upload, real playback/seek/download, cleanup |
| FFmpeg, fonts, detector thresholds/model, captions, or crop | Watch representative gaming clips with and without facecam; inspect readability, sync, framing, false positives |
| Major UI, proxy, hosting, or media-runtime change | One deployed creator journey on desktop and a mobile browser |

Automation establishes structural correctness and recoverability. Human viewing
still evaluates clip quality, and deployed smoke tests validate real R2/browser
configuration. Routine changes do not need to repeat manually the recovery and
authority scenarios covered by the gate.
