// desktop/scripts/lib/macho.mjs
// package.mjs(서명)와 check-bundle.mjs(검사)가 **같은** Mach-O 집합을 보도록 한 벌만 둔다.
// 두 파일에 본문이 똑같은 사본이 있었다(Part 1 결과 문서 §9, T7) — 한쪽만 고치면 서명하는 집합과
// 검사하는 집합이 조용히 갈린다.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

// 트리 안 Mach-O 목록. 파일마다 file(1)을 부르면 Resources/python의 2만 파일에서 2분이 걸린다 —
// find -print0 을 받아 file을 묶어 부르면 수 초다 (build-python.sh의 macho_list와 같은 수법).
// 심볼릭 링크는 따라가지 않는다(-type f): bin/python·bin/python3은 python3.12를 가리키는 링크일
// 뿐이고 postgres 트리도 같은 dylib을 여러 이름으로 두므로, 따라가면 같은 파일을 여러 번
// 서명·검사하게 된다.
// fat 바이너리는 file이 슬라이스마다 "<경로> (for architecture …): Mach-O …" 줄을 더 찍으므로
// 그 꼬리표를 떼고 중복을 지운다. 붙일 곳을 못 찾은 Mach-O 줄은 조용히 흘리지 않고 던진다 —
// 놓친 파일은 "서명 안 된 Mach-O 0건"을 거짓으로 만든다.
export function machOFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = execFileSync("find", [root, "-type", "f", "-print0"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0")
    .filter((f) => f.length > 0);
  const known = new Set(files);
  const found = new Set();
  for (let i = 0; i < files.length; i += 500) {
    const out = execFileSync("file", files.slice(i, i + 500), { encoding: "utf8", maxBuffer: 1 << 28 });
    for (const line of out.split("\n")) {
      const m = /^(.*?):\s*Mach-O/.exec(line);
      if (m === null) continue;
      const p = m[1].replace(/ \(for architecture [^)]*\)$/, "");
      if (!known.has(p)) throw new Error(`file(1) 출력을 경로에 붙이지 못했다: ${line}`);
      found.add(p);
    }
  }
  return files.filter((f) => found.has(f));
}
