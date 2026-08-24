import json

import httpx
import pytest

from damwha_worker.errors import ErrorKind, WorkerError
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
                "Return a JSON object with only an items array. Each item must be an action, "
                "decision, or promise and have exactly these fields: kind, text, "
                "assignee_speaker_id (nullable), due_at (nullable), primary_utterance_id, "
                "supporting_utterance_ids. Choose the exact primary utterance. Every utterance "
                "ID and assignee_speaker_id must originate in the supplied utterances. Do not "
                "speculate or return duplicates. Write text in the language of the transcript."
            ),
        },
        {"role": "user", "content": json.dumps({"utterances": utterances})},
    ]


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
                "primary_utterance_id": "utt_1",
                "supporting_utterance_ids": [],
            }
        ]
    )
    httpx_mock.add_response(json={"choices": [{"message": {"content": content}}]})

    items = LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=[]
    )

    assert [item.primary_utterance_id for item in items] == ["utt_1"]
