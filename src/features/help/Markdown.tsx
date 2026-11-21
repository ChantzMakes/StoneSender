/** Renders lib/markdown blocks as React elements (no HTML strings). */
import { Fragment } from 'react';
import type { Block, Inline } from '@/lib/markdown';

function Inlines({ c }: { c: Inline[] }) {
  return (
    <>
      {c.map((x, i) => {
        switch (x.t) {
          case 'text':
            return <Fragment key={i}>{x.v}</Fragment>;
          case 'b':
            return (
              <strong key={i} className="font-semibold text-foreground">
                <Inlines c={x.c} />
              </strong>
            );
          case 'i':
            return (
              <em key={i}>
                <Inlines c={x.c} />
              </em>
            );
          case 'code':
            return (
              <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                {x.v}
              </code>
            );
          case 'link': {
            // In-guide anchors are links. Web addresses are shown as copyable text: the desktop
            // window has no browser to open them in. Anything else renders as plain text.
            if (x.href.startsWith('#'))
              return (
                <a key={i} href={x.href} className="text-primary underline">
                  <Inlines c={x.c} />
                </a>
              );
            if (/^https?:\/\//.test(x.href))
              return (
                <span key={i}>
                  <Inlines c={x.c} /> (<span className="selectable font-mono text-[0.85em] break-all">{x.href}</span>)
                </span>
              );
            return <Inlines key={i} c={x.c} />;
          }
        }
      })}
    </>
  );
}

export function Markdown({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': {
            const cls = ['', 'text-2xl font-bold mb-3', 'text-xl font-semibold mt-8 mb-2 border-b pb-1', 'text-base font-semibold mt-6 mb-1.5', 'text-sm font-semibold mt-4 mb-1'][b.level];
            const H = `h${b.level}` as 'h1';
            return (
              <H key={i} id={`help-${b.id}`} className={cls} data-section={b.id}>
                <Inlines c={b.c} />
              </H>
            );
          }
          case 'p':
            return (
              <p key={i} className="my-2 leading-relaxed">
                <Inlines c={b.c} />
              </p>
            );
          case 'ul':
          case 'ol': {
            const L = b.t;
            return (
              <L key={i} start={b.t === 'ol' ? b.start : undefined} className={`my-2 flex flex-col gap-1 pl-6 leading-relaxed ${b.t === 'ol' ? 'list-decimal' : 'list-disc'}`}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inlines c={it} />
                  </li>
                ))}
              </L>
            );
          }
          case 'quote':
            return (
              <blockquote key={i} className="my-3 rounded-md border-l-4 border-warning bg-warning/10 px-3 py-1">
                <Markdown blocks={b.c} />
              </blockquote>
            );
          case 'pre':
            return (
              <pre key={i} className="selectable my-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                {b.v}
              </pre>
            );
          case 'table':
            return (
              <table key={i} className="my-3 w-full border-collapse text-left text-xs">
                <thead>
                  <tr>
                    {b.head.map((c, j) => (
                      <th key={j} className="border-b px-2 py-1 font-semibold">
                        <Inlines c={c} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, k) => (
                        <td key={k} className="border-b px-2 py-1 align-top">
                          <Inlines c={c} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
        }
      })}
    </>
  );
}
