#!/usr/bin/env python3
"""Task 7 — 실제 음성 처리 파이프라인 드라이버 (스펙 P0-C4).

번들 런타임 안에서 `damwha_worker` 의 `run_once` 경로를 그대로 호출해
ffmpeg normalize/probe → Silero VAD → pyannote diarization → ECAPA 임베딩 →
Whisper STT → align → persist 를 한 번 돌린다.

실행 (계획 Task 7 V2):

    bash experiments/electron-phase-0/lib/run-isolated.sh --label t7-pipeline -- \
      experiments/electron-phase-0/bundle/python/bin/python3 \
      experiments/electron-phase-0/drivers/process_meeting_driver.py

## smoke 스크립트를 쓰지 않는 이유

`be/worker/scripts/smoke_process_meeting.py` 는 `PostgresContainer(...)` 로
**컨테이너 런타임을 띄운다** — Phase 0 이 제거하려는 바로 그 의존이고, 그
컨테이너 라이브러리는 `dev` 의존성 그룹이라 `models` extra 만 담은 번들에
존재하지도 않는다 (스펙 P0-C4). 그 파일은 **읽기 참조 전용이며 실행하지도
수정하지도 않았다.** 여기서 참고한 것은 페이로드의 모양과 시드 순서(회의 →
audio_key → job → current_job_id)뿐이다.

**그 런타임과 라이브러리의 이름을 이 파일 어디에도 적지 않는다** — 주석과 이
설명문을 포함해서다. 계획 Task 7 의 V9 가 이 파일에서 두 이름의 리터럴 등장
줄 수를 세어 0 을 요구하는데, 그 검사는 코드와 설명문을 구분하지 못하고
대소문자도 무시한다. 즉 여기 설명을 다시 쓰면서 이름을 한 번만 적어도 V9 가
깨진다. **V9 스크립트의 파일 이름 자체에도 그 낱말이 들어 있으므로 그 경로를
여기 적어서도 안 된다** — 실제로 그렇게 한 번 깨뜨렸다. 뜻은 위 문단이 그대로
담고 있고, 검사 쪽 사정은 `experiments/electron-phase-0/verify/` 의 V9
스크립트 머리말에 적혀 있다.

## 격리에서의 위치

이 드라이버는 **격리 대상이다** (스펙 P0-C4 "드라이버 스크립트는 번들 런타임
안에서 실행되므로 격리 대상이다 — 클라이언트 예외가 아니다"). Task 6 의
seed_search.py 와 다른 점이 여기다.

## 서비스 기동·정지 책임 (계획 Task 7 Interfaces)

시작 시점에 번들 PostgreSQL(55432)이 **정지 상태**라고 가정하고 이 드라이버가
직접 띄운다. 정지는 Verify 끝의 `verify/t7-stop.sh` 가 PID 파일 대상으로 한다.
embed 서비스와 mlx_lm.server 는 이 Task 가 쓰지 않는다 — 후속 job(index_meeting
/ extract_lenses / summarize_meeting)을 큐잉하지 않기 때문이다(아래 payload 주석).

## ffmpeg 를 어떻게 찾게 하는가

`be/worker/damwha_worker/pipeline/ffmpeg.py` 는 `subprocess.run(["ffmpeg", ...])`
처럼 **이름으로** 부른다. 격리 PATH(`/usr/bin:/bin:/usr/sbin:/sbin`)에는 ffmpeg
가 없으므로, 제품 코드를 고치지 않고 번들 ffmpeg 를 쓰게 하는 방법은 이 프로세스
의 PATH 앞에 **번들 안 디렉터리 하나**를 붙이는 것뿐이다. 추가하는 값은 번들
내부 절대 경로이며(스펙 §4.2 의 LENS_LLM_SERVER_BIN 과 같은 성격), Phase 4 의
Electron 메인 프로세스도 같은 일을 해야 한다. 붙인 값과 `shutil.which()` 결과를
증거에 남긴다.

**주의 — 파이프라인이 부른 ffmpeg/ffprobe 는 dyld 증거에 나오지 않는다.**
`pipeline/ffmpeg.py::_run` 이 `capture_output=True` 로 자식의 stderr 를
파이프로 가져가므로, `DYLD_PRINT_LIBRARIES=1` 이 찍은 줄이 래퍼의 fd 2 에
도달하지 못한다(실측 확인). 그래서 이 드라이버가 파이프라인 뒤에 ffprobe 를
**stderr 를 물려준 채로** 한 번 더 불러 dyld 실측을 남긴다. 그 실행이 확인하는
것은 "번들 ffprobe 가 번들 안 이미지만 열고 돈다"이고, 파이프라인이 같은
바이너리를 썼다는 것은 같은 PATH·같은 프로세스에서 잰 `shutil.which()` 값이
확인한다.

## 스키마 (be/src/database/migrations)

- `utterance` 에 `speaker_cluster_id` 같은 컬럼은 **없다.** 화자 분리 결과는
  `diar_label` 이다 (001_init.sql:72). UNIQUE 는 013 이후
  (meeting_id, processing_version, order_index) 다.
- `meeting.audio_key` 는 NOT NULL, `recorded_at` 은 021에서 NOT NULL 이 됐다.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

DRIVER = Path(__file__).resolve()
EXP_ROOT = DRIVER.parents[1]
REPO_ROOT = DRIVER.parents[3]
EVIDENCE = REPO_ROOT / "docs/superpowers/reports/evidence/phase-0"

PG_RUN = EXP_ROOT / "pg/run.sh"
BUNDLE_FFMPEG_BIN = EXP_ROOT / "bundle/ffmpeg/bin"
SAMPLE_AUDIO = EXP_ROOT / "sandbox/audio/sample.flac"

WORKER_ID = "t7-driver"

# Task 6 의 `mtg_1` 과 구분되는 이 Task 의 회의다. 재실행이 멱등하려면(스펙 §4.4)
# 같은 회의를 다시 써야 하고, 그래야 $EVIDENCE/t7-meeting-id.txt 의 id 가 회차마다
# 바뀌지 않는다.
MEETING_TITLE = "Phase 0 Task 7 실제 음성 처리 파이프라인"
PROCESSING_VERSION = 0

# --- payload -----------------------------------------------------------------
# 모델 선택은 payload 의 책임이다(models/registry.py 주석). 아래 값의 근거:
#
# * `diarization.model = pyannote/speaker-diarization-community-1`
#   **제품의 기본값이다** (`be/src/config/env.ts:18`, `be/.env:9`). smoke 스크립트
#   payload 에 남아 있는 `speaker-diarization-3.1` 은 쓰지 않는다 — 같은 파일
#   13~17줄이 "설치된 pyannote.audio 4.x 아래에서 3.1 은 클러스터링이 모든 화자를
#   한 라벨로 뭉갠다(mtg_5 실측)"고 기록해 두었다. 그 상태로는 diarization 이
#   실제로 돌았는지가 결과에서 구분되지 않는다.
# * `whisper_model = large-v3-turbo`, `devices.stt = gpu`
#   제품 기본값이다 (`be/.env:6-7` WHISPER_MODEL / WHISPER_DEVICE=mps).
#   `devices.stt` 가 gpu 면 registry 가 mlx-whisper 를, cpu 면 faster-whisper 를
#   고른다. Phase 4 가 담아야 하는 Apple GPU 경로는 전자이므로 gpu 를 쓴다.
#   내려받는 가중치는 mlx-community/whisper-large-v3-turbo 1,614 MB 로, 이 Task
#   가 필요로 하는 디스크 총량(약 2 GiB) 안에서 가장 큰 항목이다.
# * `embedding` = speechbrain/spkrec-ecapa-voxceleb / 192 — 제품 기본값
#   (`be/src/config/env.ts:19-20`).
# * `identify` 임계값은 `be/src/config/env.ts:27-28` 의 기본값(0.8 / 0.6)이다.
#   `be/.env:12` 의 0.70 이 아니라 스키마 기본값을 쓰는 이유는 smoke payload 와
#   같은 값을 유지해 재현 조건을 하나로 두기 위해서다. 정확도는 판정 대상이
#   아니다 (스펙 P0-C4 비고).
# * `schema_version = 5`, `followups = {lens: false, summary: false}`
#   v5 가 후속 job 스위치를 실었다(contracts.py FollowupsWireV5). 둘 다 끄는
#   이유는 둘이다. (1) 이 Task 의 확인 대상은 process_meeting 하나이고 embed·LLM
#   서비스를 쓰지 않는다(계획 Task 7 Interfaces). (2) 켜 두면 persist 가
#   extract_lenses / summarize_meeting job 을 queued 로 남기는데, 다음 회차의
#   `db.claim` 이 그것을 먼저 집어 재실행이 멱등하지 않게 된다 (스펙 §4.4).
#   index_meeting 은 `run_once` 가 search_embedding 을 (None, None) 로 두므로
#   애초에 큐잉되지 않는다.
DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"
WHISPER_MODEL = "large-v3-turbo"
EMBEDDING_MODEL = "speechbrain/spkrec-ecapa-voxceleb"
EMBEDDING_DIM = 192


def build_payload(meeting_id: str, audio_key: str) -> dict:
    return {
        "schema_version": 5,
        "meeting_id": meeting_id,
        "audio_key": audio_key,
        "processing_version": PROCESSING_VERSION,
        "reprocess": False,
        "models": {
            "whisper_model": WHISPER_MODEL,
            "language": "ko",
            "devices": {"diarization": "gpu", "stt": "gpu"},
            "preset": "standard",
            "preset_revision": None,
            "summary_model": "mlx-community/Qwen3.5-4B-8bit",
            "diarization": {
                "model": DIARIZATION_MODEL,
                "min_speakers": None,
                "max_speakers": None,
            },
            "embedding": {"model": EMBEDDING_MODEL, "dimension": EMBEDDING_DIM},
        },
        "identify": {"threshold": 0.8, "suggest_threshold": 0.6},
        "followups": {"lens": False, "summary": False},
    }


# --- 출력 --------------------------------------------------------------------
def log(msg: str = "") -> None:
    print(msg, flush=True)


def die(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def utcnow() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_evidence(name: str, body: str) -> Path:
    """증거 파일을 덮어쓰지 않는다 (스펙 §6).

    내용이 **다를 때만** 옆으로 돌린다 — seed_search.py 와 같은 규칙이다.
    t7-meeting-id.txt 처럼 값이 고정된 파일을 회차마다 prev-*.txt 로 불리지
    않기 위해서다.
    """
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    path = EVIDENCE / name
    if path.exists():
        if path.read_text(encoding="utf-8") == body:
            return path
        stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path.rename(path.with_name(f"{path.stem}.prev-{stamp}{path.suffix}"))
    path.write_text(body, encoding="utf-8")
    return path


# --- 환경 점검 (스펙 §4.2) ----------------------------------------------------
def check_env() -> dict:
    """주입된 값이 전부 샌드박스/실험 포트를 가리키는지 본다.

    HF_TOKEN 은 **set/unset 만** 본다. 값은 어떤 경로로도 stdout·증거에 나가지
    않는다 (스펙 §4.2).
    """
    dsn = os.environ.get("DATABASE_URL", "")
    if ":55432/" not in dsn:
        die(f"DATABASE_URL 이 실험 포트 55432 가 아니다: {dsn!r} — 개발 DB(5432)에 쓰지 않는다")

    storage_root = os.environ.get("STORAGE_ROOT", "")
    sandbox = str(EXP_ROOT / "sandbox")
    if not storage_root.startswith(sandbox):
        die(f"STORAGE_ROOT 가 샌드박스 밖이다: {storage_root!r} — be/storage 원본에 쓰지 않는다")

    hf_home = os.environ.get("HF_HOME", "")
    if not hf_home.startswith(sandbox):
        die(
            f"HF_HOME 이 샌드박스 밖이다: {hf_home!r} — 개발자 캐시(~/.cache/huggingface)를 "
            "재사용하면 '게이트 모델을 새로 받았다'가 성립하지 않는다"
        )

    home = os.environ.get("HOME", "")
    if not home.startswith(sandbox):
        die(f"HOME 이 샌드박스 밖이다: {home!r}")

    if not os.environ.get("HF_TOKEN"):
        die("HF_TOKEN 이 없다 — 게이트 모델을 받지 못한다 (스펙 §4.2, R-6)")

    return {"dsn": dsn, "storage_root": storage_root, "hf_home": hf_home, "home": home}


def prepend_bundle_ffmpeg() -> dict:
    """번들 ffmpeg 디렉터리를 PATH 맨 앞에 붙이고 해석 결과를 돌려준다."""
    if not (BUNDLE_FFMPEG_BIN / "ffmpeg").is_file():
        die(f"번들 ffmpeg 가 없다: {BUNDLE_FFMPEG_BIN} — ffmpeg/fetch.sh 를 먼저 돌려라")
    before = os.environ.get("PATH", "")
    os.environ["PATH"] = f"{BUNDLE_FFMPEG_BIN}:{before}"
    return {
        "path_before": before,
        "path_after": os.environ["PATH"],
        "ffmpeg": shutil.which("ffmpeg") or "",
        "ffprobe": shutil.which("ffprobe") or "",
    }


# --- HF 캐시 스냅샷 (P0-C4 "새로 내려받아 사용했다") --------------------------
def hub_repos(hf_home: str) -> set[str]:
    hub = Path(hf_home) / "hub"
    if not hub.is_dir():
        return set()
    return {p.name for p in hub.iterdir() if p.name.startswith("models--")}


def hub_bytes(hf_home: str, repo_dir: str) -> int:
    root = Path(hf_home) / "hub" / repo_dir
    if not root.is_dir():
        return 0
    total = 0
    for p in root.rglob("*"):
        # 심볼릭 링크(snapshots/)는 blobs/ 를 가리킨다 — 두 번 세지 않는다.
        if p.is_file() and not p.is_symlink():
            total += p.stat().st_size
    return total


# --- 서비스 -------------------------------------------------------------------
def db_reachable(dsn: str) -> bool:
    import psycopg

    try:
        with psycopg.connect(dsn, connect_timeout=3) as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:
        return False


def ensure_db(dsn: str) -> str:
    """번들 PostgreSQL 을 이 드라이버가 직접 띄운다 (계획 Task 7 Interfaces).

    런처의 stderr 는 잡지 않는다 — 계획 "런처 스크립트의 dyld 실측 규칙" 2 가
    금지하는 형태를 만들지 않기 위해서고, 그래서 서버 기동 시점의 dyld 줄이
    이 실행의 t7-pipeline-dyld.txt 로 들어온다.
    """
    if db_reachable(dsn):
        return "db: 이미 떠 있음 (이 드라이버가 띄우지 않았다)"
    log(f"  기동: {PG_RUN} start")
    rc = subprocess.call(["/bin/bash", str(PG_RUN), "start"])
    if rc != 0:
        die(f"{PG_RUN} start 가 exit {rc} 로 끝났다")
    if not db_reachable(dsn):
        die(f"DB 에 접속하지 못했다: {dsn}")
    return "db: 이 드라이버가 기동"


# --- 시드 ---------------------------------------------------------------------
def seed(conn, storage) -> tuple[str, str, dict, dict]:
    """회의 + queued job 을 만든다. 페이로드 모양과 순서는 smoke 스크립트 참고."""
    notes: dict = {}

    row = conn.execute("SELECT id FROM meeting WHERE title = %s", (MEETING_TITLE,)).fetchone()
    if row:
        meeting_id = row["id"]
        notes["meeting"] = f"기존 회의 재사용: {meeting_id} (재실행 멱등 — 스펙 §4.4)"
        # 이전 회차의 결과를 지운다. 013 이후 UNIQUE 가
        # (meeting_id, processing_version, order_index) 라 같은 버전으로 다시
        # 넣으려면 먼저 비워야 한다. 삭제 범위는 **이 회의**뿐이다 — Task 6 의
        # mtg_1 은 건드리지 않는다.
        n_utt = conn.execute(
            "DELETE FROM utterance WHERE meeting_id = %s", (meeting_id,)
        ).rowcount
        n_clu = conn.execute(
            "DELETE FROM meeting_cluster WHERE meeting_id = %s", (meeting_id,)
        ).rowcount
        # 그 결과로 고아가 된 provisional 화자를 지운다. 조건은
        # db/meetings.py::persist_process_meeting 의 GC 와 **같은 SQL** 이다 —
        # 재처리가 제품에서 하는 정리를 그대로 앞당긴 것이고, 'ready'(확정)
        # 화자는 어느 조건으로도 지워지지 않는다.
        n_spk = conn.execute(
            """
            DELETE FROM speaker s
            WHERE s.enrollment_status='provisional'
              AND NOT EXISTS (SELECT 1 FROM utterance WHERE speaker_id = s.id)
              AND NOT EXISTS (SELECT 1 FROM meeting_cluster WHERE resolved_speaker_id = s.id)
              AND NOT EXISTS (SELECT 1 FROM meeting_cluster WHERE suggested_speaker_id = s.id)
            """
        ).rowcount
        notes["reset"] = f"이전 회차 정리: utterance {n_utt}건, cluster {n_clu}건, provisional 화자 {n_spk}건"
    else:
        meeting_id = conn.execute(
            """
            INSERT INTO meeting (title, original_filename, audio_key, recorded_at,
                                 status, processing_version)
            VALUES (%s, %s, '', now(), 'uploaded', %s)
            RETURNING id
            """,
            (MEETING_TITLE, SAMPLE_AUDIO.name, PROCESSING_VERSION),
        ).fetchone()["id"]
        notes["meeting"] = f"회의 생성: {meeting_id}"

    audio_key = f"meetings/{meeting_id}/original{SAMPLE_AUDIO.suffix.lower()}"
    dst = Path(storage.resolve(audio_key))
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.is_file() and dst.stat().st_size == SAMPLE_AUDIO.stat().st_size:
        notes["audio"] = f"오디오 사본 재사용: {audio_key} ({dst.stat().st_size} bytes)"
    else:
        # 원본이 아니라 Task 1 이 be/storage 에서 복사해 둔 샌드박스 사본을
        # 다시 복사한다. be/storage 경로는 이 드라이버 어디에도 없다 (스펙 §4.4).
        shutil.copyfile(SAMPLE_AUDIO, dst)
        notes["audio"] = f"오디오 복사: {SAMPLE_AUDIO} → {audio_key} ({dst.stat().st_size} bytes)"

    # 이전 회차가 남긴 normalized.flac 은 지운다. run_process_meeting 은 있으면
    # 재사용(reused=1)하는데, 그러면 normalize 단계가 실제로 돌았는지가 이번
    # 회차의 증거에서 사라진다 (P0-C4 는 ffmpeg normalize 를 확인 대상에 넣는다).
    norm = Path(storage.resolve(storage.normalized_key(meeting_id)))
    if norm.is_file():
        norm.unlink()
        notes["normalized"] = f"이전 회차의 {norm.name} 삭제 — normalize 를 이번 회차에 다시 돌린다"

    conn.execute(
        "UPDATE meeting SET audio_key=%s, status='uploaded', error=NULL, "
        "normalized_key=NULL, duration_ms=NULL WHERE id=%s",
        (audio_key, meeting_id),
    )

    from psycopg.types.json import Jsonb

    payload = build_payload(meeting_id, audio_key)
    job_id = conn.execute(
        "INSERT INTO job(type, meeting_id, payload) VALUES ('process_meeting', %s, %s) "
        "RETURNING id",
        (meeting_id, Jsonb(payload)),
    ).fetchone()["id"]
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (job_id, meeting_id))
    notes["job"] = f"job 생성: {job_id} (type=process_meeting, status=queued)"

    # `run_once` 는 db.claim 으로 **아무** queued job 하나를 집는다. 우리 것
    # 말고 다른 게 큐에 있으면 이 실행이 무엇을 돌렸는지가 증거에서 흐려진다.
    queued = conn.execute(
        "SELECT id, type FROM job WHERE status='queued' ORDER BY created_at"
    ).fetchall()
    if [q["id"] for q in queued] != [job_id]:
        die(
            "큐에 우리 job 말고 다른 queued job 이 있다: "
            + ", ".join(f"{q['id']}({q['type']})" for q in queued)
        )
    notes["queue"] = f"queued job 은 {job_id} 하나뿐이다 (db.claim 이 이것을 집는다)"

    return meeting_id, job_id, notes, payload


# --- 결과 조회 -----------------------------------------------------------------
def read_results(conn, meeting_id: str, job_id: str) -> dict:
    m = conn.execute(
        "SELECT status, duration_ms, normalized_key, processing_version, error "
        "FROM meeting WHERE id=%s",
        (meeting_id,),
    ).fetchone()
    j = conn.execute(
        "SELECT status, stage, progress, attempts, error FROM job WHERE id=%s", (job_id,)
    ).fetchone()
    rows = conn.execute(
        "SELECT order_index, diar_label, speaker_id, status, start_ms, end_ms, text "
        "FROM utterance WHERE meeting_id=%s AND processing_version=%s ORDER BY order_index",
        (meeting_id, PROCESSING_VERSION),
    ).fetchall()
    clusters = conn.execute(
        "SELECT diar_label, resolved_speaker_id, suggested_speaker_id, "
        "       (centroid IS NOT NULL) AS has_centroid "
        "FROM meeting_cluster WHERE meeting_id=%s ORDER BY diar_label",
        (meeting_id,),
    ).fetchall()
    # **이 회의로 스코프한다.** voiceprint 에는 meeting_id 가 없으므로
    # source_cluster_id → meeting_cluster 로 이어 붙인다 (persist 가 그렇게 넣는다).
    vps = conn.execute(
        "SELECT count(*) AS n FROM voiceprint v "
        "JOIN meeting_cluster c ON c.id = v.source_cluster_id "
        "WHERE c.meeting_id=%s AND v.model=%s AND v.dimension=%s AND v.source='auto_cluster'",
        (meeting_id, EMBEDDING_MODEL, EMBEDDING_DIM),
    ).fetchone()
    return {"meeting": m, "job": j, "utterances": rows, "clusters": clusters, "voiceprints": vps["n"]}


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    log("== 환경 점검 (스펙 §4.2)")
    env = check_env()
    log(f"  DATABASE_URL : {env['dsn']}")
    log(f"  STORAGE_ROOT : {env['storage_root']}")
    log(f"  HF_HOME      : {env['hf_home']}")
    log("  HF_TOKEN     : set   # 값은 기록하지 않는다 (스펙 §4.2)")
    log(f"  python       : {sys.executable}")
    if not SAMPLE_AUDIO.is_file():
        die(f"검증 오디오가 없다: {SAMPLE_AUDIO} — lib/sandbox.sh copy-audio 를 먼저 돌려라")
    log(f"  오디오       : {SAMPLE_AUDIO} ({SAMPLE_AUDIO.stat().st_size} bytes)")

    log("")
    log("== 번들 ffmpeg 를 PATH 앞에 붙인다 (제품 코드는 이름으로 부른다)")
    ff = prepend_bundle_ffmpeg()
    log(f"  추가한 경로  : {BUNDLE_FFMPEG_BIN}")
    log(f"  which ffmpeg : {ff['ffmpeg']}")
    log(f"  which ffprobe: {ff['ffprobe']}")
    for name in ("ffmpeg", "ffprobe"):
        if not ff[name].startswith(str(BUNDLE_FFMPEG_BIN) + "/"):
            die(f"{name} 이 번들 밖에서 해석됐다: {ff[name]!r}")

    log("")
    log("== 의존 서비스 (계획 Task 7 Interfaces — 이 드라이버가 띄운다)")
    db_note = ensure_db(env["dsn"])
    log(f"  {db_note}")

    hf_before = hub_repos(env["hf_home"])
    log("")
    log(f"== HF 캐시 사전 상태: {len(hf_before)}개 저장소")
    for r in sorted(hf_before):
        log(f"  - {r}")

    from damwha_worker import db as wdb
    from damwha_worker.config import load_settings
    from damwha_worker.dispatch import run_once
    from damwha_worker.models.registry import build_models
    from damwha_worker.storage import Storage

    settings = load_settings()
    if not settings.hf_token:
        die("Settings.hf_token 이 비어 있다")
    storage = Storage(settings.storage_root)

    log("")
    log("== 시드 (smoke 스크립트의 순서 참고: 회의 → audio_key → job → current_job_id)")
    conn = wdb.connect(env["dsn"])
    meeting_id, job_id, notes, payload = seed(conn, storage)
    for k in ("meeting", "reset", "audio", "normalized", "job", "queue"):
        if k in notes:
            log(f"  {notes[k]}")

    # 회의 id 는 파이프라인이 실패해도 남긴다 — 검증이 무엇을 봐야 하는지가
    # 성공 여부와 무관하게 정해져 있어야 한다. **파일 내용은 id 한 줄뿐이다.**
    mid_path = write_evidence("t7-meeting-id.txt", meeting_id + "\n")
    log(f"  meeting id 기록: {mid_path}")

    log("")
    log("== 모델 적재 (번들 런타임)")
    log(f"  diarization : {payload['models']['diarization']['model']}  (게이트)")
    log(f"  whisper     : {payload['models']['whisper_model']}  devices.stt={payload['models']['devices']['stt']}")
    log(f"  embedding   : {payload['models']['embedding']['model']}")
    models = build_models(payload, settings)
    log(f"  transcriber : {type(models.transcriber).__module__}.{type(models.transcriber).__name__}")
    log(f"  diarizer    : {type(models.diarizer).__module__}.{type(models.diarizer).__name__}")
    log(f"  vad         : {type(models.vad).__module__}.{type(models.vad).__name__}")
    log(f"  embedder    : {type(models.embedder).__module__}.{type(models.embedder).__name__}")

    log("")
    log("== run_once (damwha_worker.dispatch — 제품 경로 그대로)")
    outcome = run_once(conn, WORKER_ID, storage, build_models=lambda: models)
    log(f"outcome: {outcome}")

    res = read_results(conn, meeting_id, job_id)
    m, j = res["meeting"], res["job"]
    labels = sorted({r["diar_label"] for r in res["utterances"]})
    ok_rows = [r for r in res["utterances"] if r["status"] == "ok"]
    ok_with_text = [r for r in ok_rows if (r["text"] or "").strip()]
    by_status: dict[str, int] = {}
    for r in res["utterances"]:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1

    log("")
    log(f"meeting: id={meeting_id} status={m['status']} duration_ms={m['duration_ms']} "
        f"normalized_key={m['normalized_key']}")
    log(f"job    : id={job_id} status={j['status']} progress={j['progress']} stage={j['stage']}")
    if j["error"]:
        log(f"job.error: {json.dumps(j['error'], ensure_ascii=False)}")
    if m["error"]:
        log(f"meeting.error: {json.dumps(m['error'], ensure_ascii=False)}")
    log(f"utterances: {len(res['utterances'])}  (status별 {by_status})")
    log(f"  status='ok' 이고 text 가 빈 문자열이 아닌 것: {len(ok_with_text)}")
    log(f"diar_label 종류 {len(labels)}: {labels}")
    log(f"meeting_cluster: {len(res['clusters'])}행, auto_cluster voiceprint {res['voiceprints']}건")

    # 정규화 산출물을 번들 ffprobe 로 다시 읽는다. **stderr 를 물려준다** —
    # 파이프라인이 부른 ffmpeg/ffprobe 는 pipeline/ffmpeg.py 가 capture_output=True
    # 로 stderr 를 가져가 dyld 줄이 래퍼에 도달하지 못하기 때문이다(모듈 주석).
    norm_probe: dict = {"rc": None, "stdout": ""}
    if m["normalized_key"]:
        norm_path = storage.resolve(m["normalized_key"])
        log("")
        log("== 번들 ffprobe 재확인 (stderr 를 물려줘 dyld 실측을 남긴다)")
        p = subprocess.run(
            [
                ff["ffprobe"], "-v", "error",
                "-show_entries", "stream=sample_rate,channels:format=duration",
                "-of", "json", norm_path,
            ],
            stdout=subprocess.PIPE,
            stderr=None,
        )
        norm_probe = {"rc": p.returncode, "stdout": (p.stdout or b"").decode("utf-8", "replace")}
        log(f"  exit={p.returncode}")
        log("  " + norm_probe["stdout"].replace("\n", "\n  ").rstrip())
        norm_probe["bytes"] = os.path.getsize(norm_path)
        log(f"  {m['normalized_key']}: {norm_probe['bytes']} bytes")

    hf_after = hub_repos(env["hf_home"])
    new_repos = sorted(hf_after - hf_before)
    log("")
    log(f"== HF 캐시 사후 상태: {len(hf_after)}개 저장소 (이 실행에서 새로 받은 것 {len(new_repos)}개)")
    cache_lines = []
    for r in sorted(hf_after):
        b = hub_bytes(env["hf_home"], r)
        mark = "NEW " if r in new_repos else "    "
        cache_lines.append(f"{mark}{r}\t{b}")
        log(f"  {mark}{r}  {b} bytes")

    # --- 증거 ---------------------------------------------------------------
    utt_rows = "\n".join(
        "{}\t{}\t{}\t{}\t{}\t{}".format(
            r["order_index"], r["diar_label"], r["speaker_id"] or "-", r["status"],
            r["start_ms"], r["end_ms"],
        )
        for r in res["utterances"]
    )
    body = f"""# Task 7 — 실제 음성 처리 파이프라인 (스펙 P0-C4, 계획 Task 7 V2)
