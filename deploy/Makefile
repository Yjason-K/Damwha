# Damwha 설치·운영 단축 명령. 자세한 설명과 문제 해결은 README.md.
#
#   make            타깃 목록 + 현재 상태
#   make setup      .env 만들기
#   make tools up   워커 설치 + 컨테이너 기동
#   make worker     (터미널 1)  ·  make embed  (터미널 2)
#
# 이 파일은 README.md의 명령을 감싼 것뿐이다 — 뭔가 이상하면 README의 원본 명령을
# 직접 쳐 보는 쪽이 항상 더 많은 것을 알려 준다.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# compose의 `./storage` bind mount와 호스트 워커의 STORAGE_ROOT=./storage 는 둘 다
# cwd 기준이다. 다른 폴더에서 부르면 조용히 빈 디렉터리를 가리키므로 아예 막는다.
HERE := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
ifneq ($(CURDIR),$(HERE))
$(error 이 Makefile은 $(HERE) 에서 실행해야 한다 (compose 경로와 워커 .env가 cwd 기준). `make -C $(HERE) <타깃>`)
endif

REPO    := Yjason-K/Damwha
# 레시피 안의 리터럴 `$(MAKE)`는 `make -n`에서도 실행된다(재귀 make 규칙). 이 Makefile의
# 재귀 호출은 파일을 만들고 패키지를 깔므로, 한 단계 우회해 -n이 진짜 dry-run이 되게 한다.
SUBMAKE := $(MAKE) --no-print-directory
COMPOSE := docker compose
# `exec -T`는 stdin을 컨테이너에 붙인다 — 그대로 두면 뒤따르는 `read` 확인 프롬프트가
# EOF를 받아 죽는다. 호출부마다 `</dev/null`로 stdin을 끊는다.
PSQL    := $(COMPOSE) exec -T postgres psql -U postgres damwha -qtAX

# .env는 include하지 않는다 — CAPABILITIES_CHIP 같은 값에 공백이 들어 있어
# make 문법으로 읽으면 깨진다. 필요한 키만 그때그때 뽑아 쓴다.
env-val = $(shell sed -n 's/^$(1)=//p' .env 2>/dev/null | tail -1)
VER     := $(call env-val,DAMWHA_VERSION)
# 호스트 쪽 포트. .env에 없으면 compose와 같은 기본값을 쓴다 — 두 곳의 기본값은 반드시
# 같아야 한다(compose는 `${DAMWHA_API_PORT:-13000}` 꼴로 자기 기본값을 따로 가진다).
PORT_API := $(or $(call env-val,DAMWHA_API_PORT),13000)
PORT_DB  := $(or $(call env-val,DAMWHA_DB_PORT),15432)
# huggingface_hub는 .env가 아니라 프로세스 환경변수를 본다. 안 넘기면 모델을 받을 때마다
# "unauthenticated requests" 경고가 나고 익명 rate limit이 걸린다.
HF_ENV   := HF_TOKEN="$(call env-val,HF_TOKEN)"
WHEEL   := ../damwha_worker-$(VER)-py3-none-any.whl
SRC     := ../be/worker

.DEFAULT_GOAL := help
.PHONY: help check preflight setup fetch tools models up down restart ps logs health worker embed upgrade clean

## ---------------------------------------------------------------- 안내

help:
	@echo "Damwha — 로컬 회의 기록 서비스"
	@echo
	@echo "  처음 설치      make setup && make tools && make up"
	@echo "                 그다음 터미널 두 개로 make worker / make embed"
	@echo "                 브라우저 http://localhost:$(PORT_API)"
	@echo
	@echo "  setup      .env 생성 (.env.example 복사 + 이 Mac 스펙 기록)"
	@echo "  check      준비물·.env·포트·HF 토큰 점검"
	@echo "  fetch      릴리스에서 워커 wheel 내려받기 (레포 클론이 아닐 때)"
	@echo "  tools      mlx-lm + damwha-worker 설치"
	@echo "  models     ML 모델 미리받기 (안 해도 첫 처리 때 자동으로 받는다)"
	@echo "  up/down    컨테이너 기동/정지        restart  다시 기동"
	@echo "  worker     ML 워커 (포그라운드)      embed    임베딩 서비스 (포그라운드)"
	@echo "  ps/logs    컨테이너 상태 / API 로그  health   전체 상태 점검"
	@echo "  upgrade    새 버전으로 올리기 (녹음 중이면 거절)"
	@echo "  clean      전부 삭제 — 오디오와 DB까지 (확인을 묻는다)"
	@echo
	@echo "  자세히: README.md · 모델 토큰: HUGGINGFACE.md"
	@echo
	@printf "  현재:  .env %s · DAMWHA_VERSION=%s\n" \
	  "$$([ -f .env ] && echo 있음 || echo '없음 → make setup')" "$(VER)"
	@printf "         포트   api=%s db=%s  (.env의 DAMWHA_API_PORT/DAMWHA_DB_PORT로 바꾼다)\n" "$(PORT_API)" "$(PORT_DB)"
	@printf "         컨테이너 %s\n" \
	  "$$($(COMPOSE) ps --status running --format '{{.Service}}' 2>/dev/null | paste -sd, - | grep . || echo '떠 있지 않음')"

