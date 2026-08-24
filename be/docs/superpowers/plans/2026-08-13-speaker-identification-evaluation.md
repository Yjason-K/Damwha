# Speaker Identification Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, repeatable speaker-identification evaluator and an explicit yt-dlp clip-preparation command.

**Architecture:** Pure Python evaluation logic parses and validates a CSV manifest, ranks normalized embeddings, and computes threshold metrics without ML dependencies. A thin CLI creates embeddings using the existing ECAPA adapter and writes CSV/Markdown reports. A separate preparation CLI validates only explicit manifest URLs/ranges, invokes `yt-dlp` and ffmpeg, and never discovers or downloads a channel automatically.

**Tech Stack:** Python 3.12, stdlib `csv`/`argparse`/`subprocess`, existing SpeechBrain ECAPA adapter, pytest, ruff, yt-dlp and ffmpeg as manually installed command-line prerequisites.

## Global Constraints

- Do not change production speaker, voiceprint, job, or database code.
- Deterministic tests must not import SpeechBrain, ffmpeg, yt-dlp, or other models-extra dependencies.
- The preparation command runs a download only when `--download` is passed; manifest URLs and time ranges are operator-supplied.
- Generated clips and reports live in a user-supplied directory, never in the repository.
- Evaluate with a separate enrollment and test video for any identity.
- Use the configured ECAPA model and preserve individual enrollment clips as independent reference embeddings.

---

### Task 1: Manifest, ranking, and metrics core

**Files:**
- Create: `worker/damwha_worker/evaluation/speaker_identification.py`
- Create: `worker/damwha_worker/evaluation/__init__.py`
- Create: `worker/tests/test_speaker_identification_eval.py`

**Interfaces:**
- Produces `ClipSpec(id: str, role: Literal['enroll', 'test'], speaker: str, condition: str, source_url: str | None, start_s: float | None, end_s: float | None, path: Path | None)`.
- Produces `load_manifest(path: Path) -> list[ClipSpec]`, `cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float`, `rank_speakers(test_embedding: Sequence[float], enrollments: Mapping[str, Sequence[Sequence[float]]]) -> list[SpeakerScore]`, and `summarize_trials(trials: Sequence[Trial], thresholds: Sequence[float]) -> list[ThresholdSummary]`.
- Consumes only parsed vectors; later CLIs provide files and ECAPA embeddings.

- [ ] **Step 1: Write the failing tests for manifest validation and ranking**

```python
def test_manifest_requires_complete_local_or_download_source(tmp_path):
    manifest = tmp_path / "clips.csv"
    manifest.write_text(
        "id,role,speaker,condition,source_url,start_s,end_s,path\n"
        "bad,test,alice,studio,,,,\n"
    )
    with pytest.raises(ValueError, match="bad.*path or source_url"):
        load_manifest(manifest)


def test_rank_uses_best_enrollment_per_speaker():
    ranked = rank_speakers(
        [1.0, 0.0],
        {"alice": [[0.7, 0.7], [1.0, 0.0]], "bob": [[0.0, 1.0]]},
    )
    assert [(row.speaker, row.score) for row in ranked] == [("alice", 1.0), ("bob", 0.0)]
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_speaker_identification_eval.py -q`

Expected: FAIL because `damwha_worker.evaluation.speaker_identification` does not exist.

- [ ] **Step 3: Implement strict manifest parsing and deterministic ranking**

```python
@dataclass(frozen=True)
class SpeakerScore:
    speaker: str
    score: float


def rank_speakers(test_embedding, enrollments):
    scores = [
        SpeakerScore(speaker, max(cosine_similarity(test_embedding, e) for e in vectors))
        for speaker, vectors in enrollments.items()
    ]
    return sorted(scores, key=lambda row: (-row.score, row.speaker))
```

Reject duplicate ids, invalid role, invalid/empty `source_url`, non-positive or inverted ranges, and rows with neither a local path nor a complete URL/range triple. Permit an unknown test speaker only when `role=test` and it has no enrollment row.

- [ ] **Step 4: Add failing tests for threshold classification and aggregate metrics**

```python
def test_summaries_count_unknown_above_threshold_as_false_accept():
    trials = [
        Trial("unknown", "eve", "noise", "alice", 0.72, 0.11, enrolled=False),
        Trial("known", "alice", "studio", "alice", 0.72, 0.11, enrolled=True),
    ]
    summary = summarize_trials(trials, [0.70])[0]
    assert (summary.tp, summary.fp, summary.tn, summary.fn) == (1, 1, 0, 0)
    assert summary.far == 1.0
```

