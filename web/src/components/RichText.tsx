import type { ReactNode } from "react";

type Block =
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] };

/**
 * A deliberately small Markdown subset: headings, lists, quotes, bold, italic,
 * inline code. Enough for what a synthesis call actually emits, small enough
 * to read in one sitting. HTML in the answer is rendered as text, never parsed.
 */
function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: "p", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list !== null) {
      blocks.push({ type: "list", ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "h",
        level: heading[1].length,
        text: heading[2],
      });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      flushParagraph();
      flushList();
      blocks.push({ type: "quote", text: quote[1] });
      continue;
    }

    const unordered = /^[-*•]\s+(.*)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (unordered !== null || ordered !== null) {
      flushParagraph();
      const isOrdered = ordered !== null;
      if (list === null || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push((unordered ?? ordered)?.[1] ?? "");
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  return blocks;
}

const INLINE =
  /\[(s\d+)\]|\*\*([^*]+)\*\*|`([^`\n]+)`|\*([^*\n]+)\*|_([^_\n]+)_/g;

function renderInline(
  text: string,
  known: Set<string>,
  onCite: (label: string) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  INLINE.lastIndex = 0;
  let match = INLINE.exec(text);
  while (match !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    const [whole, label, bold, code, italic, underscore] = match;
    if (label !== undefined) {
      if (known.has(label)) {
        nodes.push(
          <button
            key={`cite-${key++}`}
            type="button"
            className="cite"
            onClick={() => onCite(label)}
            title="Open this source"
          >
            {label}
          </button>,
        );
      } else {
        nodes.push(
          <span
            key={`cite-${key++}`}
            className="cite cite-unknown"
            title="This citation was not among the answer's returned sources"
          >
            [{label}]
          </span>,
        );
      }
    } else if (bold !== undefined) {
      nodes.push(<strong key={`b-${key++}`}>{bold}</strong>);
    } else if (code !== undefined) {
      nodes.push(
        <code key={`c-${key++}`} className="inline-code">
          {code}
        </code>,
      );
    } else {
      nodes.push(<em key={`i-${key++}`}>{italic ?? underscore}</em>);
    }

    cursor = match.index + whole.length;
    match = INLINE.exec(text);
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

type Props = {
  text: string;
  sources: Array<{ label: string }>;
  onCite: (label: string) => void;
  /** A blinking caret at the end while tokens are still arriving. */
  caret?: boolean;
};

export function RichText({ text, sources, onCite, caret = false }: Props) {
  const known = new Set(sources.map((source) => source.label));
  const blocks = parseBlocks(text);

  const inline = (value: string): ReactNode[] =>
    renderInline(value, known, onCite);

  const caretNode = <span className="caret" aria-hidden="true" />;

  if (blocks.length === 0) {
    return <div className="prose">{caret ? caretNode : null}</div>;
  }

  return (
    <div className="prose">
      {blocks.map((block, index) => {
        const last = index === blocks.length - 1;

        if (block.type === "h") {
          return (
            <h4 key={index} className="prose-h">
              {inline(block.text)}
            </h4>
          );
        }

        if (block.type === "quote") {
          return (
            <blockquote key={index} className="prose-quote">
              {inline(block.text)}
            </blockquote>
          );
        }

        if (block.type === "list") {
          const items = block.items.map((item, itemIndex) => (
            <li key={itemIndex}>
              {inline(item)}
              {last && caret && itemIndex === block.items.length - 1
                ? caretNode
                : null}
            </li>
          ));
          return block.ordered ? (
            <ol key={index} className="prose-list">
              {items}
            </ol>
          ) : (
            <ul key={index} className="prose-list">
              {items}
            </ul>
          );
        }

        return (
          <p key={index} className="prose-p">
            {inline(block.text)}
            {last && caret ? caretNode : null}
          </p>
        );
      })}
    </div>
  );
}
