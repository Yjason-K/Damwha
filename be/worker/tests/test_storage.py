import os

import pytest

from damwha_worker.storage import Storage


def test_resolve_within_root(tmp_path):
    s = Storage(str(tmp_path))
    full = s.resolve("meetings/abc/original.m4a")
    assert full.startswith(os.path.realpath(str(tmp_path)))


def test_rejects_traversal_and_absolute(tmp_path):
    s = Storage(str(tmp_path))
    for bad in ["../../etc/passwd", "/etc/passwd", "meetings/../../secret"]:
        with pytest.raises(ValueError):
            s.resolve(bad)


def test_normalized_key():
    s = Storage("/tmp/x")
    assert s.normalized_key("abc") == "meetings/abc/normalized.flac"


def test_exists(tmp_path):
    s = Storage(str(tmp_path))
    key = "meetings/abc/original.wav"
    full = s.resolve(key)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, "wb").close()
    assert s.exists(key) is True
    assert s.exists("meetings/abc/missing.wav") is False
