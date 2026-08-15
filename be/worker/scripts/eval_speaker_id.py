"""Speaker-identification quality eval: measure cross-meeting speaker linking.

Reads the **live DB only** — no models, no audio. Every `meeting_cluster` row
already carries the ECAPA centroid that `identify_clusters` compares against, so
the whole identify policy can be replayed offline and scored against labels.

This is the instrument the shipped thresholds were set with — `IDENTIFY_THRESHOLD`
and `IDENTIFY_SUGGEST_THRESHOLD` in `be/.env`. Retune them here, not by feel.

Four report sections:

  health    Label-free pipeline hygiene: clusters with no utterance ("phantom"
            speakers minted from a noise segment), speakers stranded by a
            superseded processing_version, produced-vs-expected speaker counts.

  scoring   Pairwise verification quality of the embedding score itself, over
            labelled cluster pairs: same/different similarity distributions and
            EER per scoring variant. `raw` is what production does today;
            `centered` subtracts the corpus mean embedding first, which removes
            the shared-channel bias that compresses raw ECAPA cosine.

  halves    (--halves) Label-free threshold calibration. Re-embeds each cluster's
            speech as two alternating halves; the two halves of one cluster are a
            same-speaker pair by construction and every cross-cluster pair is a
            different-speaker one, so same/different distributions and an EER fall
            out with no labels at all. Both halves share a recording, which makes
            the same-speaker side optimistic — read the different-speaker max as
            the hard floor for auto-link. Needs the models extra and the meetings'
            normalized.wav on disk.

  policy    End-to-end replay of the real identify loop: walk meetings in
            chronological order and, for each cluster, either bind it to an
            already-known speaker (best similarity >= threshold) or mint a new
            one — exactly `identify_clusters` + the persist auto-provisional
            path. The resulting partition is scored against labels with pairwise
            precision/recall/F1 plus the produced speaker count. This is the
            headline number: it answers "would the same person in two meetings
            end up as one speaker".

Labels are a JSON object mapping `"<meeting_id>/<diar_label>"` to a person name.
Clusters absent from the file are excluded from `scoring`/`policy` (but still
counted in `health`), so a partial file is fine — label the meetings you know.

    {"mtg_2/SPEAKER_00": "narrator", "mtg_3/SPEAKER_00": "narrator"}

Usage:
    uv run python scripts/eval_speaker_id.py --labels scripts/eval_speaker_labels.json
    uv run python scripts/eval_speaker_id.py --thresholds 0.5,0.6,0.7,0.8 --json out.json
    uv run python scripts/eval_speaker_id.py --halves     # needs `uv sync --extra models`

Read-only: issues nothing but SELECTs. Safe against the working database.
NOT a CI test — it reports on whatever data the local DB happens to hold.
"""

import argparse
import json
import math
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import psycopg
from psycopg.rows import dict_row

# Production defaults are IDENTIFY_SUGGEST_THRESHOLD=0.6 / IDENTIFY_THRESHOLD=0.8
# (be/src/config/env.ts); the sweep brackets both ends of that band.
DEFAULT_THRESHOLDS = (0.5, 0.6, 0.7, 0.8, 0.9)
SCORINGS = ("raw", "centered")


# ---------------------------------------------------------------- data loading


