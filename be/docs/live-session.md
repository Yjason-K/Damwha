# Live session (`live_session` job) — full rules

Moved out of `be/CLAUDE.md` (2026-10-21) so the agent guide stays short; `be/CLAUDE.md` keeps the invariant summary and points here. This is a **living doc** — keep it current. Paths are relative to `be/` unless they start with `../`.

**Live session is a fifth job type — and the browser is the capturer, not the worker.**
`live_session` (`pipeline/live_session.py`) streams a preview (`live_utterance`) while the
meeting is `recording`; on stop the meeting flips to `uploaded` and the payload's embedded
**`process_meeting`** (wire v5 under `live_session` v1, v6 under v2) is enqueued verbatim —
the batch pass is the record, the live pass is a preview. Two specs, in order: the original
`../../docs/superpowers/specs/2026-09-05-live-recording-design.md`, then
`../../docs/superpowers/specs/2026-09-05-live-recording-browser-capture-design.md`, which
**reverses its §2.1**. Read the second one's §2.1 first — the first spec's capture
architecture is history, not current behaviour.

**Who holds the audio.** The browser does `getUserMedia` → `AudioWorklet` → 16 kHz mono
int16 PCM → 32,768-byte chunks (1.024 s) → `POST /meetings/:id/live/audio`. The **API** is
the WAV writer (`storage/live-audio.service.ts` — `StorageService.save()` is `writeFile`,
which truncates, so append needed its own service); the worker **tails** that growing file
(`audio/tail_source.py`). The worker writes no audio at all. Constants must agree across
three languages: `SR=16000`, `FRAME_BYTES=1024`, `CHUNK_BYTES=32768`, `HEADER_LEN=44`,
**32 bytes/ms** (`live.service.ts`, `tail_source.py`, `pcm-convert.ts`).

**The offset/ACK protocol is the whole correctness story.** Each chunk carries an explicit
`X-Audio-Offset` (PCM bytes, header excluded); the server compares it against
**`job.committed_bytes`** and a mismatch is **409 carrying `expected_offset`**, so a lost
ACK resyncs instead of tearing a hole. Exactly one request in flight. A 409 that carries
*no* offset is terminal, not a resync — the client must treat it as a hard failure, or
`this.offset` goes `undefined` and every later request 400s including the stop that would
have sealed the recording. A resent chunk (`offset + len === committed`) is ACKed as a 409
at the committed boundary, and `markInput` is **committed before** that 409 is thrown —
a producer that is demonstrably alive must not be sealed by the orphan sweeper.

**`job.committed_bytes` (migration `024`) is the append-offset authority — the file length
is not.** This is the one rule the 2026-09-07 capture-hardening pass added, and everything
else follows from it. A crash between `write` and `fdatasync`, or a short `FileHandle.write`,
leaves an *unconfirmed tail* on disk: the file is longer than anything the API ever
acknowledged. Deriving `expected` from `stat.size - 44` (the pre-024 behaviour) would
promote those bytes to canon. So: `LiveAudioService.writeAt` loops until the whole buffer is
written (never assumes one `write` call drains it), `datasync()`s, and only then does
`setCommitted` advance the boundary **in the same transaction as the append**; every entry
point calls `recover(key, committed)` first, which **truncates the file back to
`44 + committed_bytes`** — and *throws* if the file is shorter than that, because losing
already-committed bytes is a disk failure, not something to zero-fill. `pcmSize()` survives
only as a test helper — no production path may reason from file length. The cap is
`MAX_PCM_BYTES = 460_800_000` (4 h at 32 bytes/ms).

**`committed_bytes` vs `sealed_bytes` — they are not the same fact.** `committed` advances on
every append; `sealed` is the single moment one of those boundaries is declared final. The
`024` CHECK enforces the relationship (`type='live_session'`, even, and
`sealed_bytes IS NULL OR sealed_bytes = committed_bytes`) so the two can never disagree in
the DB. `sealed_bytes` stays the **sole EOF authority** — not the file size, not the WAV
header. File append, header rewrite and DB commit cannot be one transaction, so one of them
has to win. `TailSource` therefore treats **EOF as "caught up", never as "done"**, caps its
reads at `committed_bytes`, and never reads the header's size fields (the API rewrites them
at seal time; a read mid-rewrite truncates the transcript). Stop carries the final tail
**in its body** so there is no window between the last chunk and the seal: `offset ===
committed` → append + seal in one transaction; an already-sealed job answers idempotently
when `sealed === final`; otherwise `missing_chunk` 409.

