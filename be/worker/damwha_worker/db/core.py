"""연결과 모듈 공용 원시 요소.

`_Abort`는 트랜잭션 취소용 제어 흐름 예외다 — 소유권 가드가 0행을 돌려주면 이걸 던져
`with conn.transaction()` 블록을 롤백시키고, 바깥에서 잡아 outcome으로 번역한다. 예외를
쓰는 이유는 psycopg의 트랜잭션 컨텍스트가 정상 반환을 곧 커밋으로 보기 때문이다.

`worker_capabilities`는 job 테이블 계약 밖의 유일한 공유 행이라 여기 둔다 — 워커가 쓰고
API가 읽기만 한다.
"""

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, row_factory=dict_row, autocommit=True)


WORKER_CAPABILITIES_KEY = "worker_capabilities"


def upsert_worker_capabilities(conn, value: dict) -> None:
    """워커가 관측한 자기 머신 스펙을 API가 읽을 자리에 남긴다 (capabilities.py 참고).

    job 테이블 계약과 달리 단방향이라 소유권 가드가 없다 — 워커가 하나뿐인 배포에서는
    last-writer-wins가 곧 정답이고, 여러 대라면 마지막에 뜬 워커의 스펙이 실린다.
    """
    conn.execute(
        """
        INSERT INTO app_setting(key, value) VALUES(%s, %s)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        """,
        (WORKER_CAPABILITIES_KEY, Jsonb(value)),
    )


class _Abort(Exception):
    """Internal: rollback a guarded transaction when ownership is lost."""


def _vec(values):
    return "[" + ",".join(repr(float(x)) for x in values) + "]"
