# numba를 import만 한다. LLVM을 로드하지만 MCJIT은 아직 안 탄다.
import numba

print("IMPORT-OK", numba.__version__)
