import { useLayoutEffect, useRef } from "react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder: string;
};

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  streaming,
  disabled = false,
  placeholder,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [value]);

  return (
    <div className="composer">
      <div className="composer-inner">
        <label className="visually-hidden" htmlFor="ask">
          Ask a question
        </label>
        <textarea
          id="ask"
          ref={ref}
          className="composer-input"
          rows={1}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!streaming && value.trim().length > 0) {
                onSubmit();
              }
            }
          }}
        />
        {streaming ? (
          <button type="button" className="ask-button is-stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="ask-button"
            onClick={onSubmit}
            disabled={disabled || value.trim().length === 0}
          >
            Ask
          </button>
        )}
      </div>
      <div className="composer-hint">
        {streaming
          ? "Streaming. The answer is stored only when it finishes."
          : "Enter to ask · Shift+Enter for a new line · timezone from this browser"}
      </div>
    </div>
  );
}
