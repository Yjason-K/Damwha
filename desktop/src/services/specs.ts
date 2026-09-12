import { apiSpec, type ApiDeps } from "./api";
import { embedSpec, type EmbedDeps } from "./embed";
import { postgresSpec, type DockerRunner } from "./postgres";
import { workerSpec, type WorkerDeps } from "./worker";
import type { ServiceSpec } from "./types";

export interface SpecDeps {
  /** postgres가 쓸 docker 실행기. 경로는 main.ts가 붙인다. */
  docker: DockerRunner;
  api: ApiDeps;
  embed: EmbedDeps;
  worker: WorkerDeps;
}

/**
 * 감독자에 넘기는 서비스 선언. **배선이 아니라 판정이다** — 이 배열 하나가 스펙 두 조항을
 * 동시에 인코딩한다.
 *
 * - **§6.7 게이트 집합**: postgres·api만 창을 늦춘다. embed는 bge-m3를 import 시점에 올려
 *   2026-09-12 실측 31초가 걸리고, worker는 그동안에도 회의 목록과 업로드가 동작하므로 둘 다
 *   배경이다. 여기서 gate를 하나 더 켜면 창이 그만큼 늦게 뜬다.
 * - **§6.9 종료 순서**: 선언 순서의 **역순**이 곧 종료 순서다(supervisor.stopAll이 ordered를
 *   reverse한다). 스펙이 `worker → embed → api`를 요구하므로 여기는
 *   `postgres → api → embed → worker`여야 한다. embed가 worker보다 먼저 죽으면 worker의
 *   진행 중 job이 임베딩을 잃는다. postgres는 마지막이고 postgresSpec.stop()은 의도적으로
 *   아무것도 하지 않는다 — 컨테이너는 앱의 소유가 아니다.
 *
 * main.ts에 두면 어떤 테스트도 이 배열을 부를 수 없다(electron을 값으로 import하는 파일은
 * vitest가 못 불러온다 — shell-window.ts:4). 실제로 그 자리에 있는 동안 선언 순서를
 * `postgres → api → worker → embed`로 바꾸는 변이가 235개 초록불 아래 살아남았다
 * (Task 12 리뷰 N5). listExternalWorkers를 services/external.ts로 옮긴 것과 같은 분리다 —
 * main.ts에는 의존(docker 경로·probe·ps 왕복)을 만드는 배선만 남는다.
 */
export function buildSpecs(deps: SpecDeps): ServiceSpec[] {
  return [
    postgresSpec(deps.docker),
    apiSpec(deps.api),
    embedSpec(deps.embed),
    workerSpec(deps.worker),
  ];
}