**A session created before `024` cannot be resumed.** `committed_bytes IS NULL` on a live
row means the session predates the column, and the API refuses it with a **409 whose `code`
is `io_error`** (message: "this live session predates the committed byte boundary") rather
than back-deriving a boundary from the file — back-deriving is exactly the unconfirmed-tail
bug the column exists to prevent. That code label is a known wart: it is a compatibility
refusal, not a disk error, and the client treats any code-bearing 409 as terminal either way.
That is why the (now-retired) self-hosted deployment procedure required draining active
recordings before applying `024`, and why `LiveOrphanService` closes such a row as an
`io_error` instead of sealing it.

**The 4-hour cap is enforced at the byte boundary, not by a timer.** A chunk that would cross
`MAX_PCM_BYTES` has its in-bounds prefix written and the session is sealed there; the client
gets a 409 with code `duration_limit` (not a plain resync) and stops capturing. That stop
does **not** finalize — a capped session is left to the worker or the sweeper.

**`meeting.capture_error` is separate from `meeting.error` on purpose** — finalize and
persist both write `error=NULL`, so "how this recording was obtained" needs a field that
survives a successful final pass. Written by: the browser's stop (`X-Capture-Error`:
`device_ended` / `buffer_overflow` / `upload_failed`; an unrecognised value is folded to
`capture_failed` rather than 400ing, because a diagnostic header must never block the seal),
the gap check on append and stop (`capture_gap`), and the orphan sweeper
(`producer_abandoned`) / API finalize (`preview_worker_lost`). Verified 2026-09-07 on a real
recording whose worker was killed mid-session: the meeting finished the canonical pass as
`done` with `error = NULL` **and `capture_error = preview_worker_lost` still set** — that
survival is the whole reason the column is separate.
`LiveService.stop` writes the header's error **before** the seal/idempotency branches, so a
retried stop that carries `X-Capture-Error` still records it after the session is sealed.

**Recording does not depend on the worker — a worker failure ends the *preview* only.**
`reapStale`'s `fail_meetings` covers `process_meeting` only, and **both reapers now agree**:
the Python `db.reap_stale` excludes `live_session` from `fail_meetings` and from the requeue
set exactly as the TypeScript `JobsRepository.reapStale` does. (Only the TS side had this
until 2026-09-07; the carry-over list had recorded the item as closed while `db.py` still
failed the meeting. `be/test/reaper.spec.ts` and
`worker/tests/test_db_lifecycle.py::test_reap_stale_fails_live_session_but_leaves_the_meeting_recording`
now pin the same contract on both sides.) The worker's own failure paths do the same: for a
`source='browser'` session, both the `ShutdownRequested` path and the generic exception path
call **`db.fail_live_preview`**, never `fail_process_meeting` — the job goes `failed` with
code `worker_shutdown` (or the classified error) while the meeting stays `recording` and
keeps accepting appends. Measured on 2026-09-07: SIGTERM to a live worker, then 15 further
`POST /live/audio` all 200 and `committed_bytes` advanced by exactly 15 × 32,768.

