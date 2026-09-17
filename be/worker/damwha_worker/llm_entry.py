"""LLM 서버 진입 모듈 — `python -m damwha_worker.llm_entry --run-id=<uuid> --model … …` (스펙 §6.2).

`--once` 자식(`llm_server.managed_llm_server`)이 이 모듈로 `mlx_lm.server`를 띄운다. 콘솔 스크립트
`mlx_lm.server`를 직접 부르지 않는 이유가 둘이다.

- 셔뱅을 타면 옛 경로가 남아 있을 때 죽지 않고 조용히 다른 런타임을 실행한다 (Phase 0 R-6).
- `python -m mlx_lm.server`는 upstream CLI라 `--run-id`를 주면 모르는 인자로 죽고, 안 주면
  앱이 `ps`로 소유를 증명할 수 없는 프로세스가 된다. 이 모듈이 그 둘 사이에 앉는다.

하는 일은 다섯이다: `--run-id=`로 시작하는 토큰을 버리고(앱은 이 프로세스의 argv만 읽는다),
나머지로 `sys.argv`를 재구성하고(`argv[0]`은 argparse의 prog 이름이라 남긴다), 자기 런타임을
stderr로 보고하고(P4-C12 — 서버가 뜨고 나면 찍을 자리가 없다), HF 다운로드 진행 훅을 걸고
(스펙 §6.9), **같은 프로세스에서** `mlx_lm.server.main()`을 부른다. exec 래퍼나 자식을 만들면
스펙 §6.2가 없앤 uv 중간 프로세스 구조가 되살아난다.

**훅은 `mlx_lm`을 import하기 전에 건다** — `mlx_lm/utils.py`가 모듈 수준에서
`snapshot_download`를 묶는다. 이 프로세스는 supervisor·`--once` 자식에 이은 세 번째 writer라
보고용 DB 연결을 스스로 연다(처음 쓸 때, 물려받은 `DATABASE_URL`로). 훅 설치나 DB가 실패해도
서버는 뜬다 — 진행 보고가 없을 뿐이다.

**모듈 수준에서 `mlx_lm`도, DB도 import하지 않는다.** 빌드의 진입점 확인(`find_spec`,
`-E -s -P`)과 테스트 스위트가 이 모듈의 부모를 import하는데, 거기서 mlx를 끌어오지 않게 한다.
"""

from __future__ import annotations

import json
import os
import sys

from .runtime_report import RUN_ID_PREFIX, runtime_facts


def _worker_id() -> str:
    """model_readiness의 writer — `--once` 자식과 같은 WORKER_ID (R-9a).

    앱은 env로 주고, 웹 흐름은 `.env`(cwd를 물려받는다)에 있을 수 있다. 둘 다 없으면 Settings의
    기본값이다 — 같은 값을 여기에 다시 적지 않는다.
    """
    worker_id = os.environ.get("WORKER_ID")
    if worker_id:
        return worker_id
    from .config import Settings

    try:
        return Settings().worker_id
    except Exception:  # noqa: BLE001 — DATABASE_URL 등이 없어도 writer 이름은 정할 수 있다
        return Settings.model_fields["worker_id"].default


def _install_download_hook() -> None:
    try:
        from .models import downloads

        downloads.install_hf_progress_hook(_worker_id())
    except Exception as exc:  # noqa: BLE001 — 보고 실패가 서버 기동을 막지 않는다
        print(f"download progress hook not installed: {exc!r}", file=sys.stderr, flush=True)


def main() -> None:
    sys.argv = sys.argv[:1] + [a for a in sys.argv[1:] if not a.startswith(RUN_ID_PREFIX)]
    print(f"runtime {json.dumps(runtime_facts())}", file=sys.stderr, flush=True)

    # 스펙 §6.9 — mlx_lm을 import하기 **전에**.
    _install_download_hook()

    from mlx_lm.server import main as server_main

    server_main()


if __name__ == "__main__":
    main()
