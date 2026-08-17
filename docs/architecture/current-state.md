# Disburse Current Engineering State

This document records the current development checkpoint and immediate engineering priorities.

Unlike `AGENTS.md` and `pipeline-invariants.md`, this file is expected to change as phases complete.

---

# Active Development Workspace

Writable development repository:

```text
/Users/billhuynh/Disburse-dev
```

Protected preservation workspace:

```text
/Users/billhuynh/Disburse
```

Normal engineering work must happen only in `Disburse-dev`.

---

# Current Product Priority

The immediate goal is to make the existing short-form generation pipeline stable and reliable before adding more gaming intelligence or editor functionality.

Near-term product proof:

```text
upload
→ generate
→ expected number of clips
→ correct current output per candidate
→ playable media
→ successful download/publish path
```

---

# Completed Architecture Checkpoints

## Generation Snapshot Foundation

Commit:

```text
39d8ade7bc4e88c6e449900b49cbb6d6b33da178
```

Established the generation snapshot foundation, including generation-run authority and current-render-config support.

## Snapshot-Backed Single-Output Engine

Commit:

```text
8cb640e170361c8b66f8a1ced7cbd7e977105112
```

Established the backend single-output authority model, including:

* persisted generation-mode authority
* immutable snapshot-backed effective render configuration
* terminal facecam authority
* exact render failure identity
* stale-work fencing
* bounded recovery
* pointer-based finalization
* publication authority
* legacy compatibility boundaries

## Singular Project Clip Projection

Commit:

```text
c08c8151808b057b21bc53f01fbed5e26a659393
```

Established snapshot UI projection through:

```text
candidate.currentRenderConfigId
→ exact render config
→ exact rendered clip
```

Snapshot UI no longer treats default and facecam artifacts as sibling deliverables.

Legacy sibling-selection compatibility remains explicitly isolated to legacy behavior.

---

# Current Runtime State

The local `disburse_dev` PostgreSQL database has been migrated to the current committed schema.

The previous local dashboard failure caused by missing publishing migrations has been resolved at the schema level.

The next required product check is a manual smoke test of current user-visible behavior, especially:

* dashboard/project loading
* generated clip visibility
* playback
* seeking
* download
* media request behavior

Do not assume historical object-storage playback issues still exist until reproduced against the current application.

---

# Immediate Decision Point

After the manual smoke test:

## If media playback/download is healthy

Do not start an unnecessary object-storage rewrite.

Proceed toward snapshot-backed Generate activation.

## If media playback/download still fails

Investigate the observed current failure first.

Capture evidence such as:

* request host
* HTTP status
* timeout vs immediate error
* ranged request behavior
* whether playback starts
* whether seeking works
* whether download succeeds

Do not redesign storage architecture based only on old failures.

---

# Next Planned Architecture Phase

## Phase D — Snapshot Generate Activation

Goal:

Activate snapshot-backed Generate through one atomic lifecycle.

Conceptually:

```text
validate setup
→ materialize immutable snapshot
→ create generation run
→ establish pack/run authority
→ cancel/supersede prior applicable jobs
→ create initial jobs
→ commit
→ trigger processing
```

Required invariant:

> A snapshot-backed job must never exist without its corresponding immutable generation snapshot and generation authority.

Additional direction:

* enqueue helpers must not mint generation IDs implicitly
* recovery must preserve/clone snapshot authority rather than reread mutable templates
* missing historical snapshot authority must not be fabricated
* legacy and snapshot activation must remain explicit

Do not begin Phase D until the current smoke-test result has been evaluated.

---

# Deferred Product Work

Do not prioritize these yet:

* killstreak detection
* hype-moment detection
* broader gaming-event intelligence
* VTuber/avatar creator-region detection
* generalized multimodal scoring framework
* multi-aspect-ratio generation
* full in-app clip editor

These are product directions, not current blockers.

---

# Future Product Direction

After the generation pipeline is reliably hardened:

1. improve candidate selection using gaming-specific signals
2. broaden creator-region detection where needed
3. add a real in-app editor for creator polishing and overrides
4. expand publishing and distribution workflows

The editor should improve already-good automatic output rather than compensate for unreliable generation.

---

# Development Workflow

For each meaningful phase:

```text
architect / product owner
→ persistent implementation agent
→ focused implementation + tests
→ human smoke test where useful
→ fresh independent reviewer
→ findings back to original implementer
→ checkpoint commit
```

Do not create a new implementation agent for each correction.

Keep the phase implementer persistent unless the task materially changes or its context becomes unusable.

---

# Current Documentation Work

`AGENTS.md` has been rewritten to reflect:

* gaming-first product direction
* one-candidate/one-output authority
* snapshot semantics
* worker/job architecture
* workspace and DB safety
* persistent implementer + fresh reviewer workflow

This architecture documentation pass should be completed before starting the next major implementation phase.
