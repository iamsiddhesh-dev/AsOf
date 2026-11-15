import type { SourceDetail } from "../lib/types.js";

type Props = {
  sources: SourceDetail[];
  onOpen: (source: SourceDetail) => void;
  label?: string;
};

/** The evidence strip. Used while an answer streams and on every stored answer. */
export function SourceChips({ sources, onOpen, label = "Sources" }: Props) {
  if (sources.length === 0) return null;

  return (
    <div className="source-strip" aria-label={label}>
      {sources.map((source) => (
        <button
          key={source.label}
          type="button"
          className="source-chip"
          onClick={() => onOpen(source)}
          title={source.title ?? source.url}
        >
          <span className="source-chip-label">{source.label}</span>
          <span className="source-chip-domain">{source.domain}</span>
        </button>
      ))}
    </div>
  );
}
