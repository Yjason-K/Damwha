import type * as React from 'react';
import type { UiLanguage } from '@damwha/contracts';
import type { ShareLens, SharePayloadV1, ShareSpeaker } from '@damwha/share-format';
import { clock, dateTime } from './format';
import { Markdown } from './markdown';
import { viewerStrings, type ViewerStrings } from './strings';

const LENS_ORDER = ['decision', 'action', 'promise'] as const;

function nameOf(speakers: ShareSpeaker[], ref: string | null, s: ViewerStrings): string {
  if (ref === null) return '';
  const sp = speakers.find((x) => x.ref === ref);
  return sp?.name ?? s.speaker(Number(ref.slice(1)));
}

function scrollToUtterance(ms: number) {
  document.querySelector<HTMLElement>(`[data-sv-start="${ms}"]`)?.scrollIntoView({ block: 'center' });
}

function Time({ ms, linkable, s }: { ms: number | null; linkable: boolean; s: ViewerStrings }) {
  if (ms === null) return null;
  const t = clock(ms);
  if (!linkable) return <span className="sv-time">{t}</span>;
  return (
    <button type="button" className="sv-time sv-time-link" aria-label={s.jumpTo(t)} onClick={() => scrollToUtterance(ms)}>
      {t}
    </button>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="sv-section" aria-labelledby={id}>
      <h2 id={id} className="sv-h2">{title}</h2>
      {children}
    </section>
  );
}

/** 복호화한 공유본을 그린다. 없는 섹션·빈 섹션은 제목째 그리지 않는다. */
export function ShareDocument({ payload, lang, expiresAt }: { payload: SharePayloadV1; lang: UiLanguage; expiresAt: string | null }) {
  const s = viewerStrings(lang);
  const hasTranscript = (payload.transcript?.length ?? 0) > 0;
  const lensesBy = (kind: ShareLens['kind']) => (payload.lenses ?? []).filter((l) => l.kind === kind);
  const summary = payload.summary;
  const showSummary = summary !== undefined && (summary.topics.length > 0 || summary.segments.length > 0);

  return (
    <article className="sv-root">
      <header className="sv-header">
        <h1 className="sv-h1">{payload.meeting.title ?? s.untitled}</h1>
        <p className="sv-meta">
          {dateTime(payload.meeting.recorded_at, lang)}
          {payload.meeting.duration_ms !== null && <> · {clock(payload.meeting.duration_ms)}</>}
        </p>
      </header>

      {showSummary && (
        <Section id="sv-summary" title={s.summary}>
          {summary.topics.length > 0 && (
            <ul className="sv-topics" aria-label={s.topics}>
              {summary.topics.map((t) => <li key={t} className="sv-chip">{t}</li>)}
            </ul>
          )}
          {summary.segments.map((seg) => (
            <div key={`${seg.start_ms}-${seg.title}`} className="sv-segment">
              <h3 className="sv-h3">
                <Time ms={seg.start_ms} linkable={hasTranscript} s={s} /> {seg.title}
              </h3>
              <ul className="sv-bullets">{seg.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </div>
          ))}
        </Section>
      )}

      {LENS_ORDER.map((kind) => {
        const items = lensesBy(kind);
        if (items.length === 0) return null;
        return (
          <Section key={kind} id={`sv-lens-${kind}`} title={s[kind]}>
            <ul className="sv-lenses">
              {items.map((l, i) => (
                <li key={i} className={l.done ? 'sv-lens sv-done' : 'sv-lens'}>
                  <span className="sv-lens-text">{l.text}</span>
                  <span className="sv-lens-meta">
                    {l.done && <span className="sv-badge">{s.done}</span>}
                    {l.assignee_ref && <span>{nameOf(payload.speakers, l.assignee_ref, s)}</span>}
                    {l.due_at && <span>{s.due(l.due_at)}</span>}
                    <Time ms={l.start_ms} linkable={l.linkable && hasTranscript} s={s} />
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        );
      })}

      {hasTranscript && (
        <Section id="sv-transcript" title={s.transcript}>
          <ol className="sv-utterances">
            {payload.transcript!.map((u, i) => (
              <li key={i} className="sv-utterance" data-sv-start={u.start_ms}>
                <span className="sv-speaker">{nameOf(payload.speakers, u.speaker_ref, s)}</span>
                <span className="sv-time">{clock(u.start_ms)}</span>
                <p className="sv-text">{u.text}</p>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {payload.note && (
        <Section id="sv-note" title={s.note}>
          <Markdown body={payload.note.body_md} />
        </Section>
      )}

      <footer className="sv-footer">
        <p>
          {s.madeWith}
          {expiresAt && <> · {s.expires(dateTime(expiresAt, lang))}</>}
        </p>
        <p>{s.snapshot}</p>
      </footer>
    </article>
  );
}
