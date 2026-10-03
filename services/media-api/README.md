# Disburse Media API

FastAPI service for internal media analysis tasks that are better suited to
Python tooling. The Next.js app remains the product backend and calls this
service with short-lived media URLs.

## Local Setup

```bash
cd services/media-api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Start the service from the repo root:

```bash
pnpm media-api:dev
```

The service auto-loads the repo-root `.env`. For the Next.js app to call this
service locally, add matching values there and restart `npm run dev`:

```bash
MEDIA_API_BASE_URL=http://localhost:8001
MEDIA_API_SECRET=dev-media-secret
```

Health check:

```bash
curl http://localhost:8001/health
```

Internal endpoints require:

```text
Authorization: Bearer $MEDIA_API_SECRET
```

## Facecam Detection

`POST /internal/facecam-detections` accepts a presigned source download URL and
clip timing. It samples frames from the clip, detects faces with MediaPipe, and
returns ranked pixel-coordinate crop candidates for future layout editing.

New generation snapshots explicitly request `detectorVersion: "facecam_v2"`.
Omitted versions use `facecam_v1` for compatibility; other versions are rejected.
V2 keeps the existing face-confidence thresholds and requires 25% persistence
across unique successfully sampled timestamps. Overlapping region detections at
the same timestamp are deduplicated. Inferred containers above 25% of frame area
or 60% of frame height are rejected, including inferred fallback crops. No
accepted clusters returns an empty candidate list, allowing the generation's
fallback layout. Debug summaries include per-cluster metrics and rejection reasons.

Run tests from the repository root:

```bash
PYTHONPATH=services/media-api services/media-api/.venv/bin/python -m pytest services/media-api/tests
```
