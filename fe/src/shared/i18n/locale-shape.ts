/**
 * 사전의 모양 — 값이 문자열인 자리는 아무 문자열이나, 객체인 자리는 같은 키의 객체.
 * `en`이 `satisfies LocaleShape<typeof ko>`를 걸어 키가 빠지거나 남으면 `tsc -b`가 실패한다
 * (다국어 스펙 §4.3). 복수형 키는 ko에도 `_one`·`_other`를 둘 다 둬야 모양이 같다.
 */
export type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};
