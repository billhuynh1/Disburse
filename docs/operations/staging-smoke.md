# Staging smoke and fault verification

Use synthetic or explicitly non-sensitive media only. Keep files under 10 MiB and approximately 5–20 seconds. Validate locally with:

`npm run ops:validate-smoke-fixture -- /absolute/path/to/non-sensitive.mp4`

The validator never uploads. In staging, upload through the normal authenticated UI, confirm the source/transcript/clip workflow, and inspect only the protected snapshot and allowlisted events. Run `npm run ops:preflight -- --require-env` before deployment. Do not publish to YouTube or TikTok; S7 does not enable publishing.

For deterministic fault passes, use a deployment explicitly identified by `DISBURSE_DEPLOYMENT_ENV=staging`, set the strict lowercase boolean `DISBURSE_STAGING_FAULT_INJECTION_ENABLED=true`, configure an independent `DISBURSE_FAULT_INJECTION_SECRET`, and select exactly one valid `DISBURSE_FAULT_INJECTION=<provider>:<point>`. Send that secret only as `x-disburse-fault-injection-authorization` on the already authenticated internal processor request. Providers are `openai`, `s3`, `media`, `render`, and `facecam`; points are `before_send`, `after_send_before_response`, `after_provider_success_before_persistence`, and `after_checkpoint_persistence_before_finalization`. Run one canary lineage, verify the expected prepared/ambiguous/completed checkpoint and recovery behavior, then set the switch to `false` and clear the selected fault and request header before the next case. Missing identity, switch, selection, secret, or matching header fails closed. A selected fault while disabled is release-blocking, as is any selected fault in production; `NODE_ENV` never replaces the staging identity.

Required staging evidence: internal-trigger failure followed by Cron recovery; expired lease takeover; reconciliation interruption/resume; recovery-versus-deletion and finalization races; stale-token fencing; lineage-budget exhaustion; each provider/point matrix case; a migration canary; and snapshot/alert delivery. Capture counts and safe IDs only.
