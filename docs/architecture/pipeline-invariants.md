# Disburse Pipeline Invariants

This document defines the durable behavioral invariants for Disburse’s short-form generation pipeline.

These are system rules, not implementation suggestions.

If production code, tests, or an implementation plan conflicts with these invariants, treat that conflict as something to investigate rather than silently changing the invariant.

---

# 1. Product Output Model

Disburse produces a small set of polished short-form clips from one long-form source.

For each selected candidate in a generation:

```text
one candidate/run
→ one terminal facecam outcome
→ one current effective render config
→ one authoritative rendered artifact
```

A candidate has one current deliverable.

Historical render configs and rendered artifacts may exist, but they are not simultaneous current outputs.

---

# 2. Facecam Is Render State, Not an Output Variant

Facecam does not create a second sibling deliverable.

The product model is:

```text
candidate
→ resolve facecam state
→ derive effective render config
→ render one clip
```

Examples:

```text
usable facecam
→ preferred facecam layout
→ one authoritative clip
```

```text
no usable facecam
→ fallback layout
→ one authoritative clip
```

The system must not interpret one candidate as:

```text
default clip
+
facecam clip
```

for snapshot-backed generation.

Legacy historical data may contain sibling-style artifacts. Their existence does not redefine the snapshot product model.

---

# 3. Generation Snapshot Authority

A generation snapshot captures the generation settings that must remain authoritative for that run.

Conceptually:

```text
brand template
+
generation-specific settings
→ immutable generation snapshot
→ runtime authority
```

Once the snapshot exists, mutable state must not silently alter the generation.

Runtime behavior must not reconstruct snapshot intent by rereading:

* the live brand template
* current mutable edit configuration
* current UI state
* later template changes

Snapshot data must be versioned and validated.

Invalid or unsupported snapshot data must fail closed.

Do not fabricate snapshots for historical runs.

---

# 4. Persisted Generation Mode Is Authoritative

Disburse currently supports both legacy and snapshot-backed behavior.

Persisted generation mode determines which contract applies.

Rules:

* legacy remains legacy
* snapshot remains snapshot
* snapshot must not silently fall back to legacy
* legacy must not be implicitly promoted to snapshot
* mode must not be inferred from incidental related records

Do not infer mode from:

* presence of a generation run
* presence of a render-config ID
* job payload shape
* historical artifacts
* UI projection assumptions

If snapshot authority is required but missing or invalid, fail explicitly.

---

# 5. Current Render Authority

For snapshot-backed candidates, current render authority is represented by:

```text
clip_candidates.current_render_config_id
```

The current artifact must be resolved using exact identity:

```text
candidate.currentRenderConfigId
→ clip_render_configs.id
→ rendered_clips.clip_render_config_id
```

Historical artifacts must not substitute for the current pointer.

Do not use ambiguous selectors such as:

* candidate + layout
* candidate + variant
* newest rendered clip
* expected sibling set
* mutable edit-config hash

when exact render-config identity exists.

---

# 6. Effective Render Configuration

The effective render configuration for snapshot generation is derived from:

```text
immutable generation snapshot
+
candidate
+
persisted terminal facecam outcome
```

It must not derive runtime authority from mutable live template state.

The facecam result may change which allowed layout from the snapshot becomes effective, but it does not create multiple current outputs.

---

# 7. Facecam Outcome Must Become Terminal

Each candidate that requires facecam resolution must eventually reach one terminal facecam outcome.

Conceptually this may include outcomes such as:

* usable facecam found
* no usable facecam found
* detection disabled
* terminal detector failure with defined fallback behavior

Do not leave a candidate indefinitely dependent on an ambiguous or transient detector state.

Persisted detector state is authoritative.

Caller-provided assumptions must not override persisted detector outcome.

---

# 8. Stale Work Must Be Fenced

Workers may race.

Retries may overlap.

A stale worker may spend compute after losing authority.

It must not publish current state after losing authority.

Durable invariant:

> Stale work may waste compute, but it must never overwrite authoritative state after losing authority.

Authority checks must apply at meaningful publication boundaries, including where relevant:

* work start
* terminal failure persistence
* render publication
* rendered-artifact finalization
* project/content-pack finalization

Exact generation and render identity should be used whenever possible.

---

# 9. Exact Failure Identity

Failure persistence must identify the exact work that failed.

For snapshot rendering, use identities such as:

```text
generationRunId
+
renderConfigId
```

Do not fall back to ambiguous historical matching such as:

```text
candidate
+
layout
```

when multiple historical configs may share those properties.

A failure from historical render A must never mutate current render B merely because they have the same layout.

---

