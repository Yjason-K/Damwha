#!/usr/bin/env python3
"""manifest의 original_filename에 해당하는 demo/audio 파일 경로를 출력한다.

macOS는 파일명을 NFD로, git(core.precomposeunicode)과 Linux는 NFC로 들고 있어
바이트 비교가 어긋난다. 양쪽을 NFC로 맞춰 비교한다.
"""
import json
import sys
import unicodedata
from pathlib import Path

manifest, meeting_id, audio_dir = sys.argv[1], sys.argv[2], Path(sys.argv[3])
want = next(m["original_filename"] for m in json.load(open(manifest)) if m["id"] == meeting_id)
want = unicodedata.normalize("NFC", want)
for f in audio_dir.iterdir():
    if unicodedata.normalize("NFC", f.name) == want:
        print(f)
        sys.exit(0)
sys.exit(f"missing {audio_dir}/{want}")
