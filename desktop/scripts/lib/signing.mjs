// desktop/scripts/lib/signing.mjs
// 서명 신원을 한 곳에서 읽는다. **비밀이 아니다** — 지문과 팀 ID는 서명된 바이너리에서 누구나
// 읽을 수 있고, notary 프로필은 키체인 항목의 이름일 뿐이다. 개인 키는 이 저장소에 없다.
//
// **이름이 아니라 지문을 쓴다** (Phase 6a 스펙 §6): 2026-09-13에 이 맥의 키체인에 이름이 같은
// "Apple Development" 인증서가 둘 생기자 codesign이 `ambiguous`로 실패했다. 지금도 동명
// "iPhone Distribution" 항목이 넷 있다.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const FINGERPRINT = /^[0-9A-F]{40}$/;

/** scripts/signing.json을 읽고 모양을 확인한다. 없거나 어긋나면 **던진다** — ad-hoc 폴백은 없다. */
export function loadSigning(desktopDir) {
  const file = path.join(desktopDir, "scripts", "signing.json");
  if (!fs.existsSync(file)) {
    throw new Error(`scripts/signing.json이 없다 — 서명 없이 패키징하지 않는다: ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of ["identity", "teamId", "notaryProfile"]) {
    if (typeof raw[key] !== "string" || raw[key] === "") throw new Error(`signing.json에 ${key}가 없다`);
  }
  if (!FINGERPRINT.test(raw.identity)) {
    throw new Error(`signing.json의 identity는 sha1 지문 40자여야 한다 (이름은 중복될 수 있다): ${raw.identity}`);
  }
  return { identity: raw.identity, teamId: raw.teamId, notaryProfile: raw.notaryProfile };
}

/** 그 지문이 이 키체인에 실제로 있는지. 없으면 빌드를 여기서 멈춘다 — 서명 실패는 늦게 알수록 비싸다. */
export function assertIdentityInKeychain(identity) {
  const r = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("security find-identity 실패");
  if (!(r.stdout ?? "").includes(identity)) {
    throw new Error(`키체인에 서명 신원 ${identity}가 없다. ~/Documents/damwha-signing의 .p12를 import해라`);
  }
}

/** codesign 한 번. --timestamp는 공증의 선행 조건이고 인증서 만료 뒤에도 서명을 유효하게 한다. */
export function codesign(identity, entitlements, targets, extraArgs = []) {
  execFileSync(
    "codesign",
    ["--force", "--sign", identity, "--options", "runtime", "--timestamp",
     "--entitlements", entitlements, ...extraArgs, ...targets],
    { stdio: "inherit" },
  );
}
