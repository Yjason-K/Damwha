# 호출까지. 여기서 처음 LLVM MCJIT이 쓰기+실행 메모리를 잡는다.
# mlx_whisper/timing.py:47,72와 같은 모양이다.
import numba


@numba.jit(nopython=True)
def add(a, b):
    return a + b


print("IMPORT-OK", numba.__version__)
print("DEFINE-OK")
print("CALL-RESULT", add(1, 2))
print("CALL-OK")
