"""번들 런타임이 mlx_lm 자신의 다운로드 경로로 모델을 샌드박스 HF 캐시에 받는다.

계획 Task 5 / 스펙 P0-C5b. `llm.sh start`가 기동 **전에** 이것을 부른다.

왜 서버에 맡기지 않는가:

  `mlx_lm.server`의 `/v1/models`는 **HF 캐시를 훑어** 모델 목록을 만든다
  (`mlx_lm/server.py::handle_models_request` → `scan_cache_dir()`). 모델 로드는
  첫 `chat/completions`까지 미뤄지므로, 캐시가 비어 있으면 서버가 정상 기동해도
  `/v1/models`에 그 모델이 **없다.** 계획 규칙 3의 준비 대기(`/v1/models`)를
  런처 안에서 끝내려면 기동 전에 캐시를 채워 두어야 한다.

왜 huggingface_hub를 직접 부르지 않는가:

  받아야 하는 파일 집합이 mlx_lm의 allow_patterns에 달려 있다. 여기서 다시
  적으면 mlx-lm 버전이 바뀔 때 조용히 어긋난다. 번들에 설치된
  `mlx_lm.utils._download`가 서버가 실제로 쓰는 그 경로다 (mlx-lm 0.31.3).

진행 표시줄은 끈다 — 켜 두면 tqdm이 stderr에 수천 줄을 쏟고, 그 stderr가
그대로 커밋되는 dyld 증거 파일로 들어간다. 환경 변수를 새로 만들지 않고
huggingface_hub의 in-process API로 끈다 (스펙 §4.2 주입 화이트리스트를
넓히지 않는다).
"""

import os
import sys
import time
from pathlib import Path


def _dir_bytes(root: Path) -> "tuple[int, int]":
    """스냅샷 디렉터리의 (파일 수, 바이트). HF 캐시의 심볼릭 링크는 따라간다."""
    files = 0
    total = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            p = Path(dirpath, name)
            try:
                total += p.stat().st_size  # follow_symlinks=True — blob의 실제 크기
            except OSError:
                continue
            files += 1
    return files, total


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: fetch_model.py <hf_repo_id>", file=sys.stderr)
        return 2
    repo = sys.argv[1]

    from huggingface_hub.utils import disable_progress_bars

    disable_progress_bars()

    try:
        from mlx_lm.utils import _download as mlx_download
    except ImportError as exc:  # mlx-lm이 이 경로의 이름을 바꾸면 조용히 넘어가지 않는다
        print(
            f"FAIL: mlx_lm.utils._download 를 import 하지 못했다 ({exc}). "
            "mlx-lm 버전이 바뀌었다면 서버가 쓰는 다운로드 경로를 다시 확인한다.",
            file=sys.stderr,
        )
        return 3

    started = time.time()
    path = Path(mlx_download(repo))
    elapsed = time.time() - started
    files, total = _dir_bytes(path)

    print(f"repo           : {repo}")
    print(f"hf_home        : {os.environ.get('HF_HOME', '<unset>')}")
    print(f"snapshot_path  : {path}")
    print(f"files          : {files}")
    print(f"bytes          : {total}")
    print(f"mib            : {total / (1024 * 1024):.1f}")
    print(f"elapsed_seconds: {elapsed:.1f}")
    print(f"downloader     : mlx_lm.utils._download (mlx-lm이 서버에서 쓰는 경로)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
