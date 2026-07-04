# AGENTS.md — Disburse Codebase Guide

This file provides context and instructions for AI coding agents working on the Disburse codebase.

## What This App Does

Disburse is a gaming creator-focused SaaS app that helps users turn one long-form content like youtube videos into shortform clips like TikTok and Youtube Shorts.

The product should help creators take a single source asset, such as:

- a podcast episode
- a YouTube video
- a webinar
- a Loom recording
- an audio upload
- a transcript
- a YouTube URL

and transform it into reusable multi-channel content outputs such as:

- shortform clips (TikTok, Youtube Shorts, Instagram Reels)
- LinkedIn post drafts
- X thread drafts
- hooks/titles
- CTA variants
- summaries/show notes
- reusable generated content assets

The app is workflow software, not a generic chatbot.

The goal is to help creators distribute more consistently by turning one recording into multiple publishable assets.

---

## MVP Scope

The MVP is intentionally narrow.

### Target users

Start with creators who already produce long-form content, such as:

- gamers
- video creators
- streamers
- B2B creators
- agencies repurposing founder/client content

### Initial source asset types

The MVP should support these input paths first:

- uploaded audio/video file
- pasted transcript
- YouTube URL

---

## Product Principles

When making implementation decisions, optimize for:

**Production-ready code**
**Low operational complexity**
**Clear workflows over clever abstractions**

---

## Tech Stack

### Frontend

- Next.js (App Router)
- React Server Components
- TypeScript
- Tailwind CSS
- ShadCN UI

### Backend

- Next.js Route Handlers
- Postgres
- Drizzle ORM

### Background processing

- Prefer a DB-backed jobs table or equivalent background-safe workflow
- Heavy media / AI processing should be designed to run outside normal request-response paths
- FastAPI (Python)

### Testing

- Vitest

---

## Architecture Rules

### General

- Do **not** split into microservices.
- Do **not** introduce a separate worker service unless explicitly requested or suggest it if needed.
- Prefer a **service-layer architecture** over fat route handlers.
- Reuse the existing SaaS starter architecture and patterns whenever possible.
- Do not rewrite the starter broadly unless explicitly requested.

### Preferred layering

Use this separation consistently:

- **UI layer**: rendering, forms, local interaction only
- **Route handlers / server actions**: authentication, input parsing, authorization, orchestration
- **Service layer**: business logic
- **Data access layer**: database queries and persistence helpers
- **Integrations layer**: AI provider, media/transcription provider, export/publishing provider
- **Jobs layer**: background task orchestration

### Route handler rule

Route handlers should be thin. They should:

- authenticate the request
- validate input
- call a service
- return a response

They should **not** contain core business logic.

### Background-processing rule

Heavy processing should **not** live in:

- client components
- `useEffect` chains
- long-running request handlers
- server actions that block the user for too long

Design the app so future workflows like these can run safely in background jobs:

- transcription
- source parsing
- content segmentation
- content-pack generation
- clip suggestion extraction
- export preparation

---

## React / Frontend Best Practices

### Default approach

- Prefer **React Server Components** for data fetching.
- Use client components only for:
  - interactive forms
  - local UI state
  - editor-like interactions
  - copy/export actions
  - tabs, accordions, and workflow interactions that require client behavior

### Avoid `useEffect`

Avoid `useEffect` unless absolutely necessary.

Prefer:

- server-side data fetching
- derived state
- controlled inputs
- event handlers
- memoized computations only when there is measurable benefit
- using primitive components from shadcn for consistent styling

Do not use `useEffect` for:

- syncing props into state unnecessarily
- fetching data that can be fetched on the server
- running workflow logic that belongs in actions/services/jobs

### Composition

- Build components to be **small, composable, and single-responsibility**
- Prefer composition over monolithic components
- Extract reusable UI patterns when there is actual repetition
- Avoid deeply nested component trees with unclear ownership

### State management

- Prefer local state first
- Use React Context only for truly shared UI/application state
- Do **not** introduce external state libraries unless explicitly requested
- Do **not** use context as a dumping ground for state that should live closer to usage

### Prop drilling

Avoid excessive prop drilling.

Preferred solutions:

1. move logic closer to where state is used
2. extract cohesive child components
3. use server boundaries to reduce prop passing
4. use context only when state is genuinely shared across distant branches

Do not introduce context prematurely.

### Forms

- Use clear validation boundaries
- Keep form state predictable
- Surface validation errors explicitly
- Handle loading, success, and error states cleanly

### UI

