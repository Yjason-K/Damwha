import { useEffect, useState } from 'react';
import { pickUiLanguage } from '@damwha/contracts';
import { ShareDocument } from '@damwha/share-view';
import { loadShare, type LoadResult } from './load-share';
import { viewerLanguage } from './language';

const MESSAGES = {
  ko: { loading: '불러오는 중…', invalid: '링크가 올바르지 않아요.', gone: '이 공유는 만료되었거나 중지되었어요.', error: '공유본을 불러오지 못했어요. 잠시 후 다시 열어 주세요.' },
  en: { loading: 'Loading…', invalid: 'This link is not valid.', gone: 'This share has expired or was stopped.', error: "Couldn't load this share. Please try again shortly." },
};

export function App() {
  const [result, setResult] = useState<LoadResult | null>(null);
  useEffect(() => {
    void loadShare(window.location).then(setResult);
  }, []);

  const browserLang = pickUiLanguage(navigator.languages);
  if (result === null) return <p className="viewer-state">{MESSAGES[browserLang].loading}</p>;
  if (result.kind !== 'ok') return <p className="viewer-state" role="alert">{MESSAGES[browserLang][result.kind]}</p>;
  const lang = viewerLanguage(navigator.languages, result.payload.ui_language);
  document.documentElement.lang = lang;
  return <ShareDocument payload={result.payload} lang={lang} expiresAt={result.expiresAt} />;
}
