import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectLang, msg, MESSAGES } from '../src/messages';

describe('messages', () => {
  it('en and ko have same keys', () => {
    expect(Object.keys(MESSAGES.en).sort()).toEqual(Object.keys(MESSAGES.ko).sort());
  });

  it('ko quotes the spec wording', () => {
    expect(msg('ko', 'notRunning')).toBe('담화가 실행 중이 아닙니다. 담화를 실행하면 사용할 수 있습니다.');
    expect(msg('ko', 'starting')).toBe('담화가 아직 준비 중입니다. 잠시 후 다시 시도하세요.');
    expect(msg('ko', 'noMeSpeaker')).toBe('담화에서 본인 화자를 지정해야 합니다(화자 → 나로 표시)');
  });

  it('interpolates params', () => {
    expect(msg('en', 'invalidOption', { option: 'preset', allowed: 'light, standard' })).toContain('preset');
    expect(msg('en', 'invalidOption', { option: 'preset', allowed: 'light, standard' })).toContain('light, standard');
  });
});

describe('detectLang', () => {
  it('reads ui-language.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damwha-lang-'));
    writeFileSync(join(dir, 'ui-language.json'), JSON.stringify({ language: 'ko' }));
    expect(await detectLang(dir)).toBe('ko');
    writeFileSync(join(dir, 'ui-language.json'), JSON.stringify({ language: 'en' }));
    expect(await detectLang(dir)).toBe('en');
  });

  it('falls back to a ko/en result when the file is missing or broken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damwha-lang-'));
    expect(['ko', 'en']).toContain(await detectLang(dir));
    writeFileSync(join(dir, 'ui-language.json'), '{broken');
    expect(['ko', 'en']).toContain(await detectLang(dir));
    writeFileSync(join(dir, 'ui-language.json'), JSON.stringify({ language: 'fr' }));
    expect(['ko', 'en']).toContain(await detectLang(dir));
  });
});
