"""Task 8 — 서명된 번들 런타임에서 R-4 / R-5 표면을 하나씩 건드린다.

usage: payload.py <check> <expected-prefix>

검사 하나당 프로세스 하나다. hardened runtime 위반은 파이썬 예외가 아니라
프로세스 종료로 나타날 수 있어서, 한 프로세스에 몰아넣으면 첫 위반에서
나머지 결과가 통째로 사라진다.
"""
import json
import sys
import traceback

# 원본 번들에서 x86_64 슬라이스에 서명이 없던 Mach-O 를 실제로 여는 모듈들.
# 파일 → 모듈 대응은 RESULTS.md 와 signing/unsigned-inventory.txt 에 있다.
UNSIGNED_MODULES = [
    "charset_normalizer.md",
    "charset_normalizer.cd",
    "fontTools.cu2qu.cu2qu",
    "fontTools.feaLib.lexer",
    "fontTools.misc.bezierTools",
    "fontTools.pens.momentsPen",
    "fontTools.qu2cu.qu2cu",
    "fontTools.varLib.iup",
    "grpc._cython.cygrpc",
    "sounddevice",
]

# 스펙 P0-C3 이 이름을 든 스택 전량. Task 3 V2(t3-imports.sh)와 같은 목록이다.
# 서명 전에는 전부 import 되는 것이 확인돼 있으므로, 여기서 깨지는 것이 있으면
# 그것은 서명·hardened runtime 이 만든 차이다.
STACK_MODULES = [
    "torch", "torchaudio", "mlx", "mlx_whisper", "mlx_lm",
    "pyannote.audio", "speechbrain", "silero_vad", "sentence_transformers",
    "faster_whisper", "soundfile", "sounddevice", "numpy",
    "fastapi", "uvicorn", "damwha_worker",
]

METAL_SOURCE = """
    uint i = thread_position_in_grid.x;
    out[i] = inp[i] * 2.0f + 1.0f;
"""


def emit(name, ok, **kw):
    rec = {"check": name, "ok": bool(ok)}
    rec.update(kw)
    json.dump(rec, sys.stdout, ensure_ascii=False, default=str)
    sys.stdout.write("\n")
    sys.stdout.flush()


def check_selfcheck(prefix):
    """사본이 정말 자기 자신을 쓰는가.

    셔뱅과 sys.prefix 가 원본 bundle/ 로 새면 이 Task 의 측정 대상이
    서명되지 않은 원본이 되어 버린다.
    """
    import sysconfig
    stdlib = sysconfig.get_paths().get("stdlib")
    paths = [sys.executable, sys.prefix, stdlib]
    ok = bool(prefix) and all(str(p).startswith(prefix) for p in paths)
    return ok, {
        "executable": sys.executable,
        "prefix": sys.prefix,
        "base_prefix": sys.base_prefix,
        "stdlib": stdlib,
        "expected_prefix": prefix,
    }


def check_unsigned_so(prefix):
    import importlib
    rows = []
    ok = True
    for name in UNSIGNED_MODULES:
        try:
            mod = importlib.import_module(name)
            row = {"module": name, "ok": True,
                   "file": getattr(mod, "__file__", None)}
            if name == "sounddevice":
                row["libname"] = getattr(mod, "_libname", None)
            rows.append(row)
        except BaseException as exc:
            rows.append({"module": name, "ok": False,
                         "error": "%s: %s" % (type(exc).__name__, exc)})
            ok = False
    return ok, {"modules": rows}


def check_numba_jit(prefix):
    """numba 의 LLVM JIT — 이 번들에서 R-4 가 실제로 나타나는 자리다.

    `mlx_whisper` 가 import 사슬로 numba 를 끌어온다(mlx_whisper.audio ->
    ... -> numba). numba 는 LLVM MCJIT 으로 기계어를 만들어 **쓰기+실행**
    메모리에 올린다. hardened runtime 아래에서는 그 매핑이 거부되고, 파이썬
    예외가 아니라 프로세스가 SIGKILL 로 죽는다.

    import 만으로도 죽으므로 실행까지 갈 필요는 없지만, JIT 이 정말 도는지를
    보려고 @njit 함수를 하나 컴파일해 부른다.
    """
    import numba
    import numpy as np

    @numba.njit
    def double_plus_one(x):
        return x * 2.0 + 1.0

    out = double_plus_one(np.arange(4.0))
    return True, {"numba_version": numba.__version__,
                  "sum": float(out.sum())}


