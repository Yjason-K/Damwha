# import + jit 데코레이터 적용까지. 지연 컴파일이라 여기서는 아직 컴파일하지 않는다.
import numba


@numba.jit(nopython=True)
def add(a, b):
    return a + b


print("IMPORT-OK", numba.__version__)
print("DEFINE-OK")
