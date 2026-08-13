# Speaker identification evaluation design

## Goal

Measure how reliably the existing ECAPA voiceprint matcher recognises an
already-registered speaker when the recording, microphone, noise, and number
of participants change. The result must make a threshold choice auditable,
without modifying production speakers, voiceprints, or jobs.

## Scope

- A local, repeatable evaluation tool under `worker/scripts/`.
- A CSV manifest describes enrollment/test clips, their expected speaker, and
  recording condition.
- An optional `yt-dlp` preparation command downloads only the public URLs and
  time ranges explicitly listed in that manifest, then extracts mono WAV clips
  with ffmpeg.
- The evaluator uses the same configured ECAPA model as the worker and writes
  machine-readable per-trial and threshold-summary CSV files.

Out of scope: downloading arbitrary channels, changing the production
identification query, automatic re-enrollment, database writes, and using the
result to make a production threshold change.

## Data and legal boundary

The operator supplies the manifest and is responsible for permission to make a
local test copy. The repository ships only an example manifest with blank URLs;
it does not distribute third-party audio. The preparation command must require
an explicit `--download` flag and place all generated media below a supplied
output directory that is gitignored.

## Manifest

Required columns:

```csv
id,role,speaker,condition,source_url,start_s,end_s,path
marques_enroll,enroll,marques,studio,https://...,10,35,
marques_test_1,test,marques,studio,https://...,60,85,
andrew_test_1,test,andrew,podcast,https://...,120,145,
```

- `role` is `enroll` or `test`.
- `speaker` is the ground-truth identity. Every test speaker must have at least
  one enrollment row; a test row may also deliberately name an unenrolled
  speaker to measure correct rejection.
- `condition` is an operator-defined label such as `studio`, `podcast`,
  `phone`, `noise`, or `reverb`.
- Either `path` must reference an existing local audio clip, or `source_url`,
  `start_s`, and `end_s` must be provided for preparation.

The first corpus should use separate source videos for enrollment and test:
single-speaker MKBHD clips establish a clean baseline; recurring participants
from WVFRM provide multi-speaker/cross-episode trials; operator-owned Korean
meeting recordings validate the target environment.

## Preparation flow

`prepare_speaker_eval.py` validates the manifest, invokes `yt-dlp` with an
exact URL, extracts only the declared time range, and normalizes it using the
worker's ffmpeg assumptions. It never discovers channel videos or selects
clips automatically. Existing output clips are skipped unless `--force` is
specified.

## Evaluation flow

1. Embed every enrollment clip and L2-normalize it. Each enrollment clip stays
   as an independent voiceprint; no production database is used.
2. Embed every test clip with the same adapter.
3. Compare each test embedding with every enrollment voiceprint by cosine
   similarity. Record top-1 predicted speaker, its score, the runner-up score,
   and the score margin.
4. For thresholds `0.45` through `0.85` in `0.05` increments, classify a trial
   as matched only when the top score meets the threshold.
5. Emit:
   - `trials.csv`: one row per test clip, with truth/prediction, score/margin,
     condition, and match status at the requested threshold.
   - `thresholds.csv`: overall and per-condition TP, FP, TN, FN, precision,
     recall, FAR, FRR, and top-1 accuracy for every swept threshold.
   - `report.md`: a compact recommended operating point and the worst
     conditions/speaker confusions.

An identity is correct only if the predicted speaker equals the manifest's
`speaker`. An unenrolled identity is correctly rejected only when no score
meets threshold. This prevents a high raw similarity from hiding an
impersonation error.

## Error handling

- Reject duplicate ids, unknown roles, non-positive ranges, missing source
  information, invalid/empty audio, and a test clip whose enrolled identity is
  absent unless it is explicitly marked as an unknown-speaker trial.
- Skip individual clips whose ECAPA embedding is unavailable, record the
  reason, and fail the command if no evaluable trials remain.
- Do not silently include mixed-speaker clips: the manifest author is
  responsible for choosing single-speaker enrollment/test intervals.

## Verification

Unit tests will cover CSV validation, cosine ranking, tie handling, threshold
classification, aggregate metrics, unknown-speaker rejection, and per-condition
summaries without loading real models. A separate manual smoke command will
run the evaluator on a local, permitted manifest with the real ECAPA model.