def load_clusters(conn) -> list[dict]:
    """Current-version clusters with their centroid and how much they actually spoke.

    `meeting_cluster` is replaced wholesale per (re)process, so every row here is
    live; utterances are retained across versions, hence the version-matched join.
    """
    rows = conn.execute(
        """
        SELECT mc.id, mc.meeting_id, mc.diar_label, mc.processing_version,
               mc.centroid, mc.resolved_speaker_id,
               s.name AS speaker_name, s.enrollment_status,
               m.created_at,
               COALESCE(t.spoken_ms, 0) AS spoken_ms,
               COALESCE(t.n_utt, 0) AS n_utt,
               COALESCE(t.n_ok, 0) AS n_ok
        FROM meeting_cluster mc
        JOIN meeting m ON m.id = mc.meeting_id
        LEFT JOIN speaker s ON s.id = mc.resolved_speaker_id
        LEFT JOIN (
          SELECT meeting_id, processing_version, diar_label,
                 SUM(end_ms - start_ms) AS spoken_ms,
                 COUNT(*) AS n_utt,
                 COUNT(*) FILTER (WHERE status = 'ok') AS n_ok
          FROM utterance GROUP BY 1, 2, 3
        ) t ON t.meeting_id = mc.meeting_id
           AND t.processing_version = mc.processing_version
           AND t.diar_label = mc.diar_label
        ORDER BY m.created_at, mc.meeting_id, mc.diar_label
        """
    ).fetchall()
    for r in rows:
        r["key"] = f"{r['meeting_id']}/{r['diar_label']}"
        r["vec"] = parse_vector(r["centroid"]) if r["centroid"] is not None else None
    return rows


def load_speaker_health(conn) -> dict:
    return conn.execute(
        """
        WITH live AS (
          SELECT DISTINCT u.speaker_id AS id
            FROM utterance u
            JOIN meeting m ON m.id = u.meeting_id
                          AND m.processing_version = u.processing_version
           WHERE u.speaker_id IS NOT NULL
          UNION
          SELECT resolved_speaker_id FROM meeting_cluster
           WHERE resolved_speaker_id IS NOT NULL
        )
        SELECT (SELECT count(*) FROM speaker) AS total,
               (SELECT count(*) FROM speaker WHERE enrollment_status = 'ready') AS ready,
               (SELECT count(*) FROM speaker
                 WHERE enrollment_status = 'provisional') AS provisional,
               (SELECT count(*) FROM live) AS live,
               (SELECT count(*) FROM speaker s
                 WHERE NOT EXISTS (SELECT 1 FROM live WHERE live.id = s.id)) AS stranded
        """
    ).fetchone()


def parse_vector(raw) -> np.ndarray:
    # pgvector arrives as its text form '[a,b,...]' unless the psycopg adapter is
    # registered; this script deliberately avoids that dependency.
    if isinstance(raw, str):
        return np.fromstring(raw.strip("[]"), sep=",")
    return np.asarray(raw, dtype=float)


