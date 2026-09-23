"""각 파이썬 프로세스가 자기 런타임을 스스로 보고한다 (스펙 §6.5, §9 P4-C12).

Electron이 나중에 `<번들 python3.12> -m damwha_worker --run-id=<uuid>`로 워커를 띄우고
그 argv 토큰으로 자기 프로세스를 식별한다. P4-C12는 다섯 프로세스(supervisor, `--once`
자식, capabilities 프로브, embed, llm_entry) 각각이 **자기** 프로세스에서 실제
인터프리터 신원을 로그로 남기길 요구한다 — 부모의 보고는 자식 프로세스를 증명하지
못하므로, 부모가 대신 남기는 것으로는 부족하다.

이 워커는 `--run-id`를 **읽어 자식에게 전달하기만** 한다 — 그 값으로 자기 동작을
바꾸지 않는다.
"""

from __future__ import annotations

import sys

RUN_ID_PREFIX = "--run-id="


def run_id_arg(argv: list[str]) -> str | None:
    """argv에서 `--run-id=<value>` 형식만 인식한다.

    `--run-id abc`처럼 `=`이 없는 공백 분리 형식은 우리 것이 아니므로 `None`이다.
    `--run-id=`(프리픽스만 있고 값이 없는 경우)는 "달았지만 비웠다"는 뜻으로 읽어
    빈 문자열 `""`을 돌려준다 — 아예 달지 않은 경우(`None`)와는 구분해야, 그 자식이
    같은 빈 값을 그대로 이어 전파할 때 "부모가 안 줬다"와 "부모가 빈 값을 줬다"가
    섞이지 않는다.
    """
    for arg in argv:
        if arg.startswith(RUN_ID_PREFIX):
            return arg[len(RUN_ID_PREFIX) :]
    return None


def runtime_facts() -> dict:
    """이 프로세스가 실제로 쓰는 인터프리터의 신원.

    `sysconfig`는 담지 않는다 — Part 1 스펙 §6.1-b가 그 값을 중립 자리표시자로
    고정했다. `sys_path_head`는 앞 5개만 담는다 — 전체는 길고, 판정에 필요한 건
    "site-packages보다 먼저 오는 게 무엇인가"(dev의 `PYTHONPATH`가 거기 보인다)뿐이다.
    """
    return {
        "executable": sys.executable,
        "prefix": sys.prefix,
        "version": sys.version,
        "sys_path_head": sys.path[:5],
    }
