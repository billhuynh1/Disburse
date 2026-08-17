# AGENTS.md — Disburse Engineering Guide

This file provides durable product, architecture, safety, and development guidance for AI coding agents working in the Disburse repository.

Read this file before making changes.

Do not treat it as a chronological project history. It contains the stable rules and product assumptions that should guide implementation decisions.

---

# Product

## What Disburse Is

Disburse is an AI video repurposing SaaS focused on **gaming content creators**.

The core product takes long-form gaming content and turns it into a small set of polished short-form clips suitable for platforms such as:

* TikTok
* YouTube Shorts
* Instagram Reels

The primary user workflow is:

1. Upload or import long-form gaming content.
2. Select one reusable brand template and generation-specific settings.
3. Create an immutable snapshot of those settings for the generation.
4. Transcribe and analyze the source.
5. Rank and select strong candidate moments.
6. Resolve facecam / creator-region state for each candidate.
7. Derive one effective render configuration for each candidate.
8. Render one authoritative final short-form clip per candidate.
9. Let the creator review, play, download, publish, and eventually further edit those clips.

Disburse is workflow software, not a generic chatbot.

---

# Product Direction

## Primary Audience

The current product focus is:

* gaming creators
* streamers
* gaming-focused YouTube creators
* creators repurposing streams, gameplay videos, and long-form gaming content

Avoid designing the product primarily around generic B2B creators, podcasts, LinkedIn content, X threads, newsletters, or other unrelated repurposing workflows unless explicitly requested.

Those may be possible future markets, but they are not the current product focus.

---

## Current Product Priority

The current priority is:

> **Build a stable, hardened, recoverable automatic clip-generation pipeline.**

Reliability comes before feature breadth.

Do not prioritize speculative future capabilities ahead of pipeline stability.

In particular, do not overbuild:

* multi-aspect-ratio generation
* multiple simultaneous output variants per candidate
* generalized multimodal event-scoring frameworks
* advanced gaming-event detection
* VTuber-specific detection
* full editor functionality

until the core generation pipeline is reliable.

The automatic pipeline should first produce a strong default result consistently.

The future editor should exist to **polish and override a good automatic result**, not rescue a broken pipeline.

---

# Future Product Direction

Future versions of Disburse may become increasingly gaming-aware.

Potential gaming-specific signals include:

* killstreaks
* clutch moments
* hype moments
* creator reactions
* sudden audio excitement
* gameplay-specific visual events
* scoreboard or victory-state changes

Facecam / creator-region detection may also expand beyond traditional webcams to include creator representations such as VTuber-style avatars.

These are future directions.

Do not assume these capabilities already exist.

Do not introduce generalized abstractions for them before there is a concrete implementation need.

---

# Core Product Invariant

For snapshot-backed clip generation:

```text
one candidate/run
→ one terminal facecam outcome
→ one current effective render config
→ one authoritative rendered artifact
```

This is a core Disburse invariant.

A candidate produces **one current final clip**.

Facecam is a characteristic of how that clip is rendered. It is **not a separate sibling output**.

For example:

```text
usable facecam
→ preferred facecam layout
→ one final clip
```

or:

```text
no usable facecam / detector failure / detection disabled
→ fallback layout
→ one final clip
```

Do not implicitly generate both:

```text
default output
+
facecam output
```

for one candidate.

Historical render configs and artifacts may remain for:

* retries
* supersession
* auditability
* future editing history

but they are not simultaneous current deliverables.

---

# Brand Templates and Generation Settings

Users may create reusable brand templates.

A template may define things such as:

* output aspect ratio
* preferred facecam layout
* fallback layout
* facecam split
* caption style
* caption size
* caption placement
* crop behavior
* logo / branding
* intro / outro assets
* CTA behavior
* auto-edit preferences

Generation setup may also contain run-specific settings such as:

* desired number of clips
* clip duration range
* generation instructions
* content-selection preferences

For the current MVP, a selected template defines **one output aspect ratio** for the generation.

Multi-format / multi-aspect-ratio deliverables are deferred.

---

# Generation Snapshot Authority

Snapshot-backed generations use immutable generation settings.

Once a generation snapshot exists, mutable configuration must not silently change that generation.

In particular:

* do not reread live brand-template values as render authority for an existing snapshot generation
* do not let mutable edit intent change the initial immutable render configuration
* do not fabricate historical snapshots
* do not infer snapshot settings from current mutable UI state

Conceptually:

```text
brand template + generation setup
→ immutable generation snapshot
→ runtime authority
```

Brand templates represent reusable user intent.

Generation snapshots represent immutable runtime authority.

---

# Legacy vs Snapshot Mode

Persisted generation mode is authoritative.

The system currently has both legacy and snapshot-backed behavior.

Rules:

