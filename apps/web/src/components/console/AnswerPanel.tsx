import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import type { Answer } from "@/lib/types";
import type { RunState } from "@/lib/run";

// Tiny, safe Markdown subset: paragraphs, bullets, numbered lists, **bold**, `code`.
function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) return <code key={i}>{p.slice(1, -1)}</code>;
    return p;
  });
}

// Some writers put "1. ... 2. ... 3. ..." in one run-on line. Break those into list lines.
function splitInlineList(block: string): string {
  if (block.includes("\n")) return block;
  const marks: number[] = [];
  let want = 1;
  const re = /(^|\s)(\d{1,2})[.)]\s+(?=\S)/g;
  for (let m = re.exec(block); m; m = re.exec(block)) {
    if (Number(m[2]) === want) {
      marks.push(m.index + m[1]!.length);
      want += 1;
    }
  }
  if (marks.length < 2) return block;
  const head = block.slice(0, marks[0]).trim();
  const items = marks.map((at, i) => block.slice(at, marks[i + 1] ?? block.length).trim());
  return `${head ? `${head}\n\n` : ""}${items.join("\n")}`;
}

function renderBody(text: string): ReactNode[] {
  const blocks = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map(splitInlineList)
    .join("\n\n")
    .split(/\n{2,}/);
  const out: ReactNode[] = [];
  blocks.forEach((block, bi) => {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) return;
    const bullets = lines.every((l) => /^\s*[-*•]\s+/.test(l));
    const numbered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
    if (bullets) {
      out.push(
        <ul key={bi}>
          {lines.map((l, i) => (
            <li key={i}>{inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>
          ))}
        </ul>,
      );
    } else if (numbered) {
      out.push(
        <ol key={bi}>
          {lines.map((l, i) => (
            <li key={i}>{inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>
          ))}
        </ol>,
      );
    } else if (lines.length === 1 && /^#{1,4}\s+/.test(lines[0]!)) {
      out.push(<h4 key={bi}>{inline(lines[0]!.replace(/^#{1,4}\s+/, ""))}</h4>);
    } else {
      out.push(<p key={bi}>{inline(lines.join(" "))}</p>);
    }
  });
  return out;
}

export function AnswerPanel({ answer, state }: { answer: Answer; state: RunState }) {
  const cited = answer.citations.map((c) => ({ ...c, source: state.sources[c.url] }));
  return (
    <section className="card answer rise" aria-labelledby="answer-title">
      <div className="answer__head">
        <div>
          <p className="eyebrow">Final answer</p>
          <h2 id="answer-title">What the agent tells its owner</h2>
        </div>
        <span className="chip chip--mint">
          <Icon name="shield" size={13} /> Clean sources only
        </span>
      </div>
      <div className="answer__text">{renderBody(answer.answer)}</div>
      {cited.length ? (
        <div className="answer__cites">
          <p className="eyebrow">Citations</p>
          <ol>
            {cited.map((c, i) => (
              <li key={i}>
                <p className="cite__quote">&ldquo;{c.quote}&rdquo;</p>
                <p className="cite__src">
                  <span className="num">{String(i + 1)}</span>
                  <strong>{c.source?.title ?? c.url}</strong>
                  {c.source?.paid ? <span className="muted"> · receipt #{c.source.paid.receipt.receipt.seq}</span> : null}
                </p>
              </li>
            ))}
          </ol>
          <p className="muted">Quarantined and refunded sources were never shown to the writing model.</p>
        </div>
      ) : null}
    </section>
  );
}
