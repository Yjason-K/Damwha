/**
 * 투어가 도는 중인가 — driver.js를 물고 있는 `lib/tour-runner`를 import하지 않고도 알아야
 * 하는 쪽(회의 생성 모달)을 위한 런타임 플래그. tour-runner가 start/destroy에서 갱신한다.
 * 여기에 두는 이유는 번들이다: 투어 코드는 데모 빌드에서만 lazy로 붙고, 이 파일은 의존성이
 * 없어 어디서 import해도 driver.js를 끌고 오지 않는다.
 */
let active = false;

export function setTourActive(value: boolean): void {
  active = value;
}

export function isTourActive(): boolean {
  return active;
}