- [ ] **Step 5: Implement trial classification and metrics**

```python
def classify(trial: Trial, threshold: float) -> Literal["tp", "fp", "tn", "fn"]:
    accepted = trial.predicted_speaker is not None and trial.top_score >= threshold
    if trial.enrolled:
        return "tp" if accepted and trial.predicted_speaker == trial.expected_speaker else "fn"
    return "fp" if accepted else "tn"
```

Use zero-denominator-safe `0.0` values for precision, recall, FAR, and FRR. Produce both `condition="all"` and one row for each condition.

- [ ] **Step 6: Run the core test suite and lint**

Run: `cd worker && uv run pytest tests/test_speaker_identification_eval.py -q && uv run ruff check damwha_worker/evaluation tests/test_speaker_identification_eval.py && uv run ruff format --check damwha_worker/evaluation tests/test_speaker_identification_eval.py`

Expected: PASS.

- [ ] **Step 7: Commit the core**

```bash
git add worker/damwha_worker/evaluation worker/tests/test_speaker_identification_eval.py
git commit -m "feat(worker): add speaker evaluation metrics core"
```

### Task 2: Explicit yt-dlp clip preparation CLI

**Files:**
- Create: `worker/scripts/prepare_speaker_eval.py`
- Create: `worker/tests/test_prepare_speaker_eval.py`
- Modify: `.gitignore`

**Interfaces:**
- Consumes `load_manifest(path: Path) -> list[ClipSpec]` from Task 1.
- Produces `main(argv: Sequence[str] | None = None) -> int` and `download_clip(clip: ClipSpec, output_dir: Path, *, run: Callable[..., CompletedProcess[str]]) -> Path`.
- The evaluator in Task 3 consumes local clip paths prepared here.

- [ ] **Step 1: Write failing preparation-command tests**

```python
def test_prepare_requires_explicit_download_flag(tmp_path, capsys):
    code = main(["--manifest", str(write_url_manifest(tmp_path)), "--outdir", str(tmp_path / "out")])
    assert code == 2
    assert "--download" in capsys.readouterr().err


def test_prepare_builds_exact_ytdlp_and_ffmpeg_commands(tmp_path):
    calls = []
    result = download_clip(valid_clip(), tmp_path, run=lambda args, **kw: calls.append(args) or Done())
    assert calls[0][0] == "yt-dlp"
    assert "https://example.test/video" in calls[0]
    assert calls[1][:2] == ["ffmpeg", "-y"]
    assert result.suffix == ".wav"
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd worker && uv run pytest tests/test_prepare_speaker_eval.py -q`

Expected: FAIL because `scripts.prepare_speaker_eval` does not exist.

- [ ] **Step 3: Implement a bounded, idempotent preparation command**

```python
parser.add_argument("--download", action="store_true")
if not args.download:
    parser.error("refusing network download without --download")

yt_dlp = ["yt-dlp", "--no-playlist", "--download-sections", f"*{start}-{end}", "-o", str(raw), url]
ffmpeg = ["ffmpeg", "-y", "-i", str(raw), "-ac", "1", "-ar", "16000", str(wav)]
```

Use a manifest-derived safe filename (`id.wav`), do not pass a shell string, detect missing executable with a clear error, skip an existing WAV unless `--force`, and clean only the per-clip temporary raw file after successful conversion. Add `speaker-eval/` to `.gitignore` as the recommended output directory.

- [ ] **Step 4: Run focused tests and lint**

Run: `cd worker && uv run pytest tests/test_prepare_speaker_eval.py -q && uv run ruff check scripts/prepare_speaker_eval.py tests/test_prepare_speaker_eval.py && uv run ruff format --check scripts/prepare_speaker_eval.py tests/test_prepare_speaker_eval.py`

Expected: PASS; no external executable is invoked by tests.

- [ ] **Step 5: Commit the preparation CLI**

```bash
git add .gitignore worker/scripts/prepare_speaker_eval.py worker/tests/test_prepare_speaker_eval.py
git commit -m "feat(worker): prepare explicit speaker evaluation clips"
```

### Task 3: Real-ECAPA evaluation and report CLI