- Use ShadCN as the base UI system.
- Reuse existing ShadCN components and local component primitives before creating new ones.
- Prefer existing primitives for interactive UI elements. For example, if the repo already has a ShadCN `Button`, use it instead of creating a raw `<button>` element unless there is a clear reason not to.
- Prefer styling through existing component primitives and the shared styles in `global.css`.
- Prefer Tailwind CSS utility classes for styling. Only introduce raw CSS when utility classes are not sufficient or when a shared stylesheet change is clearly the better option.
- Do **not** restyle the base primitive styling of existing ShadCN components unless explicitly requested by the user.
- It is acceptable to compose existing ShadCN components and apply normal layout/spacing classes for the task, but avoid changing their underlying visual design unless explicitly requested.
- If a needed ShadCN component is not currently installed in the repo, the agent may install and use it when it is clearly appropriate for the requested feature.
- When installing a new ShadCN component, follow the existing project conventions and keep the styling consistent with the current app.
- Do **not** reinstall or regenerate components that already exist unless explicitly requested.
- Avoid ad hoc inline styling and avoid raw Tailwind utility colors unless necessary.
- Prioritize clarity of status, progress, and editable outputs.

---

## Backend Best Practices

### Validation

Always validate and sanitize inputs before processing.

Validate at the boundary:

- route handlers
- server actions
- webhook handlers
- internal job endpoints

Never trust:

- client input
- query params
- external API responses
- AI model output
- transcription provider output
- parsed media metadata

### Authorization

Every mutation and read must enforce correct user/project access.

Always verify:

- authenticated user exists
- user owns or has access to the requested resource
- mutations only affect authorized project/workspace data

Do not rely on frontend restrictions for security.

### Error handling

Think production-ready on every task.

Always handle:

- missing records
- invalid uploads
- unsupported source types
- duplicate requests
- malformed external responses
- expired integrations/tokens
- partial failures
- missing environment variables

Fail loudly, not silently.

### Environment variables

- Validate required environment variables at startup or first use
- Do not allow silent fallback behavior for critical secrets
- Use named helpers for env access if useful

### Business logic

Keep business logic in services, not in route handlers or UI code.

Examples of service-layer logic:

- project creation orchestration
- source asset registration
- transcript lifecycle handling
- content segmentation
- content-pack generation orchestration
- voice profile application
- generated asset persistence
- export preparation
- workflow status transitions

---

## Database and Data Modeling

### Database principles

- Model for clarity first
- Keep schemas normalized enough to avoid confusion
- Add indexes intentionally
- Use enums/status fields consistently
- Prefer explicit columns over vague JSON blobs for core workflow fields

### Core product domain

Keep these core entities clearly separated:

- `projects`
- `source_assets`
- `transcripts`
- `content_packs`
- `generated_assets`
- `voice_profiles`

Do not collapse core workflow entities into one overloaded table unless explicitly requested.

### Suggested entity responsibilities

- **projects**: creator-facing container for a repurposing workflow
- **source_assets**: the original uploaded/imported input
- **transcripts**: transcript text and transcript processing state
- **content_packs**: grouped repurposed outputs generated from a project/source
- **generated_assets**: individual outputs like LinkedIn post, X thread, newsletter, hooks, CTA variants
- **voice_profiles**: creator-specific preferences and voice constraints

### Status fields

Use explicit statuses consistently.

Examples:

- source asset: `uploaded`, `processing`, `ready`, `failed`
- transcript: `pending`, `processing`, `ready`, `failed`
- content pack: `pending`, `generating`, `ready`, `failed`
- generated asset: `draft`, `ready`, `edited`, `approved`, `failed`

### Schema safety

- Do not drop or recreate tables unless explicitly instructed
- Do not make destructive schema changes casually
- Preserve data whenever possible

### Migrations

- Never use `drizzle-kit push` against production
- Always generate migrations with `drizzle-kit generate`
- Apply migrations with `drizzle-kit migrate`
- Review generated SQL before applying
- Keep migrations deterministic and readable

### Drizzle

- Keep schema definitions clean and explicit
- Use typed queries
- Avoid scattered raw SQL unless there is a strong reason
- If raw SQL is required, isolate it and make it easy to audit

---

## Background Jobs

This app will likely rely on background processing for:

- transcription
- source parsing
- content segmentation
- content-pack generation
- export preparation
- future clip suggestion extraction

### Job design rules

- Use a **Postgres-backed jobs table** or similar durable mechanism if jobs are implemented
- Design jobs to be **idempotent**
- Retries must be safe
- Store job status and failure reasons
- Do not assume a job runs exactly once
- Avoid hidden coupling between jobs

### Job handling

Every job should define:

- trigger
- input payload
- idempotency strategy
- retry policy
- failure behavior

### Internal processing endpoints

