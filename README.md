# Disburse

Disburse is a full-stack Next.js app for turning one long-form source into a
reviewable short-form clip workflow.

## MVP scope

The current launch scope is intentionally narrow:

- create a project
- add a source via upload or YouTube URL
- generate a transcript
- generate short-form clip candidates
- approve and render clips
- publish rendered clips to connected YouTube accounts
- manage reusable fonts, images, videos, and audio files

TikTok account linking is available. TikTok publishing is capability-gated and
stays hidden unless explicitly enabled and proven in the environment.

## Stack

- Next.js App Router
- TypeScript
- Postgres + Drizzle ORM
- Tailwind + local UI primitives
- OpenAI for transcription and clip ranking
- S3-compatible object storage for uploads and rendered media
- FFmpeg for clip rendering

## Required services

For the core demo flow, you need:

- Postgres
- S3-compatible storage
- OpenAI API key
- FFmpeg and FFprobe on your machine
- Google OAuth credentials for YouTube account linking and publishing

Optional:

- TikTok OAuth credentials
- Media API service for facecam detection
- Stripe for pricing and billing flows

## Environment

Copy `.env.example` to `.env` and fill in the values you need for your local
environment.

Important launch-time variables:

- `POSTGRES_URL`
- `BASE_URL`
- `AUTH_SECRET`
- `INTERNAL_PROCESSING_SECRET`
- `S3_UPLOAD_ACCESS_KEY_ID`
- `S3_UPLOAD_SECRET_ACCESS_KEY`
- `S3_UPLOAD_BUCKET`
- `S3_UPLOAD_REGION`
- `OPENAI_API_KEY`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `FFMPEG_PATH`
- `FFPROBE_PATH`

## Local setup

```bash
pnpm install
cp .env.example .env
```

Run the database migrations:

```bash
pnpm db:migrate
```

Seed a default user if you want a quick local login:

```bash
pnpm db:seed
```

Default seeded credentials:

- email: `test@test.com`
- password: `admin123`

Start the app:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Optional local services

### Facecam detection service

```bash
cd services/media-api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
```

Make sure your root `.env` includes:

```bash
MEDIA_API_BASE_URL=http://localhost:8001
MEDIA_API_SECRET=dev-media-secret
```

### Stripe webhook listener

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

## Core demo flow

1. Sign in.
2. Create a project.
3. Upload a video file or add a YouTube URL.
4. Wait for transcript processing.
5. Open setup and generate clip candidates.
6. Approve a candidate and render a clip.
7. Connect a YouTube account from Social Accounts.
8. Publish the rendered clip from the project review screen.

## Testing

Build verification:

```bash
npm run build
```

Unit tests:

```bash
npm test
```

## Deployment notes

This app deploys cleanly when the following are configured in the target
environment:

- Postgres
- S3-compatible storage
- OpenAI key
- Google OAuth credentials
- internal job secret
- FFmpeg available to the runtime that handles rendering jobs

If you want direct publishing, deploy only after verifying OAuth redirect URIs,
storage access, and background job processing in the target environment.
