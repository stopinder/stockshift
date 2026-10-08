# Chunk 8: interrupted upload verification recovery

Verified locally on October 8, 2026. Existing modified and untracked work was
preserved. Scope is the upload verification recovery defect.

## Result and protocol

Previously, `begin` changed a source from pending to verifying without an attempt
lease. A process crash left it permanently non-ready. Completion also lacked an
attempt token, so simply allowing another begin would permit stale completion.

The new private lease table follows the durable job queue's token/expiry fencing
pattern. Source-row locks serialize claims and transitions. It does not rewrite
existing source records or add verification jobs to the CPU queue.

- Each claim has a random server-generated token and a 120-second lease.
- A live claim rejects overlapping finalization with HTTP 409.
- After expiry, the registered creator with current owner/editor membership can
  replay the same authorized `/api/uploads` finalize request, without re-uploading.
- Legacy verifying sources without a lease are recoverable on that same request.
- There are at most five claims. The next retry after expiry marks the source
  failed and asks for a new upload. Invalid document bytes remain terminal.
- Transient failures release only their own lease, allowing immediate retry.
- Finish, fail and release require the current token; expired or replaced attempts
  cannot publish results, invalidate a newer attempt or change ready metadata.
- Identical finish replay from the committing token is idempotent. A lost finish
  response does not turn a ready source into failed.
- Each recovered finalization downloads the registered private object again,
  checks actual bytes against registered size, verifies format and recalculates
  SHA-256. Claim and finish independently check registered Storage owner/size;
  finish rechecks creator/membership and validates size/hash before marking ready.
- Ready finalize replay preserves idempotent PDF inspection enqueue recovery.
  Byte readiness remains separate from inspection, extraction and review gates.

Recovery is request-driven; this chunk adds no automatic recovery worker or upload
resume UI. The PDF settings text no longer directs interrupted verification to an
administrator. The service-only eight-argument transition RPC adds `p_lease`.
The legacy seven-argument signature remains for begin/ready replay; unfenced
finish/fail is rejected. Application and fixture callers now pass their claim token.

## Native local evidence

Docker reported a reachable Linux engine. The database container's labels identify
`stockshift-local` and this exact checkout. API and Postgres connections were fixed
to `127.0.0.1:54321` and `127.0.0.1:54322`; generated local keys came from the
repository's guarded CLI wrapper. No linked project was used.

The database already contained data. A local dump and row fingerprints were taken
before migration. Only the pending migration
`20261008194938_upload_verification_recovery.sql` was applied, using
`npm run supabase:local -- migration up --local`. No database reset occurred.
Migration history now contains all ten local migrations, with none pending.

The new native suite passed **13 cases** with real Auth, signed Storage uploads,
blob downloads and Postgres/RPC transitions:

1. Claim interruption, expiry, fresh download/hash and ready replay.
2. Legacy verifying source without a lease.
3. Overlapping finalizers, with exactly one live claim.
4. Expired finish/fail/release rejection.
5. Replacement-token fencing and identical finish replay.
6. Slow stale finalizer unable to invalidate recovered ready state.
7. Transient download interruption followed by immediate recovery.
8. Lost finish response followed by ready finalization replay.
9. Five interrupted claims and bounded exhaustion.
10. Viewer, cross-tenant and same-tenant non-creator denial.
11. Membership revocation between download and completion.
12. Storage owner/size, verified size/hash and missing-token checks.
13. Browser-role RPC denial and inaccessible private lease internals.

Interruption tests deliberately hold or fail the transport around real gateway
operations. Expiry is advanced only for newly created test leases. Negative
metadata checks use rolled-back SQL fixtures. No Auth/Storage/database responses
are substituted for successful recovery. An initial fixture attempt to disable
Storage triggers was rejected by native ownership permissions; the fixture was
changed to seed inconsistent metadata inside a rolled-back transaction instead.
The final suite does not disable those triggers.

## Checks actually run

| Check | Result |
| --- | --- |
| `npm run test:local` | 163 passed: 32 security, 20 jobs, 16 review, 15 PDF, 14 inspection SQL, 8 native inspection/CPU worker, 11 OCR SQL, 34 upload/worker, 13 recovery |
| `npm run check` | Contracts generation check, typecheck, 86 web + 54 contract + 46 embedded SQL tests, production build passed |
| `npm run supabase:local -- db lint --local` | No schema errors |
| `npm run format:check` and focused changed-file Prettier check | Passed |
| Production build after the PDF status text update | Passed |
| Sequential desktop/mobile `pdf-acceptance.spec.ts` | All six real-browser cases passed |
| Desktop `pdf-inspection.spec.ts --grep 'enqueue response interruption'` | One browser case passed |
| Before/after public/Auth/Storage row fingerprints | All 8,690 pre-existing rows unchanged across 18 tables |
| `git diff --check` | No whitespace errors |

The first browser acceptance run overlapped the native test suite: its queue guard
blocked four cases before acceptance actions, while two later cases passed. After
native tests finished, the complete sequential rerun passed all six. No queue
guard was weakened and no unrelated jobs were consumed by that failed run.

The six browser cases retain Chunk 7's exact six baseline outcomes/three export
rows, leading-zero identifiers and prices; the saved `00042` correction and its
two-row export; and Blindtex's persisted `ocr_required` state with extraction,
comparison and export unavailable. The additional enqueue case covers manual
recovery after an interrupted response, transient read failure and terminal
inspection failure. It retains deliberate network fault injection for that case.
The six acceptance cases use real responses and the CPU worker throughout.

OCR SQL checks use synthetic stored envelopes; they make no OCR provider calls.
No hosted project, hosted migration, deployment, GPU operation or billing change
was performed. Hosted PDF uploads remain disabled and capability defaults remain
off. Only process-local PDF capability opt-in was used for local verification.
Tests leave additional synthetic local users, tenants, files and blobs.

## Files changed in this chunk

- `supabase/migrations/20261008194938_upload_verification_recovery.sql`: private
  bounded leases and fenced service-only transitions.
- `apps/web/server/uploads.ts`: carry claim token; release transient failures;
  preserve terminal invalid-byte failures and ready inspection enqueue recovery.
- `apps/web/server/supabase-upload-gateway.ts`: leased RPC call and status mapping.
- `apps/web/src/components/PdfSettings.vue`: verification recovery explanation only.
- `apps/web/tests/uploads.test.ts`: lease-aware fake and transient-failure assertion.
- `supabase/tests/security.test.mjs`: fenced finish/fail fixtures and legacy denial.
- `supabase/tests/inspection.local.ts`: lease-aware ready/hash/enqueue-gap fixtures.
- `apps/web/e2e/pdf-inspection.spec.ts`: lease-aware enqueue-gap fixture.
- `supabase/tests/upload-recovery.local.ts`: new native recovery acceptance suite.
- `scripts/verify-supabase-local.mjs`: include recovery suite in `test:local`.
- `supabase/README.md`: retry contract and recovery limitations.
- `docs/CHUNK_8_UPLOAD_VERIFICATION_RECOVERY.md`: this evidence report.

## Remaining release blockers

No remaining blocker was found for the authorized local Chunk 8 recovery path.
Hosted PDF support and disabled OCR processing remain outstanding. This recovery
migration has not been applied to any hosted instance; hosted rollout and its
validation remain separate work. Existing historical Chunk 4–7 reports describe
their original verification dates and have not been rewritten.
