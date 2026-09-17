"""연결과 모듈 공용 원시 요소.

`_Abort`는 트랜잭션 취소용 제어 흐름 예외다 — 소유권 가드가 0행을 돌려주면 이걸 던져
`with conn.transaction()` 블록을 롤백시키고, 바깥에서 잡아 outcome으로 번역한다. 예외를
쓰는 이유는 psycopg의 트랜잭션 컨텍스트가 정상 반환을 곧 커밋으로 보기 때문이다.

job 테이블 계약 밖의 공유 행 둘도 여기 둔다 — 워커(와 embed)가 쓰고 API가 읽기만 한다.
`worker_capabilities`(머신 스펙)와 `model_readiness`(모델 다운로드 상태, 스펙 §6.9)다.
"""

import os
import threading
from datetime import UTC, datetime, timedelta

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def connect(url: str, **kwargs) -> psycopg.Connection:
    return psycopg.connect(url, row_factory=dict_row, autocommit=True, **kwargs)


# ── 공유 행 스위치 ─────────────────────────────────────────────────────

SHARED_STATE_ENV = "DAMWHA_SHARED_STATE"


def shared_state_enabled() -> bool:
    """공유 행 writer 둘을 켤지. `DAMWHA_SHARED_STATE`가 `off`일 때만 끈다 (스펙 §6.9).

    데스크톱 앱은 외부 DB 모드에서 `off`, 내장 DB 모드에서 `on`을 넣는다(R-4c). 이 변수가 없는
    웹 흐름(`pnpm worker`)은 켬이라 기존 보고 동작이 그대로다. 대소문자·앞뒤 공백은 무시하지만
    `0`·`false` 같은 다른 어휘는 받지 않는다 — 앱이 쓰는 값은 `off` 하나이고, 어휘를 넓히면
    두 번째 계약이 생긴다. **DB URL 모양으로 모드를 추정하지 않는다** — 워커는 자기가 어느 DB에
    붙었는지 알 수 없다.
    """
    return os.environ.get(SHARED_STATE_ENV, "").strip().lower() != "off"


WORKER_CAPABILITIES_KEY = "worker_capabilities"


def upsert_worker_capabilities(conn, value: dict) -> None:
    """워커가 관측한 자기 머신 스펙을 API가 읽을 자리에 남긴다 (capabilities.py 참고).

    job 테이블 계약과 달리 단방향이라 소유권 가드가 없다 — 워커가 하나뿐인 배포에서는
    last-writer-wins가 곧 정답이고, 여러 대라면 마지막에 뜬 워커의 스펙이 실린다.
    외부 DB 모드(`DAMWHA_SHARED_STATE=off`)에서는 쓰지 않는다 — 앱이 소유하지 않은 DB다.
    """
    if not shared_state_enabled():
        return
    conn.execute(
        """
        INSERT INTO app_setting(key, value) VALUES(%s, %s)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        """,
        (WORKER_CAPABILITIES_KEY, Jsonb(value)),
    )


# ── model_readiness (스펙 §6.9) ────────────────────────────────────────

MODEL_READINESS_KEY = "model_readiness"
_READINESS_STATES = frozenset({"downloading", "ready", "failed"})

# 시각 문자열은 **고정 정밀도**(마이크로초 6자리, UTC `Z`)다. 비교를 SQL의 text `<`로 하므로
# 사전순이 곧 시간순이어야 한다 — 소수부 유무가 섞이면 '…20Z' < '…20.5Z'가 거짓이 된다.
# 밀리초로 줄이지 않는다: 진행 갱신 직후의 ready가 같은 밀리초에 찍히면 동률(`<` 거부)로 버려진다.
_ISO_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"
_stamp_lock = threading.Lock()
_last_stamp: datetime | None = None


def _iso_now() -> str:
    """이 프로세스 안에서 **순증가**하는 UTC 시각 문자열.

    벽시계가 같은 마이크로초를 두 번 주거나(연속 쓰기) 뒤로 가도(NTP) 한 프로세스의 쓰기가 서로를
    동률로 지우지 않게 직전 값보다 최소 1µs 뒤로 민다. 프로세스 사이의 동률은 설계대로 먼저 쓴
    것이 이긴다.
    """
    global _last_stamp
    with _stamp_lock:
        now = datetime.now(UTC)
        if _last_stamp is not None and now <= _last_stamp:
            now = _last_stamp + timedelta(microseconds=1)
        _last_stamp = now
    return now.strftime(_ISO_FORMAT)


