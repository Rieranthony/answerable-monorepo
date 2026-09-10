# Rejected-upload connection reuse investigation

**Status:** the failing test client reuses a chunked-upload connection before its framing is complete. An independent Node parser rejects the following `GET` as an invalid chunk size. The runtime test now disables pooling only for its deliberately rejected streamed upload; ordinary health requests remain pooled, and the health assertion is unchanged. Production body limits and middleware are unchanged.

The initial full suite observed an empty HTTP 400 from `/healthz` after rejecting oversized and stalled uploads. Three isolated repetitions and the next full run passed, which did not explain the failure.

The [probe](/Users/anthonyriera/code/answerable/reports/id-request-reuse-probe.mjs) now reproduces it without PostgreSQL, authentication, migrations or the five-second timeout. It mounts the actual application body guard in Hono on the pinned Bun server, sends a 262,145-byte chunked upload, consumes its 413 response, and requests health. Each scenario runs 500 sequences. The [recorded evidence](/Users/anthonyriera/code/answerable/reports/id-request-reuse-evidence.json) contains only synthetic request outcomes.

```sh
bun reports/id-request-reuse-probe.mjs
```

Node must be installed for the independent-client comparison. This is a diagnostic probe, not a CI test or a runtime dependency. Failure counts are timing-dependent, not a stable expected snapshot.

| Scenario                                             | Failed health responses | Health handler calls |
| ---------------------------------------------------- | ----------------------: | -------------------: |
| Native 256 KiB cap, pooled Bun client                |                63 / 500 |                  437 |
| Same, explicit close on rejected responses           |                72 / 500 |                  428 |
| Higher native cap, explicit close, pooled Bun client |               311 / 500 |                  189 |
| Native cap, Bun client with pooling disabled         |                 0 / 500 |                  500 |
| Native cap, independent Node client                  |                 0 / 500 |                  500 |

In these failures, the health handler was not entered; the response body was empty. Both disabling pooling and switching the client avoided the observed failure in this sample. This supports a Bun client/server connection-reuse interaction; it does not identify the precise parser/socket race or establish that every other client is unaffected.

**Rejected changes:** adding `Connection: close` alone did not fix the reproduction. Raising the native body cap did not fix it either; an initial 100-request zero-failure result disappeared in the longer run. Both experimental runtime changes were removed. The production size cap, application byte counting, deadline and existing runtime health assertion remain unchanged. Do not raise limits, remove the health assertion or introduce automatic mutation retries to make this symptom disappear.

## Independent parser proof and test correction

Run the [framing probe](/Users/anthonyriera/code/answerable/reports/id-request-framing-probe.mjs) with `bun reports/id-request-framing-probe.mjs`. Its [recorded result](/Users/anthonyriera/code/answerable/reports/id-request-framing-evidence.json) uses Bun 1.3.1 and Node v24.18.0. The independent Node server drains request data and responds 413 when the size passes 256 KiB. It records parser errors and their synthetic raw bytes.

Of 500 sequences, 31 failed. All 31 errors are `HPE_INVALID_CHUNK_SIZE`, with `bytesParsed: 0`; the rejected packet begins `GET /healthz HTTP/1.1`. Thus the server still expects a chunk size when the client sends the next request. This reproduces without Hono or the Answerable body guard. It establishes malformed client framing on connection reuse, not an Answerable health-handler or database failure. It does not pinpoint Bun's internal scheduling implementation.

A separate 500-sequence check against the unchanged application guard disables pooling **only for the rejected upload**. Its health requests continue to use Bun's default pool. It records zero failures and exactly 500 health-handler calls. `runtime.test.ts` applies this narrow fixture correction with `keepalive: false` on the deliberately rejected chunked upload. Reading the 413 response body is insufficient evidence that Bun finished sending that request's chunk terminator. No retry, relaxed response assertion or production connection policy was added.

Five repetitions of the real runtime file pass 25 tests / 140 assertions (`/private/tmp/id-body-framing-runtime.log`, 25.65 seconds). The focused command exits 1 only because the repository requires whole-suite coverage. Full gate results are recorded below.

The direct raw-socket control sent a complete oversized chunk's payload, waited for 413, then sent its terminator and a valid health request on that same socket. It received 200 and reached the health handler. A TCP forwarding proxy hid the timing-dependent Bun-client failure in 500 attempts, including with Nagle buffering disabled, so those proxy traces do not prove absence of the bug.

**First-principles outcome:** remove the unsupported assumption that a consumed early response makes the client connection safe to reuse. Keep the actual server limits and validation. The earlier connection-close and native-limit experiments remain rejected. The test is about server rejection and subsequent availability, not a guarantee that a client may omit HTTP framing. Consumers using this pinned Bun client for streamed bodies must account for its early-response reuse behaviour; this investigation does not justify generic retries of identity mutations or a runtime upgrade without verification.

**Framing correction final gates:** 1,745 ID tests pass, zero failures, 20,575 assertions and 100% line/function coverage (`/private/tmp/id-body-framing-full.log`, 307.76 seconds). Typecheck, lint and all 62 web tests pass (`/private/tmp/id-body-framing-{typecheck,lint,web}.log`). Build passes both packages, one cached (`/private/tmp/id-body-framing-build.log`, 279 milliseconds). `git diff --check` passes. The change is limited to the rejected-upload test client's pooling and reproducible diagnostic evidence; production runtime behaviour is unchanged. No deployment or database/key provisioning occurred. No runtime upgrade is claimed.
