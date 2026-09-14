/**
 * DATABASE_URL 문자열의 비밀번호를 가리는 곳을 하나로 모은다. config.ts(옛 키 경고)와
 * config-reload.ts(describeMode)가 둘 다 이것을 쓴다 — config-reload.ts는 config.ts를
 * 이미 값으로 import하므로(refreshEnv 등), 그 반대 방향으로 다시 import하면 순환이 생긴다.
 * 이 파일은 아무것도 import하지 않아 양쪽에서 안전하게 가져다 쓸 수 있다.
 */

/**
 * scheme·user·host·db는 남기고 비밀번호만 `***`로 바꾼다. 파싱조차 안 되면 null — 사람이 적은
 * 값을 화면과 supervisor.log에 원문으로 옮기지 않는다는 규칙에는 "가릴 자리를 못 찾았다"도
 * 포함된다. 부르는 쪽이 null을 값을 아예 보이지 않는 문구로 바꾼다.
 */
export function maskDatabaseUrl(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.password !== "") u.password = "***";
    return u.toString();
  } catch {
    return null;
  }
}