def unit(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    return x / np.where(n == 0, 1.0, n)


# ------------------------------------------------------------------- reporting


def report_health(clusters: list[dict], sp: dict, labels: dict[str, str]) -> dict:
    phantom = [c for c in clusters if c["n_ok"] == 0]
    no_centroid = [c for c in clusters if c["vec"] is None]
    per_meeting: dict[str, int] = defaultdict(int)
    for c in clusters:
        per_meeting[c["meeting_id"]] += 1

    print("== health ==")
    print(
        f"  speakers            total={sp['total']}  ready={sp['ready']}  "
        f"provisional={sp['provisional']}"
    )
    print(
        f"  stranded speakers   {sp['stranded']}/{sp['total']}"
        "   (referenced only by a superseded processing_version)"
    )
    print(
        f"  clusters            {len(clusters)} across {len(per_meeting)} meetings"
        f"   ({', '.join(f'{m}:{n}' for m, n in per_meeting.items())})"
    )
    print(
        f"  phantom clusters    {len(phantom)}"
        "   (0 transcribed utterances, yet minted a speaker + voiceprint)"
    )
    for c in phantom:
        print(
            f"      {c['key']:24s} spoken={c['spoken_ms'] / 1000:6.1f}s "
            f"utt={c['n_utt']} -> {c['speaker_name']}"
        )
    if no_centroid:
        print(
            f"  no centroid         {len(no_centroid)}"
            "   (never comparable — identification skips these)"
        )
    if labels:
        labelled = [c for c in clusters if c["key"] in labels]
        people = {labels[c["key"]] for c in labelled}
        print(
            f"  labelled            {len(labelled)}/{len(clusters)} clusters, "
            f"{len(people)} distinct people"
        )
    return {
        "speakers": dict(sp),
        "clusters": len(clusters),
        "phantom_clusters": [c["key"] for c in phantom],
        "no_centroid": [c["key"] for c in no_centroid],
    }


def pair_scores(vecs: dict[str, np.ndarray], labels: dict[str, str]):
    """All labelled cluster pairs, split into same-person and different-person."""
    keys = sorted(k for k in vecs if k in labels)
    same, diff = [], []
    for i, a in enumerate(keys):
        for b in keys[i + 1 :]:
            s = float(vecs[a] @ vecs[b])
            (same if labels[a] == labels[b] else diff).append((s, a, b))
    return same, diff


def eer(same: list, diff: list) -> tuple[float, float]:
    """Equal error rate and the threshold achieving it. (nan, nan) if unscorable."""
    if not same or not diff:
        return math.nan, math.nan
    cands = sorted({s for s, _, _ in same} | {s for s, _, _ in diff})
    best = (math.inf, math.nan, math.nan)
    for t in cands:
        fnr = sum(1 for s, _, _ in same if s < t) / len(same)  # missed matches
        fpr = sum(1 for s, _, _ in diff if s >= t) / len(diff)  # wrong merges
        gap = abs(fnr - fpr)
        if gap < best[0]:
            best = (gap, (fnr + fpr) / 2, t)
    return best[1], best[2]


# ------------------------------------------------------- half-split calibration


def load_label_spans(conn, cap_s: float, chunk_s: float = 10.0) -> dict[str, list[tuple[int, int]]]:
    """Per current-version diar label, its transcribed speech cut into equal chunks.

    Chunking matters: one cluster here is a single 245s utterance, and alternating
    over *utterances* would hand one half everything and the other nothing. Equal
    chunks make the two halves comparable in size and spread across the session
    for every cluster, whatever its utterance granularity.
    """
    rows = conn.execute(
        """
        SELECT u.meeting_id, u.diar_label, u.start_ms, u.end_ms
        FROM utterance u
        JOIN meeting m ON m.id = u.meeting_id
                      AND m.processing_version = u.processing_version
        WHERE u.status = 'ok' AND u.end_ms > u.start_ms
        ORDER BY u.meeting_id, u.diar_label, u.start_ms
        """
    ).fetchall()
    chunk_ms = int(chunk_s * 1000)
    spans: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for r in rows:
        key = f"{r['meeting_id']}/{r['diar_label']}"
        for t in range(r["start_ms"], r["end_ms"], chunk_ms):
            end = min(t + chunk_ms, r["end_ms"])
            if end - t >= chunk_ms // 2:  # drop a stub tail — too short to embed well
                spans[key].append((t, end))

    # Subsample evenly (not head-first) so the cap keeps sampling the whole meeting.
    out = {}
    for key, ss in spans.items():
        budget = max(1, int(cap_s * 1000 // chunk_ms))
        if len(ss) > budget:
            step = len(ss) / budget
            ss = [ss[int(i * step)] for i in range(budget)]
        out[key] = ss
    return out


def embed_halves(
    spans: dict[str, list[tuple[int, int]]], wav_of: dict[str, str], embedder, min_half_s: float
) -> dict[str, np.ndarray]:
    """Embed each label's odd- and even-indexed spans as two independent centroids.

    Alternating (not chronological) so both halves span the whole meeting — a
    time-based split would confound speaker identity with drift in the recording.
    The two halves of one label are a genuine same-speaker pair needing no labels;
    they share a session, so their similarity is an **optimistic** bound on true
    cross-meeting matching, and a useful upper limit for where auto-link may sit.
    """
    from damwha_worker.models.base import DiarSegment

    out: dict[str, np.ndarray] = {}
    for key in sorted(spans):
        ss = spans[key]
        meeting = key.split("/")[0]
        halves = {"h1": ss[0::2], "h2": ss[1::2]}
        if min(sum(e - s for s, e in h) for h in halves.values()) < min_half_s * 1000:
            continue
        for tag, part in halves.items():
            segs = [DiarSegment(key, s, e) for s, e in part]
            embs = [e for e in embedder.embed(wav_of[meeting], segs) if e is not None]
            if not embs:
                continue
            out[f"{key}#{tag}"] = unit(np.mean(np.array(embs), axis=0))
    return out


def report_halves(
    halves: dict[str, np.ndarray], thresholds: tuple[float, ...], labels: dict[str, str]
) -> dict:
    """Same/different distributions from half-splits — the threshold instrument."""
    keys = sorted(halves)
    same, diff = [], []
    for i, a in enumerate(keys):
        for b in keys[i + 1 :]:
            s = float(halves[a] @ halves[b])
            ca, cb = a.split("#")[0], b.split("#")[0]
            # Two halves of one cluster are the same speaker by construction; across
            # clusters, believe a label when there is one, else assume different.
            is_same = ca == cb or (ca in labels and cb in labels and labels[ca] == labels[cb])
            (same if is_same else diff).append((s, a, b))

    print("\n== half-split calibration ==")
    print(f"  {len(keys)} half-centroids from {len(keys) // 2} clusters")
    if not same or not diff:
        print("  unscorable — need at least 2 clusters with enough speech")
        return {}
    ss = sorted(s for s, _, _ in same)
    ds = sorted(s for s, _, _ in diff)
    e, t = eer(same, diff)
    print(
        f"  same-speaker  n={len(ss):3d} min={ss[0]:+.3f} p10={np.percentile(ss, 10):+.3f} "
        f"median={np.median(ss):+.3f} max={ss[-1]:+.3f}"
    )
    print(
        f"  diff-speaker  n={len(ds):3d} min={ds[0]:+.3f} p90={np.percentile(ds, 90):+.3f} "
        f"median={np.median(ds):+.3f} max={ds[-1]:+.3f}"
    )
    print(f"  EER={e * 100:5.1f}% @ thr={t:+.3f}   separation margin={ss[0] - ds[-1]:+.3f}")
    print(f"  {'thr':>6s} {'false-merge':>12s} {'missed-match':>13s}")
    for thr in sorted({*thresholds, round(float(ds[-1]), 2), round(float(ss[0]), 2)}):
        fp = sum(1 for s in ds if s >= thr)
        fn = sum(1 for s in ss if s < thr)
        print(f"  {thr:6.2f} {fp:>5d}/{len(ds):<6d} {fn:>6d}/{len(ss):<6d}")
    worst = max(diff)
    print(f"  worst different-speaker pair: {worst[1]} ~ {worst[2]} = {worst[0]:+.3f}")
    print("  NOTE: both halves share one recording, so same-speaker scores here are")
    print("        optimistic vs a genuine cross-meeting match. Read the diff-speaker")
    print("        max as the hard floor for auto-link; treat same-speaker min as a ceiling.")
    return {
        "n_clusters": len(keys) // 2,
        "same": {"n": len(ss), "min": ss[0], "median": float(np.median(ss))},
        "diff": {"n": len(ds), "max": ds[-1], "median": float(np.median(ds))},
        "eer": e,
        "eer_threshold": t,
        "worst_diff_pair": {"pair": [worst[1], worst[2]], "score": worst[0]},
    }


def report_scoring(variants: dict[str, dict[str, np.ndarray]], labels: dict[str, str]) -> dict:
    print("\n== scoring ==")
    if not labels:
        print("  (skipped — no --labels file)")
        return {}
    out = {}
    for name, vecs in variants.items():
        same, diff = pair_scores(vecs, labels)
        if not same or not diff:
            print(
                f"  {name:10s} unscorable (same={len(same)} diff={len(diff)} pairs) — "
                "labels need at least one same-person and one different-person pair"
            )
            continue
        e, t = eer(same, diff)
        ss = [s for s, _, _ in same]
        ds = [s for s, _, _ in diff]
        margin = min(ss) - max(ds)
        print(
            f"  {name:10s} same n={len(ss):3d} min={min(ss):+.3f} mean={np.mean(ss):+.3f}"
            f"   diff n={len(ds):3d} max={max(ds):+.3f} mean={np.mean(ds):+.3f}"
        )
        print(
            f"  {'':10s} EER={e * 100:5.1f}% @ thr={t:+.3f}   "
            f"separation margin={margin:+.3f}"
            f"   {'(separable)' if margin > 0 else '(OVERLAP — no threshold works)'}"
        )
        worst = max(diff)
        print(f"  {'':10s} worst false-merge pair: {worst[1]} ~ {worst[2]} = {worst[0]:+.3f}")
        out[name] = {
            "eer": e,
            "eer_threshold": t,
            "margin": margin,
            "same": {"n": len(ss), "min": min(ss), "mean": float(np.mean(ss))},
            "diff": {"n": len(ds), "max": max(ds), "mean": float(np.mean(ds))},
            "worst_false_merge": {"pair": [worst[1], worst[2]], "score": worst[0]},
        }
    return out


def replay(
    clusters: list[dict],
    vecs: dict[str, np.ndarray],
    threshold: float,
    *,
    link_provisional: bool,
    intra_meeting_merge: bool = False,
) -> dict[str, str]:
    """Replay identify + auto-provisional over meetings in chronological order.

    Faithful to the pipeline's ordering: `identify_clusters` scores **every**
    cluster of a meeting against the voiceprint table as it stood *before* that
    meeting, and only then does `persist` mint speakers for the unmatched ones.
    So two clusters of one meeting can never match each other — the meeting is
    processed as a batch, and new voiceprints land only at the meeting boundary.

    `link_provisional=False` reproduces production today: auto-created speakers
    stay `provisional` and `identify_clusters` filters on
    `enrollment_status='ready'`, so nothing is ever matchable and every cluster
    mints a fresh speaker. `intra_meeting_merge=True` models the extra step the
    pipeline does *not* have: collapsing this meeting's own look-alike clusters
    before minting.
    """
    enrolled: list[tuple[str, np.ndarray]] = []  # (speaker, voiceprint) matchable set
    assignment: dict[str, str] = {}
    next_id = 0

    by_meeting: dict[str, list[dict]] = defaultdict(list)
    for c in clusters:  # already ordered by meeting.created_at
        if vecs.get(c["key"]) is not None:
            by_meeting[c["meeting_id"]].append(c)

    for batch in by_meeting.values():
        minted: list[tuple[str, np.ndarray]] = []  # this meeting's new speakers
        for c in batch:
            v = vecs[c["key"]]
            # Known speakers first; a match there beats reusing a same-meeting mint.
            pool = enrolled + (minted if intra_meeting_merge else [])
            best_sid, best_sim = None, -math.inf
            for sid, ref in pool:
                s = float(v @ ref)
                if s > best_sim:
                    best_sid, best_sim = sid, s
            if best_sid is not None and best_sim >= threshold:
                assignment[c["key"]] = best_sid
            else:
                next_id += 1
                sid = f"auto_{next_id:03d}"
                assignment[c["key"]] = sid
                minted.append((sid, v))
        if link_provisional:
            enrolled.extend(minted)
    return assignment


def pairwise_prf(assignment: dict[str, str], labels: dict[str, str]) -> tuple[float, float, float]:
    """Pairwise precision/recall/F1 over labelled clusters.

    A "pair" is two clusters the system put under one speaker (predicted) or that
    the labels say are one person (true). Standard clustering metric; degenerate
    solutions score badly at both ends — one-speaker-for-everything tanks
    precision, one-speaker-per-cluster tanks recall.
    """
    keys = sorted(k for k in assignment if k in labels)
    tp = fp = fn = 0
    for i, a in enumerate(keys):
        for b in keys[i + 1 :]:
            pred = assignment[a] == assignment[b]
            true = labels[a] == labels[b]
            tp += pred and true
            fp += pred and not true
            fn += not pred and true
    p = tp / (tp + fp) if tp + fp else 1.0
    r = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f1


def report_policy(
    clusters: list[dict],
    variants: dict[str, dict[str, np.ndarray]],
    labels: dict[str, str],
    thresholds: tuple[float, ...],
) -> dict:
    print("\n== policy (end-to-end replay) ==")
    n_true = len({labels[c["key"]] for c in clusters if c["key"] in labels}) if labels else 0
    n_cl = sum(1 for c in clusters if c["vec"] is not None)
    if labels:
        print(f"  ground truth: {n_true} people over {len(labels)} labelled clusters")
    print(f"  {'policy':52s} {'speakers':>8s} {'prec':>6s} {'rec':>6s} {'F1':>6s}")

    # (link_provisional, intra_meeting_merge, label). The first is what production
    # did before migration 018; the second is what it does now. The suggestion band
    # is absent here on purpose: a banded cluster still mints its own speaker, so it
    # cannot change the partition — only `threshold` moves these numbers.
    modes = [
        (False, False, "ready-only (pre-018)"),
        (True, False, "link-provisional (shipped)"),
        (True, True, "link-provisional+merge (RC3)"),
    ]
    out = []
    for scoring, vecs in variants.items():
        for link, merge, mode in modes:
            for thr in thresholds:
                if not link and thr != thresholds[0]:
                    continue  # production never matches; threshold is irrelevant
                a = replay(clusters, vecs, thr, link_provisional=link, intra_meeting_merge=merge)
                n_produced = len(set(a.values()))
                tag = f"{scoring}/{mode}" + ("" if not link else f" thr={thr:.2f}")
                if labels:
                    p, r, f1 = pairwise_prf(a, labels)
                    print(f"  {tag:52s} {n_produced:8d} {p:6.3f} {r:6.3f} {f1:6.3f}")
                else:
                    p = r = f1 = math.nan
                    print(f"  {tag:52s} {n_produced:8d} {'—':>6s} {'—':>6s} {'—':>6s}")
                out.append(
                    {
                        "scoring": scoring,
                        "link_provisional": link,
                        "intra_meeting_merge": merge,
                        "threshold": None if not link else thr,
                        "speakers_produced": n_produced,
                        "precision": p,
                        "recall": r,
                        "f1": f1,
                    }
                )
    if labels:
        print(f"  {'ideal':52s} {n_true:8d} {1.0:6.3f} {1.0:6.3f} {1.0:6.3f}")
    print(f"  ({n_cl} clusters with a centroid feed the replay)")
    return {"true_speakers": n_true, "runs": out}


# ------------------------------------------------------------------------ main


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--database-url", default=os.environ.get("DATABASE_URL"), help="defaults to $DATABASE_URL"
    )
    ap.add_argument("--labels", type=Path, help="JSON: {'<meeting>/<diar_label>': '<person>'}")
    ap.add_argument("--thresholds", default=",".join(str(t) for t in DEFAULT_THRESHOLDS))
    ap.add_argument("--json", type=Path, help="also write the full report here")
    ap.add_argument(
        "--halves",
        action="store_true",
        help="re-embed each cluster's speech in two alternating halves to measure "
        "same/different-speaker score distributions without labels "
        "(needs the models extra + the meetings' normalized.wav on disk)",
    )
    ap.add_argument(
        "--halves-cap-s",
        type=float,
        default=180.0,
        help="max speech per cluster fed to --halves (default 180)",
    )
    ap.add_argument(
        "--halves-min-half-s",
        type=float,
        default=15.0,
        help="skip clusters whose smaller half is below this (default 15)",
    )
    ap.add_argument(
        "--storage-root",
        type=Path,
        default=Path("../storage"),
        help="STORAGE_ROOT for --halves (default ../storage)",
    )
    args = ap.parse_args()

    if not args.database_url:
        print("DATABASE_URL not set (env or --database-url)", file=sys.stderr)
        return 2
    thresholds = tuple(float(t) for t in args.thresholds.split(","))
    # '_'-prefixed keys are the file's own notes (JSON has no comment syntax).
    labels: dict[str, str] = {
        k: v
        for k, v in (json.loads(args.labels.read_text()) if args.labels else {}).items()
        if not k.startswith("_")
    }

    with psycopg.connect(args.database_url, row_factory=dict_row) as conn:
        clusters = load_clusters(conn)
        sp = load_speaker_health(conn)
        spans = load_label_spans(conn, args.halves_cap_s) if args.halves else {}
        wav_of = (
            {
                r["id"]: str(args.storage_root / r["normalized_key"])
                for r in conn.execute(
                    "SELECT id, normalized_key FROM meeting WHERE normalized_key IS NOT NULL"
                ).fetchall()
            }
            if args.halves
            else {}
        )

    if not clusters:
        print("no meeting_cluster rows — process a meeting first", file=sys.stderr)
        return 2

    keys = [c["key"] for c in clusters if c["vec"] is not None]
    X = unit(np.array([c["vec"] for c in clusters if c["vec"] is not None]))
    mean = X.mean(axis=0)
    variants = {
        "raw": dict(zip(keys, X, strict=True)),
        "centered": dict(zip(keys, unit(X - mean), strict=True)),
    }

    unknown = sorted(set(labels) - set(keys))
    if unknown:
        print(
            f"warning: {len(unknown)} labelled key(s) have no current cluster: "
            f"{', '.join(unknown[:5])}{' ...' if len(unknown) > 5 else ''}\n",
            file=sys.stderr,
        )

    report = {"health": report_health(clusters, sp, labels)}
    print(
        f"\n  corpus mean-embedding norm = {np.linalg.norm(mean):.3f}"
        "   (0 = no shared bias; high = raw cosine is inflated for every pair)"
    )
    report["scoring"] = report_scoring(variants, labels)
    if args.halves:
        from damwha_worker.models.ecapa_embed import EcapaEmbedder

        missing = [
            m for m in {k.split("/")[0] for k in spans} if not Path(wav_of.get(m, "")).is_file()
        ]
        if missing:
            print(
                f"--halves: normalized.wav missing for {', '.join(missing)} "
                f"(looked under {args.storage_root})",
                file=sys.stderr,
            )
        embedder = EcapaEmbedder("speechbrain/spkrec-ecapa-voxceleb", "cpu")
        spans = {k: v for k, v in spans.items() if Path(wav_of.get(k.split("/")[0], "")).is_file()}
        # Drop re-uploads of an identical recording: their halves are bit-identical,
        # so they would plant a 1.000 into whichever distribution they land in.
        raw_vecs = variants["raw"]
        dupes, seen = [], []
        for k in sorted(spans):
            v = raw_vecs.get(k)
            if v is not None and any(float(v @ raw_vecs[s]) > 0.9999 for s in seen):
                dupes.append(k)
            elif v is not None:
                seen.append(k)
        for k in dupes:
            del spans[k]
        if dupes:
            print(
                f"  --halves: skipping {len(dupes)} duplicate-audio cluster(s): {', '.join(dupes)}"
            )
        report["halves"] = report_halves(
            embed_halves(spans, wav_of, embedder, args.halves_min_half_s), thresholds, labels
        )
    report["policy"] = report_policy(clusters, variants, labels, thresholds)

    if args.json:
        args.json.write_text(json.dumps(report, indent=2, default=float))
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
