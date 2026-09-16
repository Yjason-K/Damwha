"""번들 Python 런타임의 **자기 보고** 덤프 — P0-C8의 Python 절반.

스펙 §4.3이 계정 분리를 버리는 대신 채택한 검증이다. `PATH`가 막아 줬는지가
아니라 **런타임이 스스로 자기 위치를 어디로 알고 있는지**를 본다. SIP가
`DYLD_*`를 지운 실행에서도 성립하므로 dyld 실측의 대체 증거가 된다
(스펙 P0-C7의 "측정 불가" 항목 처리).

stdout에 JSON 하나만 낸다. 판정은 하지 않는다 — `verify/t3-selfreport.sh`가
경로를 훑어 번들·샌드박스 밖을 가리키는 항목이 있는지 본다. 여기서 판정까지
하면 "덤프한 것"과 "판정한 것"이 같은 코드가 되어, 빠뜨린 필드는 영원히
보이지 않는다.

번들 런타임 안에서 실행한다:

    run-isolated.sh --label t3-selfreport -- \
      <bundle>/bin/python3.12 <exp>/python/selfreport.py

주의: 표준 라이브러리 밖의 것을 import 실패로 죽지 않는다. 모듈 하나가
없는 것과 런타임 전체가 재배치로 깨진 것은 다른 고장이고, 여기서는 후자를
보려고 한다. import 실패는 그 모듈 항목의 `error`로 남는다.
"""

import importlib
import json
import os
import site
import sys
import sysconfig

# P0-C8이 이름을 든 넷(torch, mlx, soundfile, mlx_lm)에 더해, 재배치가 깨질
# 만한 확장 모듈을 함께 본다. 셋 다 네이티브 라이브러리를 자기 패키지 안에서
# 여는 형태라 __file__이 번들 밖을 가리키면 그 자리에서 드러난다.
MODULES = [
    "torch",
    "torchaudio",
    "mlx",
    "mlx_lm",
    "mlx_whisper",
    "soundfile",
    "sounddevice",
    "numpy",
    "scipy",
    "sklearn",
    "silero_vad",
    "pyannote.audio",
    "speechbrain",
    "sentence_transformers",
    "faster_whisper",
    "ctranslate2",
    "fastapi",
    "uvicorn",
    "psycopg",
    "damwha_worker",
]


def _module_report(name: str) -> dict:
    out: dict = {"name": name}
    try:
        mod = importlib.import_module(name)
    except Exception as exc:  # noqa: BLE001 — 어떤 실패든 그대로 기록한다
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out
    out["file"] = getattr(mod, "__file__", None)
    out["version"] = getattr(mod, "__version__", None)
    paths = getattr(mod, "__path__", None)
    if paths is not None:
        out["path"] = list(paths)
    return out


def _loaded_dylibs() -> list[str]:
    """이 프로세스가 실제로 연 Mach-O 이미지 전량.

    `DYLD_PRINT_LIBRARIES`가 SIP에 지워진 실행에서도 남는 증거다. dyld의
    공개 API를 ctypes로 부른다 — 셸에서 재는 것이 아니라 **런타임이 스스로**
    보고하는 형태여야 P0-C8의 자기 보고에 해당한다.
    """
    try:
        import ctypes
        import ctypes.util

        libc = ctypes.CDLL(None)
        libc._dyld_image_count.restype = ctypes.c_uint32
        libc._dyld_get_image_name.restype = ctypes.c_char_p
        libc._dyld_get_image_name.argtypes = [ctypes.c_uint32]
        n = libc._dyld_image_count()
        return [
            libc._dyld_get_image_name(i).decode("utf-8", "replace") for i in range(n)
        ]
    except Exception as exc:  # noqa: BLE001
        return [f"ERROR {type(exc).__name__}: {exc}"]


def main() -> None:
    report = {
        "sys": {
            "executable": sys.executable,
            "prefix": sys.prefix,
            "base_prefix": sys.base_prefix,
            "exec_prefix": sys.exec_prefix,
            "version": sys.version,
            "platform": sys.platform,
            "path": list(sys.path),
        },
        "sysconfig": {
            "paths": sysconfig.get_paths(),
            # prefix 계열 설정값. uv가 설치 시점에 다시 쓰는 자리이고,
            # 재배치 후 사후 처리(build.sh relocate)가 고치는 자리다.
            "config_vars": {
                k: sysconfig.get_config_var(k)
                for k in (
                    "prefix",
                    "exec_prefix",
                    "base",
                    "platbase",
                    "installed_base",
                    "installed_platbase",
                    "BINDIR",
                    "LIBDIR",
                    "LIBDEST",
                    "SCRIPTDIR",
                    "INCLUDEPY",
                )
            },
        },
        "site": {
            "getsitepackages": site.getsitepackages(),
            "getusersitepackages": site.getusersitepackages(),
            "ENABLE_USER_SITE": site.ENABLE_USER_SITE,
        },
        "env": {
            # 격리 래퍼가 주입한 값이 런타임에 그대로 도착했는지. 값 자체가
            # 번들·샌드박스 안을 가리켜야 한다 (스펙 §4.2 표).
            k: os.environ.get(k)
            for k in (
                "PATH",
                "HOME",
                "TMPDIR",
                "STORAGE_ROOT",
                "MODEL_CACHE_DIR",
                "HF_HOME",
                "LENS_LLM_SERVER_BIN",
                "VIRTUAL_ENV",
                "PYTHONPATH",
                "PYTHONHOME",
            )
        },
        # 비밀값은 이름과 set/unset만 (스펙 §4.2).
        "secrets": {"HF_TOKEN": "set" if os.environ.get("HF_TOKEN") else "unset"},
        "modules": [_module_report(m) for m in MODULES],
        "loaded_images": _loaded_dylibs(),
    }
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2, sort_keys=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