# 포트 검사에 lsof를 쓰지 않는다 — 포트를 찾고도 (다른 사용자 프로세스 접근 거부로)
# exit 1을 내는 경우가 있어 조용히 무시된다. docker에 직접 묻고, bash의 /dev/tcp로
# docker 밖의 리스너까지 본다.
#
# preflight는 `up`이 의존한다 — 포트가 막혀 있으면 컨테이너를 만들기 전에 멈춘다.
# 실패는 경고가 아니라 중단이다: 반쯤 뜬 스택이 남는 쪽이 더 헷갈린다.
preflight:
	@test -f .env || { echo ".env가 없다 — make setup"; exit 1; }
	@# 워커는 .env의 DATABASE_URL로, 컨테이너는 DAMWHA_DB_PORT로 뜬다. 둘이 어긋나면
	@# 워커가 이 스택이 아닌 다른 Postgres에 붙어 조용히 아무 job도 안 집는다.
	@urlport=$$(sed -n 's|^DATABASE_URL=.*@[^:]*:\([0-9][0-9]*\)/.*|\1|p' .env | tail -1); \
	if [ -n "$$urlport" ] && [ "$$urlport" != "$(PORT_DB)" ]; then \
	  echo ".env가 어긋났다: DATABASE_URL의 포트는 $$urlport 인데 DAMWHA_DB_PORT는 $(PORT_DB) 다."; \
	  echo "  워커가 이 스택이 아닌 Postgres에 붙는다. 둘을 같은 번호로 맞춘다."; \
	  exit 1; \
	fi
	@docker info >/dev/null 2>&1 || { echo "Docker 데몬이 응답하지 않는다 — Docker Desktop을 켠다"; exit 1; }
	@ours=$$($(COMPOSE) ps --status running -q 2>/dev/null | grep -c . || true); \
	for pair in "DAMWHA_API_PORT $(PORT_API)" "DAMWHA_DB_PORT $(PORT_DB)"; do \
	  set -- $$pair; var=$$1; port=$$2; \
	  busy=$$(docker ps --filter "publish=$$port" --format '{{.Names}}' \
	          | grep -v '^damwha-deploy-' | head -1); \
	  if [ -z "$$busy" ] && [ "$$ours" = 0 ] && (exec 3<>/dev/tcp/127.0.0.1/$$port) 2>/dev/null; then \
	    busy="도커 밖의 프로세스"; \
	  fi; \
	  if [ -n "$$busy" ]; then \
	    echo "$$port 포트가 이미 쓰이고 있다 ($$busy) — 시작하지 않는다."; \
	    echo "  .env에 다른 번호를 적고 다시 실행한다:   $$var=<빈 포트>"; \
	    [ "$$var" = DAMWHA_DB_PORT ] && echo "  (DATABASE_URL의 포트도 같이 바꾼다)"; \
	    exit 1; \
	  fi; \
	done; \
	echo "포트 사용 가능: api=$(PORT_API) db=$(PORT_DB)"