* true legacy remains legacy
* snapshot remains snapshot
* do not implicitly upgrade legacy to snapshot
* do not silently downgrade snapshot to legacy
* do not infer mode from the presence of a generation row
* do not infer mode from a render-config ID
* do not infer mode from a job payload
* missing or corrupt snapshot authority must fail closed
* snapshot code must not silently fall back into legacy behavior

When snapshot regeneration or snapshot Generate activation has not yet been implemented for a workflow, reject explicitly rather than routing through legacy behavior.

---

# Current Render Authority

For snapshot-backed candidates:

```text
clip_candidates.current_render_config_id
```

is the current render authority.

The current artifact must be resolved through:

```text
candidate.currentRenderConfigId
→ clip_render_configs.id
→ rendered_clips.clip_render_config_id
```

Do not select the current snapshot artifact using:

* candidate + layout
* candidate + variant
* most recent artifact
* mutable edit-config hash
* expected sibling sets

Use exact identities whenever available.

---

# Stale Work Invariant

A stale worker may waste compute.

A stale worker must **not** publish authoritative state after losing authority.

Durable rule:

> Stale work may waste compute, but it must never overwrite or publish the current authoritative artifact after losing authority.

Start, failure, and final publication paths must use exact render/generation identity.

Avoid ambiguous identity when exact identifiers exist.

---

# Recovery Philosophy

Disburse should follow this principle:

> **Make common failures recoverable, make ambiguous failures visible, and make manual recovery easy.**

Background work must be:

* durable
* idempotent where appropriate
* safely retryable
* explicitly terminal when recovery is exhausted

Do not leave authoritative work in a state equivalent to:

```text
artifact incomplete
+ no runnable work
+ no terminal accounting
```

while the project remains permanently generating.

Reconciliation is a **safety net**, not the happy path.

Normal pipeline execution should not depend on repeated reconciliation to make progress.

---

# Ordering and Concurrency

Use this principle:

> **Dependencies determine ordering; independence determines concurrency.**

Do not run dependent work out of order.

Do not serialize independent candidate work merely because the current implementation is simple.

At the same time, do not introduce complex concurrency infrastructure until the pipeline is correct and stable.

---

# Architecture

## Current Stack

### Frontend

* Next.js App Router
* React
* React Server Components
* TypeScript
* Tailwind CSS
* ShadCN UI

### Backend

* Next.js route handlers and server actions
* Postgres
* Drizzle ORM
* service-layer business logic

### Background Processing

* dedicated Disburse worker
* Postgres-backed durable jobs

### Media Processing

* FastAPI / Python media service
* FFmpeg / FFprobe
* media-specific processing such as facecam detection

### Storage

* object storage for uploaded and rendered media

Do not assume request/response handlers are responsible for long-running media processing.

---

# Architectural Boundaries

Prefer this layering:

```text
UI
→ route handlers / server actions
→ services
→ data access
→ integrations / jobs
```

## UI Layer

Responsible for:

* rendering
* forms
* local interaction
* presenting workflow state

Do not place pipeline business logic in React components.

## Route Handlers / Server Actions

Responsible for:

* authentication
* input validation
* authorization
* calling services
* returning responses

Keep them thin.

Do not put core workflow logic directly into route handlers.

## Service Layer

Responsible for:

* business rules
* workflow transitions
* orchestration
* authorization-sensitive domain behavior

## Data Access

Responsible for:

* typed database queries
* persistence
* transactional data operations

## Integrations

Responsible for:

* AI providers
* media/transcription providers
* publishing providers
* object storage

Keep provider-specific behavior isolated.

## Jobs

Responsible for:

* durable asynchronous execution
* retries
* leases
* checkpoints
* failure state
* recovery

---

# Infrastructure Restraint

Do not introduce additional distributed infrastructure without a demonstrated need.

Do not add technologies such as:

* Kafka
* Temporal
* Kubernetes
* additional queues
* additional microservices

simply because they could theoretically improve scale.

The current architecture intentionally favors:

* Postgres
* durable DB-backed jobs
* one dedicated worker architecture
* simple service boundaries

Prefer the smallest architecture that meets current product needs.

Do not broadly rewrite the existing SaaS starter architecture.

---

# Heavy Processing

Heavy work must not live in:

* client components
* `useEffect`
* long-running server actions
* long-running user request handlers

Examples include:

* transcription
* video probing
* media processing
* facecam detection
* highlight analysis
* rendering
* publishing preparation

Use background jobs and the worker.

---

# Frontend Guidance

## React

Prefer React Server Components for server-side data fetching.

Use client components for:

* forms
* editor interactions
* local interaction state
* interactive workflow controls

Avoid `useEffect` when:

* data can be fetched on the server
* state can be derived
* logic belongs in an event handler
* logic belongs in a server action or job

Do not synchronize props into local state without a concrete reason.

---

## Components

