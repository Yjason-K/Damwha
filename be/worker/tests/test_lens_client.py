import json
from datetime import date

import httpx
import pytest

from damwha_worker.errors import LLM_REQUEST_FAILED, ErrorKind, WorkerError
from damwha_worker.lens_client import LensClient


def test_client_posts_openai_chat_completion_with_bearer(httpx_mock):
    client = LensClient("http://localhost:11434/v1", "secret", 12.0, 8192)
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})

    assert client.extract(model="job-model", utterances=[]) == []

    request = httpx_mock.get_request()
    assert request.url == "http://localhost:11434/v1/chat/completions"
    assert request.headers["Authorization"] == "Bearer secret"
    body = json.loads(request.content)
    assert body["model"] == "job-model"
    assert body["response_format"] == {"type": "json_object"}


def test_client_caps_generation_with_max_tokens(httpx_mock):
    # 서버 기본 상한(mlx_lm.server는 512)에 걸리면 JSON이 중간에서 잘려
    # llm_invalid_response로 실패한다 — 상한을 요청 바디에서 명시한다.
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})

    LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=[]
    )

    assert json.loads(httpx_mock.get_request().content)["max_tokens"] == 8192


def test_client_sends_no_auth_header_without_api_key(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})

    LensClient("http://localhost:11434/v1/", None, 12.0, 8192).extract(
        model="job-model", utterances=[]
    )

    assert "Authorization" not in httpx_mock.get_request().headers


@pytest.mark.parametrize("status_code", [408, 429, 500])
def test_client_maps_retryable_http_status_to_transient_error(httpx_mock, status_code):
    httpx_mock.add_response(status_code=status_code, text="unavailable")

    with pytest.raises(WorkerError) as raised:
        LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
            model="job-model", utterances=[]
        )

    assert raised.value.kind is ErrorKind.TRANSIENT


def test_client_maps_invalid_llm_json_to_permanent_error(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": "not json"}}]})

    with pytest.raises(WorkerError) as raised:
        LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
            model="job-model", utterances=[]
        )

    assert raised.value.kind is ErrorKind.PERMANENT


def test_client_maps_transport_errors_to_transient_error(httpx_mock):
    httpx_mock.add_exception(httpx.ConnectError("connection refused"))

    with pytest.raises(WorkerError) as raised:
        LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
            model="job-model", utterances=[]
        )

    assert raised.value.kind is ErrorKind.TRANSIENT


def test_client_sends_the_lens_extraction_contract_prompt_and_utterances(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})
    utterances = [
        {
            "id": "utt_1",
            "speaker_id": "spk_1",
            "speaker_name": "Ada",
            "text": "I will send it Friday.",
            "start_ms": 0,
            "end_ms": 1000,
        }
    ]

    LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=utterances
    )

    body = json.loads(httpx_mock.get_request().content)
    assert body["messages"] == [
        {
            "role": "system",
            "content": (
                "You are given a meeting transcript. The Speakers section lists one speaker per "
                "line as `<speaker_id> <name>`. After it, each transcript line is one utterance, "
                "formatted as `<index> <speaker name>: <text>`, in chronological order. "
                "Return a JSON object with only an items array. Each item must be an action, "
                "decision, or promise and have exactly these fields: kind, text, "
                "assignee_speaker_id (nullable), due_at (nullable), primary_index, "
                "supporting_indexes. Choose the exact primary utterance. primary_index and "
                "every supporting index must be index values from the transcript, and "
                "assignee_speaker_id must be a speaker_id from the Speakers section (not a "
                "name) or null. Do not "
                "speculate or return duplicates. Write text in the language of the transcript."
            ),
        },
        # 진짜 spk id는 Speakers 명단에 한 번씩 — assignee_speaker_id가 SpeakerId
        # 패턴을 요구해서, 본문에서 뺀 id를 모델이 지목할 곳이 있어야 한다.
        # utterance는 인덱스로만 — 진짜 utt id를 실으면 모델이 숫자 보간으로
        # 프롬프트에 없는 id를 지어낸다 (mtg_1의 utt_2658)
        {
            "role": "user",
            "content": "Speakers:\nspk_1 Ada\n\n1 Ada: I will send it Friday.",
        },
    ]