That makes **"who finalizes"** the load-bearing predicate, and it is `job.status !== 'running'`
(queued = never claimed, failed = the reaper *or the worker's own preview failure* closed it)
in **both** `LiveService.stop` and `LiveOrphanService.sweep`. The sweeper has two jobs, not
one: seal an abandoned producer (`last_input_at` stale ≥ 90 s, `@Cron(EVERY_30_SECONDS)` — a
worker's heartbeat cannot prove the *browser* is alive), **and** finalize an already-sealed
session no worker will finish. Without the second, a browser+worker death leaves the meeting
in `recording` forever and `meeting_single_recording_idx` blocks every future recording.
Worker liveness is judged only by `job.status` — the reaper owns that threshold, and a
second one here would drift from it.

**The sweeper re-validates liveness under the lock, not just status.** Candidate selection
and sealing are different transactions, so a browser can commit a perfectly good append in
between. After taking job → meeting locks, `sweep` re-checks `isProducerExpired` **against
the DB clock it now holds**; a session that became fresh again is left alone. Only then does
it `recover()` to the committed boundary and seal *there* — never at the file length. Order
matters: an already-sealed row skips the producer check entirely and goes straight to
recovery-finalize, and a `committed_bytes IS NULL` row is closed as `io_error` rather than
guessed at. A 0-byte sweep result is **failed and kept** (`producer_never_started`), not
deleted — only a user-pressed stop deletes a 0-byte meeting.

**Lock discipline: job row first, then meeting**, in every writer (`appendAudio`, `stop`,
`sweep`, `MeetingsService.cancel`, and the worker's `finalize_live_session`); the paths that
start from a meeting id re-verify `current_job_id` under both locks. Locking only the
meeting lets `claim` (job row, `SKIP LOCKED`) slip in.

**Failure marking lives in its own transaction.** The `io_error` path marks job+meeting in a
*separate* `withTransaction` after the append transaction rolled back — marking inside it and
throwing rolls the marking away too, and then nothing ever closes the session. That recovery
re-locks job → meeting and re-checks four things, the load-bearing one being
**`job.committed_bytes` is still the value it was when the write failed**, because a
legitimate retry (a lost ACK) may have won the race in between. The status alone cannot tell
(a successful append leaves the meeting `recording` either way), and **the file length is
useless here by construction** — our own partial write is what stretched it. The committed
boundary is the only signal that distinguishes "nobody made progress" from "someone else
already did".

**`source: 'mic'` is a reserved contract slot that is rejected at dispatch.** After the
capture flip a mic session is silently wrong — the API stores the browser's bytes while the
worker transcribes the host mic, and `MicSource` never observes `sealed_bytes`, so the loop
runs to `max_minutes` (4 h) after stop. `jobs.py::default_live_source` raises PERMANENT
`audio_device_failed` instead. `MicSource` and its tests stay as the reference for a future
system-audio capturer (§10.3 constrains how that can share a WAV).

Unchanged from the original design: `max_attempts=1` and every live error is PERMANENT; a
live job is **never** `requeue_for_shutdown`d (a re-claimed worker would re-transcribe audio
that already went by); claim orders `live_session` first
(both claim SQLs); one `recording` meeting at a time (`meeting_single_recording_idx`); live
identification binds at `suggest_threshold`; `persist_process_meeting` deletes the meeting's
`live_utterance` rows; `ffmpeg.normalize` repairs a streaming header left by a crash.

**Deleted by the flip** (do not reintroduce): the mic callback's writer thread and its
streaming-WAV `close()`, the dual-queue tee, and the join-ordering rule between them. The
worker no longer owns a file handle. `pcm-worklet.ts` still has **no jsdom coverage** (jsdom
has no `AudioContext`), but it is no longer untested: `pnpm fe verify:worklet` evaluates the
**built** `fe/dist/assets/pcm-worklet-*.js` in `node:vm` and drives the same
begin/flush sequence as the protocol unit test, which is what catches a regression to
copying the raw `.ts` as a URL asset. A real browser is still the only check of
`audioWorklet.addModule()` itself — `worker/SMOKE.md`'s 실기기 브라우저 스모크 procedure.

**Dev: API and worker are both host processes** and `be/.env`'s `./storage` is the worker's
`../storage` — literally one directory. (The now-retired self-hosted install had a second
shape: the API as a Linux container whose `STORAGE_ROOT=./storage` resolved to
`/repo/be/storage`, bind-mounted from the host, which the host worker read directly. Measured
2026-09-07 with an image built from this branch: bytes the container committed were visible
to a host `stat` within **0.01–0.02 ms** of the 200, and a host `TailSource` read the
container-written growing file to its seal with `skips=0` — kept here because it demonstrates
the bind-mount latency is negligible, in case a similar split ever recurs.) Applying `024`
requires draining active recordings first.