def check_stack_imports(prefix):
    import importlib
    rows = []
    ok = True
    for name in STACK_MODULES:
        try:
            mod = importlib.import_module(name)
            rows.append({"module": name, "ok": True,
                         "file": getattr(mod, "__file__", None)})
        except BaseException as exc:
            rows.append({"module": name, "ok": False,
                         "error": "%s: %s" % (type(exc).__name__, exc)})
            ok = False
    return ok, {"modules": rows}


def check_torch_mps(prefix):
    import torch
    from damwha_worker.models.device import mps_available
    avail = bool(mps_available())
    info = {
        "torch_version": torch.__version__,
        "torch_file": torch.__file__,
        "mps_available": avail,
        "torch_mps_is_available": bool(torch.backends.mps.is_available()),
    }
    if avail:
        a = torch.randn(256, 256, device="mps")
        b = torch.randn(256, 256, device="mps")
        info["mps_matmul_sum"] = float((a @ b).sum().item())
    return avail, info


def check_torch_jit(prefix):
    import torch

    @torch.jit.script
    def f(x):
        return x * 2.0 + 1.0

    r = f(torch.ones(8))
    return True, {"torch_version": torch.__version__,
                  "jit_sum": float(r.sum().item())}


def check_mlx_metal(prefix):
    """R-4 의 본론 — Metal 셰이더 **소스**를 런타임에 컴파일한다.

    mx.fast.metal_kernel 은 위 문자열을 그 자리에서 Metal 컴파일러에 넘긴다.
    미리 만들어 둔 metallib 를 여는 것과 달리 hardened runtime 이 막을 수
    있는 형태가 이쪽이다.
    """
    import mlx.core as mx
    kernel = mx.fast.metal_kernel(
        name="t8_double",
        input_names=["inp"],
        output_names=["out"],
        source=METAL_SOURCE,
    )
    a = mx.arange(16, dtype=mx.float32)
    out = kernel(
        inputs=[a],
        grid=(16, 1, 1),
        threadgroup=(16, 1, 1),
        output_shapes=[(16,)],
        output_dtypes=[mx.float32],
    )[0]
    mx.eval(out)
    return True, {
        "mlx_version": mx.__version__,
        "device": str(mx.default_device()),
        "first": float(out[0].item()),
        "last": float(out[15].item()),
    }


def check_mlx_compile(prefix):
    import mlx.core as mx
    f = mx.compile(lambda x: mx.exp(mx.sin(x)) + 1.0)
    a = mx.random.normal((256, 256))
    r = f(a)
    mx.eval(r)
    return True, {"mlx_version": mx.__version__,
                  "sum": float(mx.sum(r).item())}


def check_mlx_lm_gen(prefix):
    """서명된 런타임에서 실제 LLM 추론이 도는가 (계획 Task 8 Steps 3).

    Task 5 는 같은 모델을 mlx_lm.server 로 띄웠다. 여기서는 서버 대신
    같은 코드를 in-process 로 부른다 — 서명 표면은 같고 포트와 수명 관리가
    빠져 이 Task 의 관찰 대상만 남는다.
    """
    from mlx_lm import load, generate
    model, tokenizer = load("mlx-community/Qwen3.5-4B-8bit")
    text = generate(model, tokenizer, prompt="1 + 1 =", max_tokens=8,
                    verbose=False)
    return True, {"text": str(text)[:200]}


CHECKS = {
    "selfcheck": check_selfcheck,
    "unsigned-so": check_unsigned_so,
    "numba-jit": check_numba_jit,
    "stack-imports": check_stack_imports,
    "torch-mps": check_torch_mps,
    "torch-jit": check_torch_jit,
    "mlx-metal": check_mlx_metal,
    "mlx-compile": check_mlx_compile,
    "mlx-lm-gen": check_mlx_lm_gen,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in CHECKS:
        sys.stderr.write("usage: payload.py <%s> [prefix]\n"
                         % "|".join(sorted(CHECKS)))
        return 2
    name = sys.argv[1]
    prefix = sys.argv[2] if len(sys.argv) > 2 else ""
    try:
        ok, info = CHECKS[name](prefix)
    except BaseException as exc:
        emit(name, False,
             error="%s: %s" % (type(exc).__name__, exc),
             traceback=traceback.format_exc(limit=6).strip().splitlines()[-4:])
        return 1
    emit(name, ok, **info)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
