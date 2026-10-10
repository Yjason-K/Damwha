import { expect, it } from 'vitest';
import { viewerLanguage } from '../src/language';

it('브라우저 언어가 ko/en이면 그것', () => {
  expect(viewerLanguage(['ko-KR'], 'en')).toBe('ko');
  expect(viewerLanguage(['en-US'], 'ko')).toBe('en');
  expect(viewerLanguage(['ja-JP', 'en-GB'], 'ko')).toBe('en');
});

it('둘 다 아니면 공유한 사람의 언어', () => {
  expect(viewerLanguage(['ja-JP'], 'ko')).toBe('ko');
  expect(viewerLanguage([], 'en')).toBe('en');
});
