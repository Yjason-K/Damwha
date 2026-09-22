# desktop/scripts/lib/build-target.sh
# 번들 전체가 목표하는 최소 macOS. build-postgres.sh·build-ffmpeg.sh가 source하고,
# build-python.sh의 mlx 휠 고정(mlx-pin.txt)과 electron-builder.yml의
# LSMinimumSystemVersion, check-bundle.mjs의 minos 상한이 **같은 값**이어야 한다.
#
# 15.0인 이유 (Phase 6a 스펙 §5.1): 우리가 못 내리는 바닥은 PyPI 휠의 14.0인데,
# mlx만 14.0 아래 휠이 없고 15.0은 있다. 14.0으로 더 내리려면 mlx 0.29.x까지 내려가
# mlx-whisper·mlx-lm 호환 조합을 다시 찾고 STT·요약 품질을 재측정해야 한다.
#
# 이 값을 올리면 두 스크립트의 캐시 키(자기 sha256을 포함하지 않는다 — 아래 주의)가
# 바뀌지 않는다. 그래서 두 스크립트의 KEY 계산에 이 파일의 sha256도 넣는다.
export MACOSX_DEPLOYMENT_TARGET=15.0