# 10. Jobs Are Durable Work Records

Background jobs must not assume exactly-once execution.

Jobs should have explicit:

* authority
* payload
* retry behavior
* lease behavior where applicable
* terminal failure behavior
* idempotency semantics

A worker crash, retry, or duplicate delivery must not create duplicate authoritative outcomes.

Completion of a job does not necessarily mean successful product output.

For example:

```text
facecam detector job completed
```

is not equivalent to:

```text
usable facecam found
```

Terminal product meaning must come from persisted outcome state.

---

# 11. Retry Safety

Retries are allowed only when their external-effect semantics are understood.

A retry is safe when the system can establish that replay will not create ambiguous duplicate external effects.

For ambiguous external-effect failures:

* do not blindly replay
* preserve visible failure/recovery state
* require explicit recovery behavior when necessary

Retry behavior must be bounded.

Do not allow infinite automatic retry loops.

---

# 12. Recovery Must Preserve Authority

Recovery should reuse or reconstruct work without changing the semantic identity of the generation.

For snapshot-backed generations:

* recovery must preserve the immutable snapshot
* recovery must preserve generation identity unless a genuinely new generation is intentionally created
* recovery must not reread current mutable template values and pretend they were part of the original run

Recovery should be deterministic enough to reason about after failures.

---

# 13. Reconciliation Is a Safety Net

Reconciliation exists to recover inconsistent or interrupted states.

It is not the normal mechanism by which the pipeline should progress.

Happy-path execution should make forward progress through normal job completion.

If the system only becomes correct after the reconciler runs repeatedly, the primary workflow is incomplete.

---

# 14. No Permanent Orphaned Generating State

The pipeline must not leave current authoritative work in a state equivalent to:

```text
not complete
+
no runnable jobs
+
no recoverable work
+
no terminal accounting
```

while the content pack or generation remains indefinitely generating.

Every authoritative candidate must eventually be accounted for as:

* ready
* still legitimately generating with runnable/recoverable work
* terminally failed

---

# 15. Finalization Uses Current Authority

Pack/project finalization for snapshot-backed generation must reason from current authoritative pointers.

Historical ready artifacts do not make a current generation ready.

Historical failed artifacts do not make a current generation failed.

Current pointer state determines current readiness.

Conceptually:

```text
every current candidate pointer READY
→ pack READY
```

```text
some current candidates still legitimately processing
→ pack GENERATING or PARTIALLY_READY as defined
```

```text
terminally accounted current candidates with unrecoverable failures
→ terminal failure/partial state as defined
```

Exact product status names may evolve, but historical artifacts must not substitute for current authority.

---

# 16. Publication Must Use the Authoritative Artifact

Download, publish, and save operations for snapshot-backed output must target the exact current authoritative artifact.

Do not accept a historical rendered clip merely because it belongs to the same candidate.

Where applicable, validate:

```text
renderedClipId
+
renderConfigId
+
candidate.currentRenderConfigId
```

before allowing publication-like mutations.

Legacy behavior may remain more permissive where compatibility requires it.

Do not weaken snapshot authority in order to preserve legacy shortcuts.

---

# 17. Legacy Compatibility Must Be Explicit

Legacy behavior may continue for historical projects/runs.

Compatibility code must be intentionally scoped to legacy mode.

Do not make snapshot behavior imitate legacy sibling-selection behavior.

Do not remove legitimate legacy behavior accidentally while hardening snapshot behavior.

Mode-specific behavior should be obvious in code and tests.

---

# 18. Generate Activation Must Be Atomic

When snapshot-backed Generate activation is enabled, the activation boundary must be atomic.

Conceptually:

```text
validate setup
→ materialize immutable snapshot
→ create generation run
→ attach current pack/run authority
→ cancel/supersede prior applicable work
→ create initial jobs
→ commit
→ trigger worker processing
```

A snapshot job must never exist without its corresponding generation snapshot and generation authority.

If the transaction fails, partial activation must not escape.

Job creation and authority establishment belong to the same transactional lifecycle.

---

# 19. Job Creation Must Not Invent Generation Identity

Lower-level enqueue functions must not silently mint generation identity when generation authority should already exist.

Generation identity should be established by the generation activation workflow.

Jobs consume that identity.

This preserves:

```text
generation authority
→ jobs
```

rather than:

```text
job
→ invent generation authority
```

---

# 20. Ordering and Concurrency

Use:

> Dependencies determine ordering; independence determines concurrency.

Examples:

A candidate cannot render before the effective render config exists.

An effective render config may depend on terminal facecam outcome.

Independent candidates do not inherently depend on each other.