def test_client_prompt_omits_ids_and_timestamps_the_model_cannot_use(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})
    utterances = [
        {
            "id": "utt_1",
            "speaker_id": "spk_1",
            "speaker_name": "Ada",
            "text": "다음 주까지\n정리할게요",
            "start_ms": 1234567,
            "end_ms": 1234890,
        },
        # speaker_name이 없으면 speaker_id가 화자 자리를 대신한다
        {"id": "utt_2", "speaker_id": "spk_2", "speaker_name": None, "text": "네", "start_ms": 0},
    ]

    LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=utterances
    )

    sent = json.loads(httpx_mock.get_request().content)["messages"][1]["content"]
    roster, transcript = sent.split("\n\n", 1)
    # 이름 없는 화자는 명단에 id만 실리고 본문에서도 id가 화자 자리를 대신한다
    assert roster.splitlines() == ["Speakers:", "spk_1 Ada", "spk_2"]
    # 발화 내부 개행은 접는다 — 한 utterance는 한 줄
    assert transcript.splitlines() == ["1 Ada: 다음 주까지 정리할게요", "2 spk_2: 네"]
    assert "1234567" not in sent and "start_ms" not in sent
    # spk id는 명단에만 — 본문에 발화마다 반복되지 않는다
    assert "spk_1" not in transcript


def test_client_lists_each_speaker_once_in_order_of_first_appearance(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})
    utterances = [
        {"id": "utt_1", "speaker_id": "spk_2", "speaker_name": "Bo", "text": "가"},
        {"id": "utt_2", "speaker_id": "spk_1", "speaker_name": "Ada", "text": "나"},
        {"id": "utt_3", "speaker_id": "spk_2", "speaker_name": "Bo", "text": "다"},
        {"id": "utt_4", "speaker_id": None, "speaker_name": None, "text": "라"},
    ]

    LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=utterances
    )

    sent = json.loads(httpx_mock.get_request().content)["messages"][1]["content"]
    roster = sent.split("\n\n", 1)[0]
    assert roster.splitlines() == ["Speakers:", "spk_2 Bo", "spk_1 Ada"]


def test_client_omits_the_speakers_section_when_no_utterance_has_a_speaker(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})

    LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=[{"id": "utt_1", "text": "가"}]
    )

    sent = json.loads(httpx_mock.get_request().content)["messages"][1]["content"]
    assert sent == "1: 가"


def test_client_treats_a_timeout_as_permanent(httpx_mock):
    # 같은 프롬프트를 다시 던지면 같은 자리에서 같은 시간을 쓰고 죽는다
    httpx_mock.add_exception(httpx.TimeoutException("timed out"))
    with pytest.raises(WorkerError) as exc:
        LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
            model="job-model", utterances=[]
        )
    assert exc.value.kind is ErrorKind.PERMANENT
    assert exc.value.code == LLM_REQUEST_FAILED


def test_client_treats_a_connection_error_as_transient(httpx_mock):
    # 연결 실패는 다르다 — 서버가 아직 안 떴거나 재기동 중일 수 있다
    httpx_mock.add_exception(httpx.ConnectError("connection refused"))
    with pytest.raises(WorkerError) as exc:
        LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
            model="job-model", utterances=[]
        )
    assert exc.value.kind is ErrorKind.TRANSIENT


def test_client_names_the_budget_when_the_reply_is_truncated(httpx_mock):
    # 잘린 items 배열은 "Invalid JSON"으로 보여서 모델 포맷 버그로 오진된다
    httpx_mock.add_response(
        json={
            "choices": [
                {"message": {"content": '{"items": [{"kind": "act'}, "finish_reason": "length"}
            ]
        }
    )
    with pytest.raises(WorkerError) as exc:
        LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
            model="job-model", utterances=[]
        )
    assert exc.value.kind is ErrorKind.PERMANENT
    assert "max_tokens" in exc.value.message


@pytest.mark.parametrize(
    "content",
    [
        '```json\n{"items": []}\n```',
        '```\n{"items": []}\n```',
        '  ```json\n{"items": []}\n```  ',
    ],
)
def test_client_parses_a_response_wrapped_in_a_markdown_code_fence(httpx_mock, content):
    httpx_mock.add_response(json={"choices": [{"message": {"content": content}}]})

    assert (
        LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
            model="job-model", utterances=[]
        )
        == []
    )


