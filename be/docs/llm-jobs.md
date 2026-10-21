# LLM jobs (`extract_lenses`, `summarize_meeting`) — rules and rationale

Moved out of `be/CLAUDE.md` (2026-10-21); `be/CLAUDE.md` keeps the rules and points here for the measurements behind them. **Living doc** — keep it current. Paths are relative to `be/`.

**Lens extraction is a third job type.** `extract_lenses` (`pipeline/extract_lenses.py`) reads the meeting's `status='ok'` utterances at the payload's `processing_version`, calls a **local OpenAI-compatible LLM** (`lens_client.py`; `lens_llm_base_url` defaults to `http://127.0.0.1:8000/v1`, model `mlx-community/Qwen3.5-4B-8bit`), and only persists candidates that pass pydantic validation. Failure marks the run/job — the meeting stays `done`. The LLM endpoint is loopback-local like the embed service, so the no-external-network premise holds. The client is **runtime-agnostic — there is no Ollama dependency**; the local runtime is `mlx_lm.server`, which serves an HF repo directly and validates the request's `model` field as a repo id with no way to alias it — which is why the summary catalog holds repo ids rather than Ollama tags (setup + five gotchas in `worker/SMOKE.md`). Because `response_format` is advisory for local runtimes, the LLM-response contract must tolerate an omitted nullable field — `LensCandidate.assignee_speaker_id`/`due_at` default to `None`; `extra="forbid"` still rejects invented fields. That contract is **worker-only** (no TS counterpart), unlike the job payload.
**The prompt is a `Speakers:` roster (`<speaker_id> <name>`, one line per
speaker) followed by `<index> <speaker name>: <text>` lines**, not the
DB rows —
`json.dumps` of the raw rows put `speaker_id`/`start_ms`/`end_ms` on every
utterance, none of which a lens item can use (there is no time field, and
`due_at` is a calendar date from the speech, not an offset into the
recording). The roster exists because `assignee_speaker_id` must match the
`SpeakerId` pattern (`spk_...`): the first cut dropped per-utterance
`speaker_id` entirely, and a meeting with named speakers (mtg_21, job_131)
came back with every assignee NULL — the model had no `spk_` token anywhere
in its context to cite. Listing each id once (2–12 lines) restores that
without re-paying the per-utterance cost. Before the trim the raw-row format
made mtg_10 (778 utterances) a 119,563-character prompt and
mtg_3 (997) a 236,484-character one; both died on the LLM timeout, and every
run over ~250 utterances failed. The line format is 39,238 and 133,215
characters. Like `summary_client`, transcript lines cite utterances by
**1-based index**, and `lens_client` maps the reply's `primary_index`/
`supporting_indexes` back to real ids before returning `LensCandidate`s (the
LLM-side shape is a private `_LlmLensItem`; the persist-side contract is
unchanged). Real ids in the prompt were tried first and failed measurably:
the model interpolated between `utt_2657`/`utt_2659` and cited `utt_2658` —
a `transcribe_failed` row excluded from the prompt — so mtg_1's whole
extraction died as `invalid_lens_candidate`, permanently, since
`temperature=0` replays the same reply. Consecutive integers land on a real
utterance even when interpolated. An out-of-range `primary_index` drops only
that item (logged); out-of-range `supporting_indexes` are removed and the item
kept. Indexes are never clamped here — a primary is a claim that *this*
utterance is the evidence, and clamping would pin it to an unrelated one.

**Conversation summary is a fourth job type.** `summarize_meeting`
(`pipeline/summarize_meeting.py`) reads the same `status='ok'` utterances as
`extract_lenses` and calls the same local LLM through `summary_client.py`,
but writes a single `meeting_summary` row (topics + segments as jsonb). The
summary model comes from two different places depending on who triggers the
job: the worker's auto-enqueue uses the payload's `models.summary_model`
(falling back to the worker's own env default when absent — v1/v2
payloads; skipped entirely when `followups.summary` is false, which is what
upload's `defer_summary=true` sets), while the API's manual regeneration
(`POST /meetings/:id/summary/generate`) uses the global processing
setting's `summary_model` unless the request body overrides it, and
returns `409` if a different model is already in flight for that meeting.
The two jobs are queued together in the `persist` transaction and are
otherwise **independent** — a summary failure leaves lens items untouched
and vice versa. **The LLM supplies only boundary indexes (the client maps them to `utterance_id`s); `start_ms`/`end_ms`
are derived from the DB rows** (`_resolve_segments`), so a model cannot
invent timestamps. **The prompt carries only `<index> <speaker>: <text>`
lines** — not the DB rows. Sending each utterance as a JSON object with
`speaker_id`/`start_ms`/`end_ms` made the transcript 19% of its own prompt:
mtg_22 (624 utterances, 16.5k characters of speech) serialized to 88k
characters / 45.4k tokens, of which the model could use none of the
timestamps (the system prompt forbids emitting them and `_resolve_segments`
derives the real ones from the DB) and none of the ids (replaced by 1-based
indexes). `mlx_lm.server` prefill is dominated by prompt length, not
parameter count, so that cost ~285s before a single token was generated and
the run died on the 900s client timeout mid-generation — dropping to 4B did
not move it. The line format is 13.5k tokens for the same meeting.
Utterance-internal newlines are folded so one utterance stays one line;
a nameless speaker falls back to `speaker_id` rather than dropping the turn's
attribution. Boundaries are normalized, not rejected: `summary_client`
clamps out-of-range indexes into `1..N`, and `_resolve_segments` swaps
reversed boundaries, sorts segments, and trims or merges overlaps without
dropping a bullet. The one PERMANENT reject left is a boundary outside the
meeting, which the index mapping makes unreachable in practice. The summary is **read-only** — there is
no per-item edit path, no `source` column, and no merge; regeneration
replaces the row wholesale. `summary_client.py` sends an explicit
`max_tokens` (`lens_llm_max_tokens`, default 8192) because the server default
(512 on `mlx_lm.server`) truncates a long meeting's JSON mid-object; a
`finish_reason='length'` reply fails PERMANENT naming the budget rather than
surfacing as unparseable JSON.

**Neither LLM client retries, and an LLM timeout is PERMANENT.** Both used to
requeue on `httpx.TimeoutException`, and `summary_client` additionally re-asked
once with the validation error fed back. Both are gone: the prompt, the model,
and `temperature=0` are all unchanged between attempts, so the reply is the
same bytes and the timeout lands at the same point — and because the LLM server
is job-owned it is torn down between attempts, so a retry re-pays the full
prefill with a cold prompt cache. mtg_22 spent 45 minutes failing the same
15-minute way three times before reporting `llm_request_failed`. A
`httpx.RequestError` (connection refused, server still coming up) stays
TRANSIENT — that one really can differ on the next attempt. Removing the
feedback loop also removed `summarize`'s `validate` callback, which existed
only to route domain checks into it; `pipeline/summarize_meeting.py` still
calls `_resolve_segments` on the response exactly as before.
