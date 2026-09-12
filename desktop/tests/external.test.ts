import { describe, expect, it } from "vitest";
import { parseWorkerProcesses, probeEmbedContract } from "../src/services/external";

// 2026-09-12 실측(`pnpm worker`): "uv run --directory be/worker python -m damwha_worker" 자체가
// damwha_worker를 인자로 그대로 갖고 있어, 실제 supervisor(venv의 python3)의 부모인 uv 프로세스도
// 문자열 매치만으로는 supervisor로 오탐한다. python 앞에 래퍼가 끼는 게 아니라 별도 pid로 나란히
// 뜨는 형태다 — 경로도 homebrew가 아니라 be/worker/.venv 밑이다.
const PS = [
  "  PID COMMAND",
  " 4101 /Users/jason/projects/Damwha2/be/worker/.venv/bin/python3 -m damwha_worker",
  " 4102 uv run --directory be/worker python -m damwha_worker",
  " 4207 /opt/homebrew/bin/python3.12 -m damwha_worker --once",
  " 4300 /usr/bin/grep damwha_worker",
  " 4400 /Applications/Damwha.app/Contents/MacOS/Damwha",
].join("\n");

describe("parseWorkerProcesses", () => {
  it("finds a supervisor", () => {
    expect(parseWorkerProcesses(PS, new Set())).toEqual([4101]);
  });

  it("ignores the uv run launcher that merely repeats the module argument", () => {
    // uv가 아직 exec하기 전이라 "uv run ... -m damwha_worker"라는 별개의 pid가 실제
    // supervisor(4101)와 나란히 떠 있다. 이걸 세면 앱이 자기 worker인지 외부 worker인지와
    // 무관하게 pid가 하나 더 잡혀, 자손 집합이 둘 다를 못 덮는 경로에서 오탐할 수 있다.
    expect(parseWorkerProcesses(PS, new Set())).not.toContain(4102);
  });

  it("ignores the one-shot child", () => {
    // __main__.py:279가 자식을 [sys.executable, "-m", "damwha_worker", "--once"]로 띄운다.
    // 거르지 않으면 job 하나를 처리 중인 자식을 상시 supervisor로 오인해 앱이 영영 안 띄운다.
    expect(parseWorkerProcesses(PS, new Set())).not.toContain(4207);
  });

  it("ignores our own descendants", () => {
    expect(parseWorkerProcesses(PS, new Set([4101]))).toEqual([]);
  });

  it("ignores a grep that merely mentions the module", () => {
    expect(parseWorkerProcesses(PS, new Set())).not.toContain(4300);
  });

  it("returns nothing for empty or header-only input", () => {
    expect(parseWorkerProcesses("", new Set())).toEqual([]);
    expect(parseWorkerProcesses("  PID COMMAND", new Set())).toEqual([]);
  });
});

describe("probeEmbedContract", () => {
  const want = { model: "BAAI/bge-m3", dimension: 1024 };

  it("matches when model and dimension agree", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => ({ model: "BAAI/bge-m3", dimension: 1024, vectors: [[0.1]] }),
    }));
    expect(r.kind).toBe("match");
  });

  it("reports a mismatched model instead of adopting it", async () => {
    // /health는 {"status":"ok"}만 돌려주므로 다른 모델도 200을 준다 (embed_service.py:24-25).
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => ({ model: "other/model", dimension: 1024, vectors: [[0.1]] }),
    }));
    expect(r.kind).toBe("mismatch");
    expect(r.kind === "mismatch" && r.detail).toContain("other/model");
  });

  it("reports a mismatched dimension", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => ({ model: "BAAI/bge-m3", dimension: 768, vectors: [[0.1]] }),
    }));
    expect(r.kind).toBe("mismatch");
    expect(r.kind === "mismatch" && r.detail).toContain("768");
  });

  it("treats a refused connection as absent", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(r.kind).toBe("absent");
  });

  it("treats a non-200 as absent", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 503,
      json: async () => ({}),
    }));
    expect(r.kind).toBe("absent");
  });

  it("treats unparseable JSON as absent rather than throwing", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    expect(r.kind).toBe("absent");
  });
});