# 한 SQL 문이다. 두 문장(읽고 → 고쳐 쓰기)으로 나누면 그 사이에 다른 writer가 끼어 서로의 key를
# 지운다. `ON CONFLICT DO UPDATE`는 충돌한 행을 잠근 뒤 **가장 최근 커밋된** 값 위에서 식을
# 평가하므로(READ COMMITTED) 동시 writer가 줄을 선다.
#   - entries: 현재 맵에 이 key 하나만 `||`로 덮는다.
#   - WHERE: 이 key의 기존 updated_at이 새 값보다 **엄격히** 작을 때만 쓴다. 동률은 버린다 —
#     `<=`면 같은 시각의 진행 갱신이 ready를 덮는다. 없는 key는 COALESCE(…, '')가 통과시킨다.
#   - 최상위 updated_at: GREATEST — 다른 key의 더 오래된 쓰기가 시계를 되돌리지 않는다.
_MERGE_READINESS_SQL = """
INSERT INTO app_setting(key, value)
VALUES (
  %(row_key)s,
  jsonb_build_object(
    'updated_at', %(ts)s::text,
    'entries', jsonb_build_object(%(entry_key)s::text, %(entry)s::jsonb)
  )
)
ON CONFLICT (key) DO UPDATE SET
  value = app_setting.value || jsonb_build_object(
    'updated_at', GREATEST(app_setting.value->>'updated_at', %(ts)s::text),
    'entries', COALESCE(app_setting.value->'entries', '{}'::jsonb)
               || jsonb_build_object(%(entry_key)s::text, %(entry)s::jsonb)
  ),
  updated_at = now()
WHERE COALESCE(app_setting.value->'entries'->%(entry_key)s->>'updated_at', '') < %(ts)s::text
"""


def merge_model_readiness(conn, key: str, entry: dict, writer: str) -> None:
    """`model_readiness.entries[key]`를 원자적으로 갈아 끼운다.

    이 key에 더 새(또는 같은 시각의) 값이 이미 있으면 아무것도 안 한다.

    `updated_at`과 `writer`는 **이 함수가** 찍는다 — 호출자가 준 값은 버린다. 호출자에게 맡기면
    비교 기준이 호출자마다 달라지고, 빠뜨리면 빈 문자열이 되어 어떤 옛 값도 덮어쓴다. 찍은 시각
    하나를 항목과 WHERE 양쪽에 같이 쓴다. 빠진 필드는 스펙 §6.9 모양의 기본값으로 채운다.
    """
    if not shared_state_enabled():
        return
    state = entry.get("state")
    if state not in _READINESS_STATES:
        raise ValueError(
            f"model_readiness state must be one of {sorted(_READINESS_STATES)}: {state!r}"
        )
    ts = _iso_now()
    full = {
        "bytes_done": 0,
        "bytes_total": 0,
        "attempt": 1,
        "started_at": ts,
        "error": None,
        "error_kind": None,
        **entry,
        "writer": writer,
        "updated_at": ts,
    }
    conn.execute(
        _MERGE_READINESS_SQL,
        {"row_key": MODEL_READINESS_KEY, "entry_key": key, "entry": Jsonb(full), "ts": ts},
    )


def read_model_readiness(conn) -> dict:
    """`{"updated_at": str | None, "entries": {repo_id: entry}}`. 행이 없으면 빈 맵."""
    row = conn.execute(
        "SELECT value FROM app_setting WHERE key = %s", (MODEL_READINESS_KEY,)
    ).fetchone()
    value = row["value"] if row is not None else {}
    return {"updated_at": value.get("updated_at"), "entries": dict(value.get("entries") or {})}


class _Abort(Exception):
    """Internal: rollback a guarded transaction when ownership is lost."""


def _vec(values):
    return "[" + ",".join(repr(float(x)) for x in values) + "]"