- Internal job-processing endpoints must be protected
- Do not expose processing endpoints publicly
- Avoid building processing systems that depend on client retries or browser presence

---

## Integrations

### AI provider

The AI layer is for:

- source extraction
- content structuring
- segment classification
- repurposed draft generation
- voice-aware rewriting

The AI layer is **not** the source of truth.

Always:

- validate structured outputs
- ground outputs in the source asset/transcript
- reject or flag low-confidence outputs
- avoid opaque one-shot generation where intermediate structure is important

### Transcription / media providers

If using transcription or media tooling:

- do not trust provider output blindly
- validate returned text and metadata
- handle failed or partial transcription cleanly
- store processing state clearly
- isolate provider-specific logic in integrations/services

### Export / publishing integrations

If integrations are added later:

- isolate them behind integration/service boundaries
- store credentials securely
- handle token expiry and reauth clearly
- log failures explicitly

---

## AI / Content Generation Rules

This app is workflow software, not a generic chatbot.

The AI must not:

- invent quotes that do not exist in the source
- invent stories or experiences not present in the source
- attribute claims to the creator without support
- fabricate statistics, dates, or examples unless explicitly provided
- imply the creator said something they did not say

### Preferred AI architecture

Prefer a multi-step flow when implementing AI features:

1. **extraction**
2. **segmentation / classification**
3. **draft generation**
4. **voice/style rewrite**
5. **validation**

Do not collapse everything into one opaque LLM call if it weakens control or traceability.

### Structured outputs

Prefer structured outputs where possible:

- segments
- hooks
- titles
- summaries
- output types
- CTA variants
- confidence flags

### Voice profile behavior

Voice preferences should be treated as constraints, not hard proof of source content.

Voice profiles may guide:

- tone
- structure
- preferred phrasing
- banned phrases
- CTA style
- audience assumptions

But they must **not** override source-grounding.

### Validation and safety

Before treating a generated asset as ready:

- validate shape/format
- confirm it matches the intended channel/type
- flag low-confidence or low-quality outputs
- avoid obviously generic or repetitive AI phrasing where possible

### Editing model

Generated content should support review/edit workflows.

Do not assume generated content is auto-publishable by default.

---

## API Design Principles

- Keep APIs consistent and predictable
- Prefer resource-oriented route structure
- Avoid overly granular endpoints unless needed
- Return typed, structured responses
- Use appropriate HTTP status codes
- Make mutation endpoints idempotent where useful

Do not leak internal-only fields to the frontend unnecessarily.

Prefer APIs/resources that map clearly to the product domain:

- projects
- source assets
- transcripts
- content packs
- generated assets

---

## Testing

### Framework

- Vitest

### Rules

- Tests must not hit live external services
- Mock AI provider calls, transcription/media provider calls, and export integrations
- Each test must be isolated and clean up after itself
- Prefer deterministic tests over snapshot-heavy tests

### Priority areas to test

- auth and authorization boundaries
- project creation and access control
- source asset creation/validation
- transcript/content-pack status transitions
- job retry/idempotency behavior
- AI output validation
- source-grounding constraints
- generated asset persistence
- export-related workflows
- missing environment variable handling
- integration failure handling

### Test philosophy

Do not write trivial tests for the sake of coverage.
Test business-critical paths and failure modes.

### Verification Gates (Required)

- For any UI change, always run `npm run build`.

---

## Performance and Reliability Expectations

- Dashboard pages should remain responsive under normal creator/SMB workloads
- Avoid N+1 queries
- Batch background work when reasonable
- Use pagination where lists can grow meaningfully
- Be careful with over-fetching in project/detail views
- Prefer incremental improvements over premature optimization
- Design workflows so failures are visible and recoverable

---

## Code Quality Standards

### General

- Prefer explicit over implicit
- Avoid magic numbers; use named constants
- Use clear, self-explanatory names
- Keep functions focused
- Keep modules cohesive
- Avoid deeply coupled code
- Always keep in mind of DRY

### Reuse

- Extract shared logic when there is real repetition
- Prefer stable abstractions over speculative ones
- Prefer to use colors and themes from the global.css file
- Only use Tailwind utility colors when necessary
- Prefer the styling from ShadCN components rather than custom styling inline of those components

### Comments

- Do **not** add comments unless they clarify non-obvious logic
- Do **not** restate what the code already clearly expresses
- Prefer self-explanatory variable and function names over comments

Only comment:

- complex workflow logic
- edge-case handling
- security-sensitive code
- non-obvious integration behavior
- non-trivial job orchestration
- source-grounding or AI validation logic that is not obvious from code alone

Bad:

```ts
// Increment counter
count++;
```