Prefer:

* small cohesive components
* clear ownership
* composition
* existing local primitives
* existing ShadCN components

Avoid speculative reusable abstractions.

Extract shared components when real repetition exists.

---

## State

Prefer:

1. local state
2. server state / server boundaries
3. React Context only for genuinely shared distant state

Do not introduce external state-management libraries without a demonstrated need.

---

## UI

Use:

* ShadCN primitives
* Tailwind utilities
* existing global theme values

Do not broadly restyle base ShadCN primitives unless explicitly requested.

Prioritize clarity around:

* processing
* success
* failure
* retry state
* current authoritative output
* editable intent vs rendered result

---

# Validation and Authorization

Validate all external or user-controlled input.

Never blindly trust:

* client input
* query parameters
* external APIs
* AI outputs
* media metadata
* transcription responses
* webhook payloads

Every read and mutation must enforce appropriate user/project access.

Frontend restrictions are not security boundaries.

---

# Error Handling

Think in production failure modes.

Handle explicitly:

* missing records
* malformed inputs
* unsupported media
* duplicate requests
* missing environment variables
* external provider failures
* timeouts
* partial failures
* stale jobs
* retry exhaustion
* ambiguous external effects

Do not silently convert invalid state into a different workflow mode.

Prefer explicit invariant errors over guessing.

---

# Database

## Principles

Prefer:

* clear schemas
* typed queries
* explicit relationships
* intentional indexes
* understandable status fields

Avoid vague JSON blobs for core workflow authority when explicit schema is justified.

JSON snapshots are appropriate for immutable generation configuration where versioned parsing is enforced.

---

## Important Domain Entities

Current core entities include concepts such as:

* `projects`
* `source_assets`
* `transcripts`
* `content_packs`
* `generation_runs`
* `clip_candidates`
* `clip_edit_configs`
* `clip_render_configs`
* `rendered_clips`
* brand templates
* facecam detection state
* durable jobs

Do not collapse these into one overloaded entity.

Understand the distinction between:

* mutable editing intent
* immutable generation/render authority
* historical artifacts
* current authoritative artifact

before modifying schema or query behavior.

---

# Schema and Migration Safety

Do not:

* casually drop tables
* recreate tables unnecessarily
* destroy local or production data
* use `drizzle-kit push` against production

Use migrations.

Review migration SQL before applying it.

Keep migrations deterministic and auditable.

Prefer additive migrations when feasible.

---

# Workspace Safety

This repository has two important local workspaces.

## Protected Preservation Workspace

```text
/Users/billhuynh/Disburse
```

This workspace is preserved historical/recovery state.

Do **not**:

* modify it
* reset it
* clean it
* stash it
* switch branches in it
* apply patches to it

unless the user explicitly requests a recovery operation involving that workspace.

## Writable Development Workspace

Normal development happens in:

```text
/Users/billhuynh/Disburse-dev
```

Before making changes, verify:

```bash
pwd
git rev-parse --show-toplevel
git status --short
```

Do not assume similarly named directories are interchangeable.

---

# Database Safety

Local application development uses the development database:

```text
disburse_dev
```

Interactive local product testing may intentionally use this database.

PostgreSQL tests that mutate schema or workflow state should use disposable isolated databases.

Do not run destructive integration tests against:

* `disburse_dev`
* production
* staging
* unknown databases

Use repository test-database guards.

Approved disposable test databases should follow the established prefix convention, such as:

```text
disburse_phase1a_test*
```

Database safety checks should fail closed.

Do not disable database safety guards merely to make tests run.

---

# Background Job Rules

Every durable job should have a clear:

* trigger
* payload
* authority identity
* idempotency strategy
* retry policy
* terminal failure behavior

Do not assume exactly-once execution.

Retries must be safe.

Completed work should not be replayed in a way that changes its semantic outcome.

A completed detector job, for example, is not automatically equivalent to a successful facecam detection.

---

# AI and Media Analysis

AI is not the source of truth.

Validate structured AI output before persistence or workflow transitions.

Ground generated content in the source.

Do not fabricate:

* quotes
* creator statements
* gameplay events
* statistics
* dates
* source facts

Prefer structured intermediate outputs when they improve control or traceability.

Do not collapse a multi-stage workflow into one opaque AI call solely for convenience.

---

# Facecam and Creator Region

Facecam handling is a core product concern for gaming creators.

Current implementations may detect traditional human facecam regions.

Future implementations may expand toward broader creator-region detection, including VTuber/avatar-style creator representations.

Do not claim support for VTuber detection until it exists.

Persisted detector state is authoritative.

Do not let caller-provided status silently override persisted detector outcomes.

---

# Editor Direction

A more capable in-app editor is a future product priority.

The editor should eventually allow creators to polish clips through controls such as:

* trim boundaries
* crop
* facecam placement
* captions
* branding
* layout
* other presentation adjustments

Do not build the full editor prematurely.

Current pipeline correctness and automatic clip quality come first.

---

# Testing

Use the repository's existing test infrastructure and scripts.

Do not introduce a second testing framework merely because an older document mentions one.

Prefer:

* unit tests for deterministic pure logic
* production-path PostgreSQL tests for transactional workflow behavior
* focused integration tests for authority and state transitions

Source-pattern or regex-based tests are not substitutes for real lifecycle tests when transaction/state behavior matters.

Tests must not hit live external providers.

Mock external boundaries where appropriate while keeping important database authority transitions real.

---

# Testing Philosophy

Do not write tests only to increase a count.

Test invariants and failure modes.

High-value areas include:

* authorization
* generation-mode isolation
* snapshot immutability
* exact artifact identity
* stale worker fencing
* facecam terminal behavior
* recovery
* finalization
* publication authority
* legacy compatibility
* job idempotency
* retry exhaustion

A test is valuable when it can detect a realistic product or state-machine regression.

---

# Verification Gates

Run focused tests relevant to the task.

Before declaring implementation complete, run the repository-native verification appropriate to the change.

Common gates include:

```bash
npm test
git diff --check
npx tsc --noEmit --incremental false --pretty false
npm run build
npm run ops:preflight
```

For UI changes, always run:

```bash
npm run build
```

Existing unrelated TypeScript baseline diagnostics do not need to be fixed unless the task touches them.

Changed files must not introduce new TypeScript diagnostics.

If PostgreSQL authority behavior changes, use an isolated disposable test database and run the relevant production-path PostgreSQL tests.

---

# Performance and Reliability

Prioritize correctness before optimization.

Still avoid obvious problems such as:

* N+1 queries
* unnecessary historical artifact loading
* unbounded retries
* duplicate jobs
* blocking heavy work in requests
* unnecessary polling
* hidden failure states

Prefer incremental optimization after measurement.

Do not introduce architectural complexity based solely on hypothetical future scale.

---

# Coding Standards

Prefer:

* explicit code
* readable control flow
* focused functions
* cohesive modules
* clear names
* named constants instead of unexplained magic values

Use DRY as a guideline, not a mandate.

Do not create abstractions solely to remove a few repeated lines when the abstraction makes workflow authority harder to understand.

Prefer stable abstractions over speculative abstractions.

---

# Comments

Do not add comments that merely restate the code.

Use comments for:

* non-obvious authority rules
* complex workflow behavior
* retry/recovery reasoning
* security-sensitive logic
* external-effect ambiguity
* unusual integration constraints

Prefer self-explanatory code whenever possible.

---

# Agent Development Workflow

Disburse uses a **persistent implementer + fresh reviewer** workflow.

## Implementation

Use one persistent implementation agent/thread for a meaningful phase or coherent workstream.

The same implementation agent should normally:

1. inspect the repository
2. understand the requested invariant
3. implement
4. run focused tests
5. receive review findings
6. correct its own implementation
7. rerun verification

Do not default to a brand-new implementation agent for every correction.

Continuity is valuable during implementation.

---

## Independent Review

Use a fresh agent for independent review at meaningful checkpoints.

Fresh context is useful for challenging assumptions.

A reviewer should:

* inspect the actual code
* construct counterexamples
* verify production paths
* challenge authority/state-machine assumptions
* distinguish baseline failures from regressions

Review findings should normally return to the original persistent implementation agent.

Fresh agents are for **independence**, not routine continuity.

---

## Preferred Flow

```text
architect / product owner
→ persistent phase implementer
→ human smoke test where useful
→ fresh independent reviewer
→ findings back to original implementer
→ final review
→ checkpoint commit
```

Do not create chains of new implementers unless:

* the existing context is corrupted
* the task materially changes
* independent implementation is explicitly desired

---

# Agent Task Behavior

When implementing a feature:

1. inspect the relevant current code first
2. identify any conflict with existing product/system invariants
3. state the smallest coherent implementation approach
4. implement only the required scope
5. test the real production path where appropriate
6. report evidence and remaining uncertainty

Do not blindly follow a checklist when repository evidence contradicts it.

Do not optimize for making a test green if the test itself encodes the wrong invariant.

If a test fails:

1. determine whether production code is wrong
2. determine whether the fixture/test is wrong
3. fix the correct layer
4. rerun the relevant proof

---

# Product and Engineering Decision Rule

When choosing between competing implementations, prefer the option that:

1. preserves the product invariant
2. improves reliability
3. keeps operational complexity low
4. makes failures visible and recoverable
5. delivers user value sooner
6. leaves room for future gaming intelligence without building it prematurely

Do not overengineer for hypothetical future requirements.

The current goal is to make the core Disburse pipeline **boringly reliable**.