Do not serialize independent candidate work for conceptual reasons.

Do not introduce additional concurrency infrastructure until correctness and operational need justify it.

---

# 21. External Media Services Are Not Authority

FastAPI, FFmpeg, storage providers, AI providers, and similar integrations perform work.

They do not define current application authority.

Application authority lives in persisted Disburse state.

External responses must be validated before they advance workflow state.

Upload success alone does not imply the artifact may be published as current.

Detector response alone does not override persisted generation authority.

---

# 22. Object Storage and Database State Must Agree

Rendered media publication is a multi-system operation.

The database must not claim an artifact is authoritative and ready when the corresponding object is known not to be usable.

Likewise, the existence of an object in storage does not make it the current authoritative artifact.

Current authority remains database-controlled.

Where ambiguous external effects are possible, recovery must preserve enough identity to inspect and repair the state safely.

---

# 23. UI Projection Must Follow Runtime Authority

Snapshot UI projection must display the current authoritative output.

It must not choose among historical sibling artifacts.

Conceptually:

```text
candidate
→ currentRenderConfigId
→ effective render config
→ rendered clip
```

If the current pointer has no ready artifact yet, the UI should represent the current processing state.

It must not substitute an older ready artifact and present it as the current output.

Legacy UI behavior may retain legacy sibling-selection semantics where explicitly required.

---

# 24. Mutable Edit Intent Is Not Runtime History

The system should distinguish:

* what the user currently wants to edit
* what an immutable generation decided
* what was actually rendered
* what is currently authoritative

Do not collapse these concepts into one mutable configuration record.

This distinction becomes especially important when the future editor is introduced.

The editor may create a new render intent/configuration.

It must not rewrite history for an already completed immutable generation artifact.

---

# 25. Future Editor Compatibility

The current pipeline should remain compatible with a future editor without prematurely building that editor.

A useful conceptual model is:

```text
generation snapshot
→ automatic authoritative render
→ optional future user edit
→ new render config / artifact
```

The future editor should create explicit new state.

It should not mutate an old immutable render configuration in place.

Do not implement editor abstractions until needed, but avoid designs that require rewriting generation history to support editing later.

---

# 26. Gaming Intelligence Must Layer Onto Candidate Selection

Future gaming-specific intelligence may influence candidate ranking and selection.

Possible future signals include:

* transcript semantics
* gameplay events
* killstreaks
* clutch events
* creator reaction
* audio excitement
* visual event changes

These signals should eventually improve:

```text
candidate scoring / selection
```

They should not redefine the one-candidate/one-authoritative-output model.

Do not build a generalized scoring framework until an actual gaming signal is ready to integrate.

---

# 27. Creator-Region Detection May Generalize Facecam Later

Current facecam detection may be human-face oriented.

The product may eventually need a broader concept such as creator-region detection that can recognize:

* traditional webcam regions
* VTuber/avatar representations
* other persistent creator overlays

Do not prematurely rename or generalize the current facecam domain solely for hypothetical flexibility.

Generalize when a concrete second detection mode requires it.

---

# 28. Reliability Beats Breadth

When there is a conflict between:

* adding more generated variants
* adding more detection intelligence
* adding editor surface area
* hardening the core lifecycle

prefer lifecycle reliability until the core pipeline is stable.

A creator should be able to trust:

```text
upload
→ generate
→ receive expected clips
→ play them
→ download/publish them
```

before Disburse adds significant new intelligence or editing complexity.

---

# 29. Tests Must Prove the Invariant

Tests should validate runtime behavior, not merely source shape.

For transactional/state-machine rules, prefer real PostgreSQL lifecycle tests.

High-value adversarial examples include:

* historical render A and current render B share a layout; failure A must not mutate B
* stale worker finishes after authority changes; it must not publish
* historical READY artifact exists while current pointer is pending; current UI remains pending
* snapshot settings differ from the now-edited brand template; runtime uses the snapshot
* detector job ends without usable facecam; candidate still reaches one defined terminal render path
* retry budget exhausts; pack does not remain permanently generating
* legacy and snapshot records coexist; neither leaks semantics into the other

A passing test suite is evidence only when the tests exercise the actual production authority path.

---

# 30. Architecture Decision Principle

When choosing between implementations, prefer the design that:

1. preserves exact authority
2. keeps one current output per candidate
3. makes stale work harmless
4. makes failures visible
5. supports deterministic recovery
6. keeps operational complexity low
7. preserves legacy behavior only where intentionally required
8. leaves room for future gaming intelligence and editing without building them prematurely

The desired pipeline is not the most abstract pipeline.

It is the pipeline that is easiest to trust.