# utc: {utcnow()}
# 격리: **예** — 드라이버는 번들 런타임 안에서 실행되므로 격리 대상이다
#       (스펙 P0-C4 "클라이언트 예외가 아니다"). run-isolated.sh 를 통과한다.
# 정확도는 판정 대상이 아니다 — 번들 런타임이 실행되는가만 본다 (스펙 P0-C4 비고).
#
# db      : {env['dsn']}
# storage : {env['storage_root']}
# HF_HOME : {env['hf_home']}
# HF_TOKEN: set   (값은 기록하지 않는다 — 스펙 §4.2)
# python  : {sys.executable}
# 서비스  : {db_note}
#
## PATH 에 붙인 번들 경로 (제품 코드가 ffmpeg 를 이름으로 부른다)
추가한 경로   : {BUNDLE_FFMPEG_BIN}
which ffmpeg  : {ff['ffmpeg']}
which ffprobe : {ff['ffprobe']}
# 파이프라인이 부른 ffmpeg/ffprobe 의 dyld 줄은 증거에 없다 —
# pipeline/ffmpeg.py::_run 이 capture_output=True 로 자식 stderr 를 파이프로
# 가져가기 때문이다(실측). 위 which 값이 그 두 자식이 어느 바이너리였는지의
# 근거이고, 아래 '번들 ffprobe 재확인'이 같은 바이너리의 dyld 실측이다.
#
## payload (모델 선택은 payload 의 책임 — models/registry.py)
{json.dumps(payload, ensure_ascii=False, indent=2)}
#
## 시드
{chr(10).join(notes[k] for k in ('meeting', 'reset', 'audio', 'normalized', 'job', 'queue') if k in notes)}
#
## 결과
outcome        : {outcome}
meeting.status : {m['status']}
meeting.duration_ms : {m['duration_ms']}
meeting.normalized_key : {m['normalized_key']}
job.status     : {j['status']}   progress: {j['progress']}   stage: {j['stage']}
job.error      : {json.dumps(j['error'], ensure_ascii=False) if j['error'] else 'null'}
utterances     : {len(res['utterances'])}  (status별 {by_status})
  status='ok' 이고 text 가 비어 있지 않은 것: {len(ok_with_text)}
diar_label 종류: {len(labels)}  {labels}
meeting_cluster: {len(res['clusters'])}행
auto_cluster voiceprint: {res['voiceprints']}건
#
## 번들 ffprobe 재확인 (정규화 산출물)
exit: {norm_probe['rc']}
{norm_probe['stdout'].rstrip()}
bytes: {norm_probe.get('bytes')}
#
## HF 캐시 (샌드박스 HOME — 개발자 캐시가 아니다)
# NEW 표시가 **이 실행이 새로 받은** 저장소다.
# 형식: NEW여부<TAB>저장소<TAB>bytes
{chr(10).join(cache_lines)}
#
## 발화 (텍스트는 싣지 않는다 — 회의 내용은 PII 다. 개수·라벨·시각만 남긴다)
# order_index<TAB>diar_label<TAB>speaker_id<TAB>status<TAB>start_ms<TAB>end_ms
{utt_rows}
"""
    detail = write_evidence("t7-pipeline.txt", body)
    log("")
    log(f"증거: {detail}")
    log(f"증거: {mid_path}")

    conn.close()

    if outcome != "committed":
        die(f"outcome 이 committed 가 아니다: {outcome!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
