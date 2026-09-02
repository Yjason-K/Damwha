"""demo/scripts/*.md 대본을 이벤트 열로 바꾼다.

규약은 demo/README.md "대본 포맷"에 있다. 규약 밖 줄은 조용히 건너뛰지 않고
ScriptError로 죽인다 — 대사 한 줄이 빠진 오디오는 시드로 쓸 수 없기 때문이다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


class ScriptError(ValueError):
    pass


@dataclass(frozen=True)
class Utterance:
    speaker: str
    text: str
    line: int = field(default=0, compare=False)


@dataclass(frozen=True)
class Overlap:
    speaker: str
    text: str
    line: int = field(default=0, compare=False)


@dataclass(frozen=True)
class Pause:
    seconds: float
    line: int = field(default=0, compare=False)


Event = Utterance | Overlap | Pause

_PAUSE = re.compile(r"^\[사이\s+(\d+(?:\.\d+)?)초\]$")
_LINE = re.compile(r"^(?P<overlap>\[겹침\]\s+)?(?P<speaker>[^:\[\]]+?):\s+(?P<text>.+)$")
_META_PREFIXES = ("#", ">", "|", "**", "---")


def parse_script(source: str, cast: tuple[str, ...]) -> list[Event]:
    events: list[Event] = []
    for lineno, raw in enumerate(source.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith(_META_PREFIXES):
            continue
        if m := _PAUSE.match(line):
            events.append(Pause(seconds=float(m.group(1)), line=lineno))
            continue
        if m := _LINE.match(line):
            speaker = m.group("speaker").strip()
            if speaker not in cast:
                raise ScriptError(f"line {lineno}: unknown speaker {speaker!r}")
            cls = Overlap if m.group("overlap") else Utterance
            events.append(cls(speaker=speaker, text=m.group("text").strip(), line=lineno))
            continue
        raise ScriptError(f"line {lineno}: unrecognized line {line!r}")
    return events
