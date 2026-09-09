#!/usr/bin/env python3
"""Task 6 — 하이브리드 검색 검증용 시드 (스펙 P0-C2).

번들 PostgreSQL(55432)에 `meeting` → `utterance` → `utterance_embedding` 을
넣는다. 임베딩은 **Task 5의 번들 embed 서비스(58100)** 가 만든 실제 bge-m3
벡터다 — 난수·상수 벡터를 쓰면 `sem` 경로가 정말 도는지 확인되지 않기 때문이다
(계획 Task 6 Interfaces).

실행 (계획 Task 6 V1):

    bash experiments/electron-phase-0/lib/run-isolated.sh --label t6-seed -- \
      experiments/electron-phase-0/bundle/python/bin/python3 \
      experiments/electron-phase-0/drivers/seed_search.py

## 격리에서의 위치

이 스크립트는 **클라이언트**이므로 스펙 §4.0에 따라 격리 대상이 아니다.
그런데도 번들 python으로 격리 래퍼를 통해 부르는 것은 계획 V1이 그렇게
정했기 때문이고, DATABASE_URL·EMBED_SERVICE_* 를 그 래퍼가 주입하기 때문이다.
증거에는 "클라이언트 = 격리 대상 밖"으로 표시한다.

## 의존 서비스를 스스로 띄운다

계획 Task 6의 Verify 표에는 DB·embed를 띄우는 행이 없다 (Task 2 V2 / Task 5
V2 같은 자리가 없다). V1이 단독으로 돌 수 있어야 하므로 이 스크립트가 두
런처를 직접 부른다. 둘 다 PID 파일로 멱등하게 보호되므로(스펙 §4.4) 이미 떠
있으면 아무것도 하지 않는다. 런처의 stderr는 **리다이렉트하지 않는다** —
계획 "런처 스크립트의 dyld 실측 규칙" 2가 금지하는 형태를 만들지 않기 위해서고,
그래서 서버 기동 시점의 dyld 줄은 이 실행의 `t6-seed-dyld.txt` 로 들어온다.

## 스키마 (be/src/database/migrations/001_init.sql, 002_search.sql, 013, 021)

- `utterance` 의 컬럼은 meeting_id·speaker_id·diar_label·start_ms·end_ms·text·
  confidence·status·order_index·processing_version·job_id 다. `speaker_cluster_id`
  같은 컬럼은 **없다**. `status` 는 ok/silence/transcribe_failed 체크가 걸려 있고
  013 이후 UNIQUE 는 (meeting_id, processing_version, order_index) 다.
- `meeting.recorded_at` 은 021에서 NOT NULL 이 됐다. `audio_key` 도 NOT NULL 이다.
- 검색 쿼리(`search.repository.ts::filterSql`)가 `m.status='done'` 과
  `u.processing_version = m.processing_version` 을 요구하므로 그 값에 맞춘다.
- `speaker` 행은 만들지 않는다. `utterance.speaker_id` 는 nullable 이고 검색
  쿼리는 LEFT JOIN 이라 없어도 두 경로가 다 돈다. 뒤이어 도는 Task 7의 화자
  식별이 보는 테이블을 이 실험이 미리 채우지 않으려는 것이다.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import psycopg

DRIVER = Path(__file__).resolve()
EXP_ROOT = DRIVER.parents[1]
REPO_ROOT = DRIVER.parents[3]
EVIDENCE = REPO_ROOT / "docs/superpowers/reports/evidence/phase-0"

PG_RUN = EXP_ROOT / "pg/run.sh"
EMBED_SH = EXP_ROOT / "services/embed.sh"

# 이 회의를 다시 찾는 유일한 열쇠다. 재실행이 멱등하려면(스펙 §4.4) 같은 회의를
# 다시 써야 하고, 그래야 $EVIDENCE/t6-meeting-id.txt 의 id도 회차마다 바뀌지
# 않는다 — Task 7이 자기 회의와 구분하는 데 쓰는 값이다.
MEETING_TITLE = "Phase 0 Task 6 하이브리드 검색 시드"
PROCESSING_VERSION = 1

EMBED_MODEL = "BAAI/bge-m3"
EMBED_DIM = 1024

# group 의 뜻 — 검증이 두 경로를 **각각** 확인할 수 있게 나눠 둔 것이다.
#   kw  : 질의어 "예산"을 글자 그대로 담는다.  LIKE likequery('예산') 에 걸린다.
#   sem : 같은 주제지만 "예산"이라는 글자가 없다. LIKE 로는 절대 안 걸리고
#         임베딩 거리로만 가까워진다 — 여기가 sem 경로의 실제 시험대다.
#   off : 주제가 다르다. 거리가 멀어야 한다.
UTTERANCES: list[tuple[str, str]] = [
    ("kw", "이번 분기 예산 집행 현황을 먼저 보고드리겠습니다."),
    ("kw", "마케팅 예산은 작년 대비 이십 퍼센트 줄었습니다."),
    ("kw", "예산 승인은 다음 주 화요일 임원 회의에서 결정됩니다."),
    ("sem", "재무팀이 비용 절감안을 검토하고 있습니다."),
    ("sem", "지출 항목을 다시 정리해서 회계 부서에 넘기겠습니다."),
    ("sem", "자금 집행 승인 절차가 늦어져 대금 결제가 밀렸습니다."),
    ("off", "점심은 회사 앞 국밥집에서 먹기로 했습니다."),
    ("off", "주말에 비가 온다고 해서 등산 일정을 미뤘습니다."),
    ("off", "새로 산 노트북 배터리가 하루를 못 버팁니다."),
    ("off", "다음 스프린트 회고는 금요일 오후에 진행합니다."),
    ("off", "회의실 프로젝터 케이블이 자꾸 빠집니다."),
    ("off", "출장 숙소는 역 근처로 예약했습니다."),
]


def log(msg: str) -> None:
    print(msg, flush=True)


def die(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def utcnow() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def evidence_path(name: str) -> Path:
    """증거 파일을 덮어쓰지 않는다 (스펙 §6).

    내용이 **다를 때만** 옆으로 돌린다. 같은 내용으로 회차만 늘리면 t6-meeting-id
    처럼 값이 고정된 파일이 prev-*.txt 로 끝없이 불어나는데, 그것은 증거를
    지키는 것이 아니라 디렉터리를 지저분하게 만드는 것이다 (스펙 §4.4의 디스크
    여유 규칙과도 맞지 않는다).
    """
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    return EVIDENCE / name


def write_evidence(name: str, body: str) -> Path:
    path = evidence_path(name)
    if path.exists():
        old = path.read_text(encoding="utf-8")
        if old == body:
            return path
        stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path.rename(path.with_name(f"{path.stem}.prev-{stamp}{path.suffix}"))
    path.write_text(body, encoding="utf-8")
    return path


# --- 의존 서비스 -------------------------------------------------------------
def db_reachable(dsn: str) -> bool:
    try:
        with psycopg.connect(dsn, connect_timeout=3) as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:
        return False


def embed_reachable(base: str) -> bool:
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=3) as resp:
            return json.load(resp).get("status") == "ok"
    except Exception:
        return False


def launch(script: Path) -> None:
    """런처를 현재(격리된) 환경 그대로 부른다. stderr를 잡지 않는다."""
    log(f"  기동: {script} start")
    rc = subprocess.call(["/bin/bash", str(script), "start"])
    if rc != 0:
        die(f"{script} start 가 exit {rc} 로 끝났다")


def ensure_services(dsn: str, embed_base: str) -> list[str]:
    notes = []
    if db_reachable(dsn):
        notes.append("db: 이미 떠 있음")
    else:
        launch(PG_RUN)
        if not db_reachable(dsn):
            die(f"DB에 접속하지 못했다: {dsn}")
        notes.append("db: 이 실행이 기동")
    if embed_reachable(embed_base):
        notes.append("embed: 이미 떠 있음")
    else:
        launch(EMBED_SH)
        if not embed_reachable(embed_base):
            die(f"embed 서비스가 응답하지 않는다: {embed_base}/health")
        notes.append("embed: 이 실행이 기동")
    return notes


def embed_texts(base: str, texts: list[str]) -> tuple[str, int, list[list[float]]]:
    req = urllib.request.Request(
        f"{base}/embed",
        data=json.dumps({"texts": texts}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = json.load(resp)
    except urllib.error.HTTPError as exc:  # pragma: no cover - 진단용
        die(f"POST {base}/embed 가 HTTP {exc.code}: {exc.read()[:400]!r}")
    except Exception as exc:  # pragma: no cover - 진단용
        die(f"POST {base}/embed 실패: {exc}")
    model = body.get("model")
    dim = body.get("dimension")
    vectors = body.get("vectors") or []
    if model != EMBED_MODEL:
        die(f"embed 서비스의 model이 {EMBED_MODEL} 가 아니라 {model!r} 다")
    if dim != EMBED_DIM:
        die(f"embed 서비스의 dimension이 {EMBED_DIM} 이 아니라 {dim!r} 다")
    if len(vectors) != len(texts):
        die(f"벡터 수가 {len(texts)} 가 아니라 {len(vectors)} 다")
    for i, v in enumerate(vectors):
        if len(v) != EMBED_DIM:
            die(f"vectors[{i}] 의 길이가 {EMBED_DIM} 이 아니라 {len(v)} 다")
    if len({tuple(v) for v in vectors}) != len(vectors):
        die("서로 같은 벡터가 있다 — 실제 임베딩이 아닐 수 있다")
    return model, dim, vectors


def vector_literal(v: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in v) + "]"


# --- 시드 -------------------------------------------------------------------
def main() -> int:
    dsn = os.environ.get("DATABASE_URL", "")
    if not dsn:
        die("DATABASE_URL이 없다 — run-isolated.sh 를 통해 부른다 (스펙 §4.2)")
    if ":55432/" not in dsn:
        die(f"DATABASE_URL이 실험 포트 55432가 아니다: {dsn} (개발 DB에 쓰지 않는다)")
    host = os.environ.get("EMBED_SERVICE_HOST", "127.0.0.1")
    port = os.environ.get("EMBED_SERVICE_PORT", "")
    if port != "58100":
        die(f"EMBED_SERVICE_PORT가 58100이 아니라 {port!r} 다 (개발 8100과 분리)")
    embed_base = f"http://{host}:{port}"

    log("== 의존 서비스 확인 (계획 Task 6 Depends: Task 2, Task 5)")
    notes = ensure_services(dsn, embed_base)
    for n in notes:
        log(f"  {n}")

    log("")
    log(f"== 임베딩 생성: POST {embed_base}/embed  ({len(UTTERANCES)}건)")
    texts = [t for _, t in UTTERANCES]
    model, dim, vectors = embed_texts(embed_base, texts)
    log(f"  model={model}  dimension={dim}  vectors={len(vectors)}")
    log(f"  vectors[0][:4]={[round(x, 6) for x in vectors[0][:4]]}")

    log("")
    log(f"== 시드: {dsn}")
    with psycopg.connect(dsn, autocommit=False) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM meeting WHERE title = %s", (MEETING_TITLE,))
            row = cur.fetchone()
            if row:
                meeting_id = row[0]
                log(f"  기존 회의 재사용: {meeting_id} (재실행 멱등 — 스펙 §4.4)")
                # utterance 를 지우면 utterance_embedding 은 ON DELETE CASCADE 로
                # 같이 사라진다 (002_search.sql). 회의 행은 그대로 두므로 id가
                # 유지되고 Task 7이 읽을 t6-meeting-id.txt 도 바뀌지 않는다.
                cur.execute("DELETE FROM utterance WHERE meeting_id = %s", (meeting_id,))
                log(f"  기존 발화 {cur.rowcount}건 삭제 (임베딩은 CASCADE)")
            else:
                cur.execute(
                    """INSERT INTO meeting
                         (title, original_filename, audio_key, recorded_at,
                          duration_ms, status, processing_version)
                       VALUES (%s, %s, %s, now(), %s, 'done', %s)
                       RETURNING id""",
                    (
                        MEETING_TITLE,
                        "phase0-task6-seed.flac",
                        "phase0/task6/seed.flac",
                        len(UTTERANCES) * 5000,
                        PROCESSING_VERSION,
                    ),
                )
                meeting_id = cur.fetchone()[0]
                log(f"  회의 생성: {meeting_id}")

            seeded: list[tuple[int, str, str, str]] = []
            for idx, (group, text) in enumerate(UTTERANCES):
                cur.execute(
                    """INSERT INTO utterance
                         (meeting_id, speaker_id, diar_label, start_ms, end_ms,
                          text, confidence, status, order_index, processing_version)
                       VALUES (%s, NULL, %s, %s, %s, %s, %s, 'ok', %s, %s)
                       RETURNING id""",
                    (
                        meeting_id,
                        f"SPEAKER_{idx % 2:02d}",
                        idx * 5000,
                        idx * 5000 + 4000,
                        text,
                        0.9,
                        idx,
                        PROCESSING_VERSION,
                    ),
                )
                utt_id = cur.fetchone()[0]
                cur.execute(
                    """INSERT INTO utterance_embedding
                         (utterance_id, embedding, model, dimension, processing_version)
                       VALUES (%s, %s::vector, %s, %s, %s)""",
                    (utt_id, vector_literal(vectors[idx]), model, dim, PROCESSING_VERSION),
                )
                seeded.append((idx, group, utt_id, text))
            conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM utterance WHERE meeting_id = %s AND status = 'ok'",
                (meeting_id,),
            )
            n_utt = cur.fetchone()[0]
            cur.execute(
                """SELECT count(*) FROM utterance_embedding e
                   JOIN utterance u ON u.id = e.utterance_id
                   WHERE u.meeting_id = %s AND e.model = %s AND e.dimension = %s""",
                (meeting_id, EMBED_MODEL, EMBED_DIM),
            )
            n_emb = cur.fetchone()[0]

    log(f"  seeded utterances: {n_utt}")
    log(f"  seeded embeddings: {n_emb}  (model={EMBED_MODEL} dimension={EMBED_DIM})")
    if n_utt != len(UTTERANCES) or n_emb != len(UTTERANCES):
        die(f"시드 수가 기대({len(UTTERANCES)})와 다르다: utterance={n_utt} embedding={n_emb}")

    # Task 7이 자기 회의와 구분하는 데 쓴다 (계획 Task 6·7 Interfaces).
    # **파일 내용은 회의 id 한 줄뿐이다** — 주석을 섞으면 읽는 쪽이 파싱해야 한다.
    mid_path = write_evidence("t6-meeting-id.txt", meeting_id + "\n")

    rows = "\n".join(f"{i}\t{g}\t{uid}\t{txt}" for i, g, uid, txt in seeded)
    detail = f"""# Task 6 — 검색 시드 결과 (스펙 P0-C2, 계획 Task 6 V1)