check: preflight
	@fail=0; \
	for t in docker uv ffmpeg; do \
	  command -v $$t >/dev/null || { echo "없음: $$t — README.md 0. 준비물"; fail=1; }; \
	done; \
	tok="$(call env-val,HF_TOKEN)"; \
	if [ -z "$$tok" ]; then \
	  echo "HF_TOKEN이 비었다 — 화자 분리가 실패한다. HUGGINGFACE.md 참고"; fail=1; \
	else \
	  for repo in pyannote/speaker-diarization-community-1 pyannote/segmentation-3.0 \
	              pyannote/speaker-diarization-3.1; do \
	    code=$$(curl -sIL -m 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $$tok" \
	            "https://huggingface.co/$$repo/resolve/main/config.yaml" 2>/dev/null || echo 000); \
	    case "$$code" in \
	      200) ;; \
	      401) echo "HF_TOKEN이 거부됐다 (401) — 토큰이 잘못됐거나 잘려 있다. HUGGINGFACE.md 3번"; \
	           fail=1; break;; \
	      403) echo "$$repo 라이선스 미수락 (403) — HUGGINGFACE.md 2번"; fail=1;; \
	      000) echo "주의: Hugging Face에 연결하지 못해 토큰을 확인하지 못했다 (네트워크)";; \
	      *)   echo "주의: $$repo 확인이 $$code 로 돌아왔다";; \
	    esac; \
	  done; \
	fi; \
	mine=" $$($(COMPOSE) ps -aq 2>/dev/null | tr '\n' ' ')"; \
	for name in damwha-deploy-postgres damwha-deploy-api; do \
	  id=$$(docker ps -a --format '{{.ID}} {{.Names}}' | awk -v n="$$name" '$$2==n{print $$1}'); \
	  if [ -n "$$id" ] && ! echo "$$mine" | grep -q " $$id "; then \
	    proj=$$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$$id" 2>/dev/null); \
	    echo "이름 충돌: 컨테이너 $$name 이 이미 있다 (compose 프로젝트 '$$proj')."; \
	    echo "  지운다: docker rm -f $$name   (그 프로젝트의 볼륨은 남는다)"; \
	    fail=1; \
	  fi; \
	done; \
	[ $$fail -eq 0 ] && echo "준비 완료." || exit 1

## ---------------------------------------------------------------- 설치

