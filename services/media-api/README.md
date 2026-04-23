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
uvicorn app.main:app --reload --port 8001
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
