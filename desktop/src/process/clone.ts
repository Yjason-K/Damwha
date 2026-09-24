import * as fs from "fs";
import { describeToolFailure, toolOk, type ToolOptions, type ToolResult } from "./tool-runner";

/**
 * APFS clone (Phase 6b-2 스펙 §3 P4). Node 22의 `fs.cp`는 macOS에서 clone하지 않는다 — `COPYFILE_FICLONE`은 조용히
 * 전체 복사, `COPYFILE_FICLONE_FORCE`는 `ENOSYS`(2026-09-24 실측). `/bin/cp -c`만 clone한다. APFS가 아닌 볼륨에서는
 * `cp -c`가 rc=0으로 일반 복사로 넘어간다 — 실패가 아니라 느리고 공간을 쓰는 복사일 뿐이다.
 *
 * `cp -R src dst`는 dst가 **이미 있으면 그 안에** src를 넣는다(`dst/src`). 그래서 목적지는 반드시 없어야 한다.
 */
export const CP_BIN = "/bin/cp";

export type CloneFn = (src: string, dst: string, signal?: AbortSignal) => Promise<void>;

function occupied(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function makeClone(run: (bin: string, args: readonly string[], opts: ToolOptions) => Promise<ToolResult>): CloneFn {
  return async (src, dst, signal) => {
    if (occupied(dst)) throw new Error(`복사할 자리가 이미 있어요: ${dst}`);
    // deadline이 없다 — 데이터 크기에 비례한다(APFS면 1초 미만). 종료는 main이 이 작업을 기다린다(스펙 §5.2).
    const r = await run(CP_BIN, ["-c", "-R", src, dst], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, signal });
    if (!toolOk(r)) throw new Error(describeToolFailure("cp -c -R", r));
  };
}
