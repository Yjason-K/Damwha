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

/**
 * codesign 한 번. `entitlements`가 `null`이면 `--entitlements`만 뺀다 — **hardened runtime은
 * 기본으로 켠다**(`runtime = true`). Apple 공증은 번들 안의 **모든** 실행 파일에 hardened runtime을
 * 요구한다(Ruling R12, Task 6 실측: 제출 88197b1f-daae-41bc-aa68-e62176a321de가 entitlements 없이
 * 서명된 `Resources/postgres/bin/*` 32개 전부를 "hardened runtime 없음"으로 거절했다). 그래서
 * entitlements가 없다는 것은 runtime을 끌 이유가 아니다. dylib에는 플래그가 붙어도 무해하다
 * (R10 — 프로세스의 주 실행 파일에서만 읽힌다).
 *
 * 옛 기본값은 `runtime = entitlements !== null`이었다 — "별개 프로세스라 자기 서명의 플래그로
 * 도는 Resources/postgres"를 위한 것이었고 R12가 그 전제를 뒤집었다. 그 기본값이 남아 있으면 새
 * 트리를 entitlements 없이 서명할 때 runtime이 **조용히** 빠지고, 로컬은 초록인 채 공증에서야
 * 드러난다. `runtime: false`는 필요한 곳에서 명시한다 — 지금 이 저장소에는 그런 호출이 없다(DMG는
 * 이 함수를 거치지 않고 따로 서명한다, `package.mjs`).
 *
 * `--timestamp`는 공증의 선행 조건이고 인증서 만료 뒤에도 서명을 유효하게 하므로 항상 붙는다.
 */
export function codesign(identity, entitlements, targets, { runtime = true, extra = [] } = {}) {
  const args = ["--force", "--sign", identity];
  if (runtime) args.push("--options", "runtime");
  args.push("--timestamp");
  if (entitlements !== null) args.push("--entitlements", entitlements);
  args.push(...extra, ...targets);
  execFileSync("codesign", args, { stdio: "inherit" });
}
