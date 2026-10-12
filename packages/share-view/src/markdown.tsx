import type * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/**
 * 공유본 메모 렌더러. 키가 페이지 URL(#)에 있으므로 XSS는 곧 키 유출이다 (spec §2.5).
 * `rehype-raw`를 붙이지 않아 raw HTML은 텍스트로 남고, 링크는 http(s)만 살린다.
 */
function SafeLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="sv-link">
      {children}
    </a>
  );
}

export function Markdown({ body }: { body: string }) {
  return (
    <div className="sv-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ a: SafeLink, img: () => null }}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