# utc: {utcnow()}
# 격리: 이 스크립트는 **클라이언트**이므로 격리 대상 밖이다 (스펙 §4.0).
#       run-isolated.sh 를 통해 부르는 것은 계획 V1의 형태를 따른 것이고,
#       DATABASE_URL·EMBED_SERVICE_* 주입을 그 래퍼가 하기 때문이다.
# db: {dsn}
# embed: {embed_base}  (Task 5의 번들 bge-m3 — 난수·상수 벡터가 아니다)
# 서비스: {", ".join(notes)}
#
# meeting_id: {meeting_id}
# meeting.title: {MEETING_TITLE}
# meeting.status: done   processing_version: {PROCESSING_VERSION}
# utterances: {n_utt}    embeddings: {n_emb}
# embedding model: {model}   dimension: {dim}
#
# group 의 뜻 (검증이 두 경로를 각각 보게 하려고 나눈 것이다)
#   kw  질의어 "예산"을 글자 그대로 담는다 — LIKE likequery('예산') 에 걸린다
#   sem 같은 주제지만 "예산" 글자가 없다 — 임베딩 거리로만 가까워진다
#   off 주제가 다르다 — 거리가 멀어야 한다
#
## rows
# order_index<TAB>group<TAB>utterance_id<TAB>text
{rows}
"""
    detail_path = write_evidence("t6-seed.txt", detail)

    log("")
    log(f"meeting_id: {meeting_id}")
    log(f"증거: {mid_path}")
    log(f"증거: {detail_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