def test_client_disables_model_reasoning(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})

    LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=[]
    )

    assert json.loads(httpx_mock.get_request().content)["reasoning_effort"] == "none"


def test_client_sends_non_ascii_utterance_text_unescaped(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})
    utterances = [
        {
            "id": "utt_1",
            "speaker_id": "spk_1",
            "speaker_name": "김영재",
            "text": "내일까지 보고서 보내겠습니다",
            "start_ms": 0,
            "end_ms": 1000,
        }
    ]

    LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=utterances
    )

    user_message = json.loads(httpx_mock.get_request().content)["messages"][1]["content"]
    assert "내일까지 보고서 보내겠습니다" in user_message
    assert "\\u" not in user_message


def test_client_accepts_a_bare_items_array(httpx_mock):
    content = json.dumps(
        [
            {
                "kind": "action",
                "text": "send the report",
                "assignee_speaker_id": "spk_1",
                "due_at": None,
                "primary_index": 1,
                "supporting_indexes": [],
            }
        ]
    )
    httpx_mock.add_response(json={"choices": [{"message": {"content": content}}]})

    items = LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=[{"id": "utt_1", "text": "가"}]
    )

    assert [item.primary_utterance_id for item in items] == ["utt_1"]


def test_client_maps_indexes_back_to_real_utterance_ids(httpx_mock):
    # 모델은 인덱스만 알고, 저장 계약(LensCandidate)은 진짜 id를 든다
    content = json.dumps(
        {
            "items": [
                {
                    "kind": "promise",
                    "text": "내일까지 보고서",
                    "primary_index": 2,
                    "supporting_indexes": [1, 3],
                }
            ]
        }
    )
    httpx_mock.add_response(json={"choices": [{"message": {"content": content}}]})
    utterances = [
        {"id": "utt_7", "text": "가"},
        {"id": "utt_9", "text": "나"},
        {"id": "utt_12", "text": "다"},
    ]

    items = LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=utterances
    )

    assert items[0].primary_utterance_id == "utt_9"
    assert items[0].supporting_utterance_ids == ["utt_7", "utt_12"]
    # nullable 생략 허용은 그대로다
    assert items[0].assignee_speaker_id is None and items[0].due_at is None


def test_client_rejects_an_out_of_range_index_as_permanent(httpx_mock):
    # 인덱스 방식에서 "지어낸 utterance"는 범위 밖 정수로 나타난다 — 즉시 PERMANENT
    content = json.dumps(
        {"items": [{"kind": "action", "text": "t", "primary_index": 99, "supporting_indexes": []}]}
    )
    httpx_mock.add_response(json={"choices": [{"message": {"content": content}}]})

    with pytest.raises(WorkerError) as exc:
        LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
            model="job-model", utterances=[{"id": "utt_1", "text": "가"}]
        )
    assert exc.value.kind is ErrorKind.PERMANENT
    assert "99" in exc.value.message and "1..1" in exc.value.message


def test_client_drops_an_unparseable_due_at_but_keeps_the_item(httpx_mock):
    # 모델은 "오늘"·"22 일" 같은 상대 표현을 그대로 낸다. 예전에는 pydantic 검증이
    # all-or-nothing이라 날짜 하나가 추출 run 전체를 llm_invalid_response로 죽였다
    # (mtg_1의 job_3: 날짜 6개가 항목 10건을 날렸다).
    httpx_mock.add_response(
        json={
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "items": [
                                    {
                                        "kind": "action",
                                        "text": "보고서 보내기",
                                        "due_at": "오늘",
                                        "primary_index": 1,
                                        "supporting_indexes": [],
                                    },
                                    {
                                        "kind": "action",
                                        "text": "회의록 정리",
                                        "due_at": "2026-09-22",
                                        "primary_index": 1,
                                        "supporting_indexes": [],
                                    },
                                ]
                            }
                        )
                    }
                }
            ]
        }
    )

    items = LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=[{"id": "utt_1", "text": "오늘까지 보내주세요."}]
    )

    assert [i.due_at for i in items] == [None, date(2026, 9, 22)]
    assert [i.text for i in items] == ["보고서 보내기", "회의록 정리"]
