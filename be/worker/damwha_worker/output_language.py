"""요약·렌즈 프롬프트의 출력 언어 지시 한 문장 (다국어 스펙 §5.3).

프롬프트 본문은 영어 그대로 두고 끝 문장만 고른다. transcript일 때의 문장은 이 설정이 생기기 전의
문장과 **같아야** 한다 — 옛 job과 새 job(transcript)이 같은 출력을 낸다.

"even if …"를 붙이는 이유: 작은 로컬 모델은 지시보다 입력 언어에 끌린다. 녹취와 다른 언어를 고른
경우에만 붙는다.
"""

from .contracts import SummaryLanguage

_NAMES: dict[str, str] = {"ko": "Korean", "en": "English"}


def output_language_instruction(fields: str, lang: SummaryLanguage) -> str:
    if lang == "transcript":
        return f"Write {fields} in the language of the transcript."
    return f"Write {fields} in {_NAMES[lang]}, even if the transcript is in another language."