setup:
	@if [ -f .env ]; then echo ".env가 이미 있다 — 건드리지 않는다. 지우고 다시 하려면 rm .env"; else \
	  cp .env.example .env; echo ".env 생성 (.env.example 복사)"; \
	fi
	@# DAMWHA_VERSION: .env.example의 값은 릴리스마다 낡는다. gh가 있으면 최신 태그로 맞춘다.
	@if command -v gh >/dev/null && latest=$$(gh release view -R $(REPO) --json tagName -q .tagName 2>/dev/null); then \
	  latest=$${latest#v}; cur=$$(sed -n 's/^DAMWHA_VERSION=//p' .env | tail -1); \
	  if [ "$$cur" != "$$latest" ]; then \
	    sed -i.bak "s/^DAMWHA_VERSION=.*/DAMWHA_VERSION=$$latest/" .env && rm -f .env.bak; \
	    echo "DAMWHA_VERSION $$cur → $$latest (최신 릴리스)"; \
	  fi; \
	else echo "gh 없음 — DAMWHA_VERSION은 .env의 값을 그대로 쓴다"; fi
	@# 이 Mac의 스펙. api는 컨테이너 안이라 호스트를 못 본다. 워커가 뜨면 실측값으로 덮인다.
	@if [ -z "$(call env-val,CAPABILITIES_CHIP)" ] && [ "$$(uname -s)" = Darwin ]; then \
	  printf 'CAPABILITIES_MEMORY_GB=%d\nCAPABILITIES_CHIP=%s\n' \
	    "$$(( $$(sysctl -n hw.memsize) / 1073741824 ))" \
	    "$$(sysctl -n machdep.cpu.brand_string)" >> .env; \
	  echo "이 Mac의 메모리·칩을 .env에 기록"; \
	fi
	@if [ -z "$(call env-val,HF_TOKEN)" ]; then \
	  echo; echo "남은 것 하나: .env의 HF_TOKEN. 화자 분리 모델이 gated라 필요하다 → HUGGINGFACE.md (5분)"; \
	fi

fetch:
	@test -n "$(VER)" || { echo "DAMWHA_VERSION이 비었다 — make setup 먼저"; exit 1; }
	gh release download "v$(VER)" -R $(REPO) -p '*.whl' -D .. --clobber
	@echo "받음: $(WHEEL)"

# --python 3.12: 워커는 pyproject에서 `>=3.12,<3.13`을 요구하지만 `uv tool install`은
# 그 상한을 보지 않고 시스템에 있는 최신 파이썬(3.14 등)을 고른다 — 실측으로 확인했다.
# 고정하지 않으면 지원 범위 밖 인터프리터에 ML 스택이 깔린다.
tools:
	@test -n "$(VER)" || { echo "DAMWHA_VERSION이 비었다 — make setup 먼저"; exit 1; }
	@# 워커가 mlx_lm.server 바이너리를 실행한다 — 워커 venv 안이 아니라 PATH에 있어야 한다.
	uv tool install mlx-lm
	@# 릴리스 wheel · 레포 클론의 소스 · 릴리스 다운로드 순으로 찾는다.
	@if [ -f "$(WHEEL)" ]; then \
	  echo "wheel: $(WHEEL)"; \
	  uv tool install --force --python 3.12 "damwha-worker[models] @ $(WHEEL)"; \
	elif [ -f "$(SRC)/pyproject.toml" ]; then \
	  echo "소스: $(SRC) (레포 클론)"; \
	  uv tool install --force --python 3.12 "$(SRC)[models]"; \
	else \
	  echo "wheel도 소스도 없다 — 릴리스에서 받는다"; $(SUBMAKE) fetch; \
	  uv tool install --force --python 3.12 "damwha-worker[models] @ $(WHEEL)"; \
	fi
	@# Rosetta python이면 MPS를 못 잡아 GPU 프리셋이 전부 잠긴다 (README 문제 해결).
	@# 방금 깐 tool 환경의 인터프리터를 직접 본다 — `uv tool run`은 별개의 임시 환경을 만든다.
	@py="$$(uv tool dir 2>/dev/null)/damwha-worker/bin/python"; \
	arch=$$([ -x "$$py" ] && "$$py" -c 'import platform;print(platform.machine())' 2>/dev/null || echo unknown); \
	if [ "$$arch" != unknown ] && [ "$$arch" != arm64 ] && [ "$$(uname -m)" = arm64 ]; then \
	  echo "주의: 워커가 $$arch 파이썬에 깔렸다 (Rosetta) — GPU 프리셋이 잠긴다. uv python list 로 arm64 확인"; \
	fi
	@echo "설치 완료: damwha-worker, damwha-embed, mlx_lm.server"

# 미리받기. 안 해도 첫 처리 때 워커가 알아서 받지만, 그때 수 GB를 기다리게 된다.
# 워커가 깔린 환경의 python으로, cwd를 이 폴더로 둔 채 돌린다 — 스크립트의
# load_settings()가 `env_file=".env"`를 cwd 기준으로 읽으므로 여기 .env의 HF_TOKEN이 쓰인다.
models:
	@test -f .env || { echo ".env가 없다 — make setup"; exit 1; }
	@py="$$(uv tool dir 2>/dev/null)/damwha-worker/bin/python"; \
	[ -x "$$py" ] || { echo "워커가 안 깔렸다 — make tools"; exit 1; }; \
	if [ -f "$(SRC)/scripts/download_models.py" ]; then \
	  echo "모델을 미리 받는다 (수 GB, 수 분). 중간에 끊어도 다음에 이어받는다."; \
	  $(HF_ENV) "$$py" "$(SRC)/scripts/download_models.py"; \
	else \
	  echo "미리받기 스크립트는 레포에만 있다 — 릴리스로 설치했다면 건너뛴다."; \
	  echo "첫 회의를 처리할 때 워커가 같은 모델을 알아서 받는다."; \
	fi

## ---------------------------------------------------------------- 운영

up: preflight
	$(COMPOSE) up -d
	@echo "http://localhost:$(PORT_API)  (API 문서 /docs)"
	@echo "워커는 아직 안 떴다 — 터미널 두 개로 make worker / make embed"

down:
	$(COMPOSE) down

restart: down up

ps:
	@$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f api

health:
	@printf 'api    : %s\n' "$$(curl -fsS localhost:$(PORT_API)/api/health 2>/dev/null || echo '응답 없음 — make up / make logs')"
	@printf 'embed  : %s\n' "$$(curl -fsS localhost:8100/health 2>/dev/null || echo '응답 없음 — make embed (없어도 검색은 키워드로 동작)')"
	@printf 'worker : %s\n' "$$($(PSQL) -c "select value from app_setting where key='worker_capabilities'" </dev/null 2>/dev/null | grep . || echo '아직 보고 없음 — make worker 를 한 번이라도 띄운 적이 없다')"

# 포그라운드로 둔다. 로그가 stderr로 나오고 README의 문제 해결이 전부 그 로그를 본다.
worker:
	@test -f .env || { echo ".env가 없는 폴더다 — 워커가 DATABASE_URL을 못 찾고 죽는다"; exit 1; }
	@command -v damwha-worker >/dev/null || { echo "damwha-worker가 PATH에 없다 — make tools"; exit 1; }
	@echo "첫 실행은 모델을 받느라 수 분 걸린다. Ctrl-C로 종료."
	@$(HF_ENV) damwha-worker

embed:
	@test -f .env || { echo ".env가 없는 폴더다"; exit 1; }
	@command -v damwha-embed >/dev/null || { echo "damwha-embed가 PATH에 없다 — make tools"; exit 1; }
	@echo "첫 실행 워밍업 30–90초. Ctrl-C로 종료."
	@$(HF_ENV) damwha-embed

## ---------------------------------------------------------------- 업그레이드 / 정리

# migration 024 이후의 API는 진행 중이던 녹음을 이어받지 않고 거절한다 — committed_bytes를
# 사후에 채울 방법이 없기 때문이다(파일 길이로 역산하면 크래시가 남긴 미확정 꼬리를 정본으로
# 인정하게 된다). 그래서 올리기 전에 녹음이 비었는지만 본다. 비어 있지 않으면 아무것도 안 한다.
upgrade: preflight
	@rec=$$($(PSQL) -c "select count(*) from meeting where status='recording'" </dev/null 2>/dev/null || echo x); \
	job=$$($(PSQL) -c "select count(*) from job where type='live_session' and status in ('queued','running')" </dev/null 2>/dev/null || echo x); \
	if [ "$$rec" = x ]; then echo "Postgres에 물어볼 수 없다 — 컨테이너가 떠 있어야 한다 (make up)"; exit 1; fi; \
	if [ "$$rec" != 0 ] || [ "$$job" != 0 ]; then \
	  echo "진행 중인 녹음이 있다 (meeting=$$rec, live_session job=$$job) — 업그레이드하지 않는다."; \
	  echo "사용자가 '종료'를 누르게 하거나, 최대 90초 기다린다 (버려진 녹음은 스위퍼가 봉인한다)."; \
	  echo "DB 값을 손으로 채우지 말 것 — 미확정 오디오를 정본으로 만드는 길이다."; \
	  exit 1; \
	fi; \
	echo "진행 중인 녹음 없음. 올린다."
	@if [ -t 0 ] && [ "$(CONFIRM)" != 1 ]; then \
	  echo "워커 터미널에서 Ctrl-C 를 눌렀는지 확인하고 Enter (중단하려면 Ctrl-C)"; read _; \
	fi
	$(COMPOSE) down
	@$(SUBMAKE) setup
	$(COMPOSE) pull
	$(COMPOSE) up -d
	@$(SUBMAKE) tools
	@echo "적용된 migration 상위 3개:"
	@$(PSQL) -c "select name from _migrations order by name desc limit 3" </dev/null
	@echo "워커를 다시 띄운다: make worker / make embed"

# 한 셸 블록이다 — 여러 줄로 나누면 사용자가 취소해도 make가 다음 줄부터 계속 실행해
# 결국 지운다. 취소는 이 블록 하나를 끝내야 한다.
clean:
	@echo "지운다: DB 볼륨 전체, ./storage 의 업로드 오디오, 설치한 uv 도구."; \
	echo "되돌릴 수 없다."; \
	if [ "$(CONFIRM)" != 1 ]; then \
	  read -p "정말 지울까? [y/N] " a; \
	  case "$$a" in y|Y) ;; *) echo "취소했다 — 아무것도 지우지 않았다."; exit 0;; esac; \
	fi; \
	set -x; \
	$(COMPOSE) down -v; \
	rm -rf storage; \
	uv tool uninstall damwha-worker mlx-lm || true; \
	set +x; \
	echo "정리 완료. .env는 남겨 뒀다 (지우려면 rm .env)."
