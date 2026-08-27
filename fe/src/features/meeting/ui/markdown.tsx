import type * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 메모 본문 렌더러. `rehype-raw`를 붙이지 않으므로 raw HTML은 살아나지 않고
 * 텍스트로 남는다 — 별도 sanitizer도 dangerouslySetInnerHTML도 쓰지 않는
 * 이유가 이것이다.
 *
 * @tailwindcss/typography 대신 컴포넌트 매핑으로 Timbre semantic 토큰을 직접
 * 적용한다. 플러그인의 자체 색·간격 스케일이 토큰과 경쟁하는 상황을 피한다.
 */
function SafeLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  // javascript: 같은 스킴을 링크로 만들지 않는다. 통과한 것만 새 탭으로.
  const safe = href && /^https?:\/\//i.test(href);
  if (!safe) return <span>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:no-underline"
    >
      {children}
    </a>
  );
}

export function Markdown({ body }: { body: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-base font-semibold text-foreground">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-semibold text-foreground">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-medium text-[color:var(--text-muted)]">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="text-sm">{children}</p>,
          ul: ({ children }) => (
            <ul className="flex list-disc flex-col gap-1 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="flex list-decimal flex-col gap-1 pl-5">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="text-sm">{children}</li>,
          a: SafeLink,
          // 이미지 첨부는 스펙 비목표다. <img>를 그대로 그리면 뷰어가 열 때마다
          // 외부 URL로 요청이 나가 로컬 전용 제품 전제를 깬다 — alt 텍스트만
          // 남기고 태그 자체를 없앤다.
          img: ({ alt }) => (
            <span
              className="text-[color:var(--text-faint)]"
              title="메모에서는 이미지가 보이지 않아요."
            >
              {alt && alt.trim().length > 0 ? alt : "[이미지]"}
            </span>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 text-[color:var(--text-muted)]">
              {children}
            </blockquote>
          ),
          // react-markdown v10은 인라인 코드와 펜스 블록을 구분하는 `inline` prop을
          // 더 이상 넘기지 않는다(언어 지정이 없는 펜스 블록은 className도 없어
          // node만으로도 구분 불가) — 실제 DOM에서 블록 코드는 항상 `pre` 안에
          // 있으므로 CSS로 가른다. `pre` 자손일 때만 배경·패딩을 지워 pre가 만드는
          // 박스 안에 박스가 겹치지 않게 한다.
          code: ({ children }) => (
            <code className="rounded-sm bg-[var(--surface-hover)] px-1 py-0.5 font-mono text-2xs [pre_&]:rounded-none [pre_&]:bg-transparent [pre_&]:px-0 [pre_&]:py-0">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-sm bg-[var(--surface-hover)] p-2 font-mono text-2xs">
              {children}
            </pre>
          ),
          hr: () => <hr className="border-border" />,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-2xs">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1">{children}</td>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
