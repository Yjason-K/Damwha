import json

import httpx
import pytest

from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.lens_client import LensClient


def test_client_posts_openai_chat_completion_with_bearer(httpx_mock):
    client = LensClient("http://localhost:11434/v1", "secret", 12.0)
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})

    assert client.extract(model="job-model", utterances=[]) == []

    request = httpx_mock.get_request()
    assert request.url == "http://localhost:11434/v1/chat/completions"
    assert request.headers["Authorization"] == "Bearer secret"
    body = json.loads(request.content)
    assert body["model"] == "job-model"
    assert body["response_format"] == {"type": "json_object"}


def test_client_sends_no_auth_header_without_api_key(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})

    LensClient("http://localhost:11434/v1/", None, 12.0).extract(model="job-model", utterances=[])

    assert "Authorization" not in httpx_mock.get_request().headers


@pytest.mark.parametrize("status_code", [408, 429, 500])
def test_client_maps_retryable_http_status_to_transient_error(httpx_mock, status_code):
    httpx_mock.add_response(status_code=status_code, text="unavailable")

    with pytest.raises(WorkerError) as raised:
        LensClient("http://localhost:11434/v1", None, 12.0).extract(
            model="job-model", utterances=[]
        )

    assert raised.value.kind is ErrorKind.TRANSIENT


def test_client_maps_invalid_llm_json_to_permanent_error(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": "not json"}}]})

    with pytest.raises(WorkerError) as raised:
        LensClient("http://localhost:11434/v1", None, 12.0).extract(
            model="job-model", utterances=[]
        )

    assert raised.value.kind is ErrorKind.PERMANENT


def test_client_maps_transport_errors_to_transient_error(httpx_mock):
    httpx_mock.add_exception(httpx.ConnectError("connection refused"))

    with pytest.raises(WorkerError) as raised:
        LensClient("http://localhost:11434/v1", None, 12.0).extract(
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

    LensClient("http://localhost:11434/v1", None, 12.0).extract(
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
                "speculate or return duplicates."
            ),
        },
        {"role": "user", "content": json.dumps({"utterances": utterances})},
    ]