**Files:**
- Create: `worker/scripts/eval_speaker_identification.py`
- Create: `worker/tests/test_eval_speaker_identification.py`
- Create: `worker/scripts/examples/speaker-eval-manifest.csv`
- Modify: `worker/SMOKE.md`

**Interfaces:**
- Consumes `ClipSpec`, `rank_speakers`, and `summarize_trials` from Task 1.
- Imports `EcapaEmbedder` only inside `main()` after argument validation.
- Produces `<outdir>/trials.csv`, `<outdir>/thresholds.csv`, and `<outdir>/report.md`.

- [ ] **Step 1: Write failing report-serialization tests without models**

```python
def test_write_outputs_includes_margin_and_condition_summary(tmp_path):
    write_outputs(tmp_path, [trial("clip1", margin=0.21)], [summary("noise", threshold=0.7)])
    assert "margin" in (tmp_path / "trials.csv").read_text()
    assert "noise" in (tmp_path / "thresholds.csv").read_text()
    assert "Recommended operating point" in (tmp_path / "report.md").read_text()
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd worker && uv run pytest tests/test_eval_speaker_identification.py -q`

Expected: FAIL because `scripts.eval_speaker_identification` does not exist.

- [ ] **Step 3: Implement local-audio evaluation and output writing**

```python
parser.add_argument("--manifest", required=True, type=Path)
parser.add_argument("--outdir", required=True, type=Path)
parser.add_argument("--model", default="speechbrain/spkrec-ecapa-voxceleb")
parser.add_argument("--device", default="cpu")
parser.add_argument("--threshold", type=float, default=0.7)
parser.add_argument("--thresholds", default="0.45:0.85:0.05")
```

For each clip, construct one full-file `DiarSegment("eval", 0, duration_ms)` using the existing ffmpeg `probe()` helper, request one ECAPA embedding, and record skipped clips with a reason. Fail when no enrollment embeddings or no test trials remain. Compute the runner-up score as `0.0` when fewer than two enrolled speakers exist and select the recommended threshold as the lowest threshold with FAR `<= 0.01` and greatest recall; if no threshold qualifies, state that explicitly.

- [ ] **Step 4: Add and document an empty-URL example manifest**

```csv
id,role,speaker,condition,source_url,start_s,end_s,path
speaker_a_enroll,enroll,speaker_a,studio,,,,/absolute/path/to/enrollment.wav
speaker_a_test,test,speaker_a,phone,,,,/absolute/path/to/test.wav
unknown_test,test,unknown,noise,,,,/absolute/path/to/unknown.wav
```

Document the exact two-step command in `worker/SMOKE.md`:

```bash
uv run python scripts/prepare_speaker_eval.py --manifest manifest.csv --outdir /tmp/speaker-eval --download
uv run --extra models python scripts/eval_speaker_identification.py --manifest manifest.csv --outdir /tmp/speaker-eval/report
```

State that each identity must use different videos for enrollment and test; yt-dlp/ffmpeg are manually installed prerequisites; results are local diagnostics rather than a production threshold change.

- [ ] **Step 5: Run all evaluator tests and static checks**

Run: `cd worker && uv run pytest tests/test_speaker_identification_eval.py tests/test_prepare_speaker_eval.py tests/test_eval_speaker_identification.py -q && uv run ruff check damwha_worker/evaluation scripts/prepare_speaker_eval.py scripts/eval_speaker_identification.py tests/test_speaker_identification_eval.py tests/test_prepare_speaker_eval.py tests/test_eval_speaker_identification.py && uv run ruff format --check damwha_worker/evaluation scripts/prepare_speaker_eval.py scripts/eval_speaker_identification.py tests/test_speaker_identification_eval.py tests/test_prepare_speaker_eval.py tests/test_eval_speaker_identification.py`

Expected: PASS.

- [ ] **Step 6: Run the manually supplied real-model smoke only when a permitted manifest exists**

Run: `cd worker && uv run --extra models python scripts/eval_speaker_identification.py --manifest /path/to/permitted-manifest.csv --outdir /tmp/speaker-eval-report`

Expected: `trials.csv`, `thresholds.csv`, and `report.md`; document any unavailable model/audio prerequisite rather than treating it as a code failure.

- [ ] **Step 7: Commit the evaluator and docs**

```bash
git add worker/scripts/eval_speaker_identification.py worker/scripts/examples/speaker-eval-manifest.csv worker/tests/test_eval_speaker_identification.py worker/SMOKE.md
git commit -m "feat(worker): add speaker identification evaluator"
```
