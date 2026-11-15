import {
  displayZone,
  formatDate,
  formatDateTime,
  plural,
  titleCase,
} from "../lib/format.js";
import { sourceFromCitation, sourceFromTurn } from "../lib/sources.js";
import { partKindLabel, partList, type StreamState } from "../lib/stream.js";
import type {
  Citation,
  Conversation,
  SourceDetail,
  Turn,
  TurnSource,
} from "../lib/types.js";
import { Composer } from "./Composer.js";
import { Receipt, type LiveReceipt } from "./Receipt.js";
import { RichText } from "./RichText.js";
import { SourceChips } from "./SourceChips.js";
import { StepStatus } from "./Status.js";

type Props = {
  conversation: Conversation | null;
  turns: Turn[];
  timezone: string;
  stream: StreamState | null;
  receipts: Record<string, LiveReceipt>;
  draft: string;
  onDraftChange: (value: string) => void;
  onAsk: () => void;
  onStop: () => void;
  onOpenSource: (source: SourceDetail) => void;
  onNewConversation: () => void;
  onLoadDemo: () => void;
  demoAvailable: boolean;
  loading: boolean;
  booting: boolean;
};

function openTurnSource(label: string, sources: TurnSource[]): SourceDetail | null {
  const source = sources.find((candidate) => candidate.label === label);
  return source === undefined ? null : sourceFromTurn(source);
}

function openCitation(label: string, citations: Citation[]): SourceDetail | null {
  const citation = citations.find((candidate) => candidate.id === label);
  return citation === undefined ? null : sourceFromCitation(citation);
}

function TurnView({
  turn,
  timezone,
  live,
  onOpenSource,
}: {
  turn: Turn;
  timezone: string;
  live?: LiveReceipt;
  onOpenSource: (source: SourceDetail) => void;
}) {
  if (turn.role === "system" || turn.role === "tool") {
    return (
      <div className="turn turn-note">
        <span className="turn-kind">{turn.role}</span>
        <p>{turn.content}</p>
      </div>
    );
  }

  if (turn.role === "user") {
    return (
      <article className="turn turn-question">
        <div className="turn-label">
          <span className="turn-kind">Question</span>
          <time dateTime={turn.createdAt}>
            {formatDateTime(turn.createdAt, timezone)}
          </time>
          {turn.isDemo ? <span className="turn-tag">seeded</span> : null}
        </div>
        <p className="question-text">{turn.content}</p>
      </article>
    );
  }

  return (
    <article className="turn turn-answer">
      <RichText
        text={turn.content}
        sources={turn.sources}
        onCite={(label) => {
          const source = openTurnSource(label, turn.sources);
          if (source !== null) onOpenSource(source);
        }}
      />
      <SourceChips
        sources={turn.sources.map(sourceFromTurn)}
        onOpen={onOpenSource}
      />
      <Receipt turn={turn} live={live} />
    </article>
  );
}

function StreamAnswer({
  stream,
  timezone,
  onOpenSource,
}: {
  stream: StreamState;
  timezone: string;
  onOpenSource: (source: SourceDetail) => void;
}) {
  const parts = partList(stream.parts);
  const citations = stream.sources;

  return (
    <>
      <article className="turn turn-question">
        <div className="turn-label">
          <span className="turn-kind">Question</span>
          <time dateTime={new Date(stream.startedAt).toISOString()}>
            {formatDateTime(new Date(stream.startedAt).toISOString(), timezone)}
          </time>
          <span className="turn-tag turn-tag-live">now</span>
        </div>
        <p className="question-text">{stream.question}</p>
      </article>

      <article className="turn turn-answer is-streaming" aria-live="polite">
        <div className="stream-head">
          <span className="stream-dot" aria-hidden="true" />
          <span className="stream-status">
            {stream.decision === null
              ? "Resolving the question"
              : citations.length > 0
                ? `${plural(citations.length, "source")} returned`
                : titleCase(stream.decision.intent)}
          </span>
          {stream.decision?.timeRange !== null &&
          stream.decision?.timeRange !== undefined ? (
            <span className="stream-window">{stream.decision.timeRange.label}</span>
          ) : null}
        </div>

        {stream.steps.length > 0 ? (
          <ol className="step-list">
            {stream.steps.map((step, index) => (
              <li
                key={`${step.action}-${index}`}
                className={`step step-${step.status}`}
              >
                <StepStatus status={step.status} />
                <span className="step-action">{step.action}</span>
                {step.detail !== undefined ? (
                  <span className="step-detail">{step.detail}</span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}

        {citations.length > 0 ? (
          <SourceChips
            sources={citations.map(sourceFromCitation)}
            onOpen={onOpenSource}
            label="Sources returned"
          />
        ) : null}

        {parts.length === 0 ? (
          <p className="stream-wait">
            {stream.steps.some((step) => step.status === "running")
              ? "Working. The first token has not arrived yet."
              : "Waiting for the first token."}
          </p>
        ) : null}

        {parts.map((part, index) => {
          const label = part.kind === null ? null : partKindLabel(part.kind);
          return (
            <div key={part.index} className="stream-part">
              {label !== null ? <div className="part-kind">{label}</div> : null}
              <RichText
                text={part.text}
                sources={citations.map((citation) => ({ label: citation.id }))}
                caret={index === parts.length - 1}
                onCite={(citationLabel) => {
                  const source = openCitation(citationLabel, citations);
                  if (source !== null) onOpenSource(source);
                }}
              />
            </div>
          );
        })}
      </article>
    </>
  );
}

const STARTERS = [
  "What did I do yesterday?",
  "What do I currently believe about HubSpot's pricing?",
  "Find the current price of managed Postgres with daily backups.",
];

function Intro({
  onNewConversation,
  onLoadDemo,
  demoAvailable,
  onPick,
}: {
  onNewConversation: () => void;
  onLoadDemo: () => void;
  demoAvailable: boolean;
  onPick: (text: string) => void;
}) {
  return (
    <div className="intro">
      <div className="doc-kicker">A temporal ledger</div>
      <h1 className="intro-title">
        What was true,
        <br />
        and when you learned it.
      </h1>
      <p className="intro-lede">
        AsOf answers a question, then keeps the sentence it relied on, the page
        it came from, and the day it saw it. Ask what you did yesterday and it
        reads the ledger. Ask about a price and it checks whether the stored
        value still holds.
      </p>

      <ol className="intro-rules">
        <li>
          <span className="rule-number">01</span>
          <span>
            <strong>Every citation is a receipt.</strong> An answer is grounded
            only when it cites a source that was actually returned. Reopening
            the conversation keeps the footnotes.
          </span>
        </li>
        <li>
          <span className="rule-number">02</span>
          <span>
            <strong>Claims are append-only.</strong> A changed price is written
            as a new claim; the old one is marked superseded, never overwritten.
            The history stays readable.
          </span>
        </li>
        <li>
          <span className="rule-number">03</span>
          <span>
            <strong>Time is computed, never guessed.</strong> “Yesterday” is
            resolved in your timezone against the ledger clock, and the window
            that was used is printed with the answer.
          </span>
        </li>
      </ol>

      <div className="intro-actions">
        <button type="button" className="primary-button" onClick={onNewConversation}>
          Start a conversation
        </button>
        {demoAvailable ? (
          <button type="button" className="text-button" onClick={onLoadDemo}>
            Load demo history
          </button>
        ) : null}
      </div>

      <div className="intro-starters">
        <span className="intro-starters-label">Or ask</span>
        {STARTERS.map((starter) => (
          <button
            key={starter}
            type="button"
            className="starter"
            onClick={() => onPick(starter)}
          >
            {starter}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Reader({
  conversation,
  turns,
  timezone,
  stream,
  receipts,
  draft,
  onDraftChange,
  onAsk,
  onStop,
  onOpenSource,
  onNewConversation,
  onLoadDemo,
  demoAvailable,
  loading,
  booting,
}: Props) {
  const hasTurns = turns.length > 0;
  const demo = turns.some((turn) => turn.isDemo);
  const questions = turns.filter((turn) => turn.role === "user").length;

  return (
    <div className="reader">
      <div className="reader-scroll">
        <div className="column">
          {conversation === null ? (
            booting ? (
              <div className="doc-skeleton" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            ) : (
              <Intro
                onNewConversation={onNewConversation}
                onLoadDemo={onLoadDemo}
                demoAvailable={demoAvailable}
                onPick={onDraftChange}
              />
            )
          ) : (
            <>
              <header className="doc-head">
                <div className="doc-kicker">Conversation</div>
                <h1 className="doc-title">{conversation.title}</h1>
                <div className="doc-meta">
                  <span>{displayZone(timezone)}</span>
                  <span className="dot" aria-hidden="true">
                    ·
                  </span>
                  <span>opened {formatDate(conversation.createdAt, timezone)}</span>
                  <span className="dot" aria-hidden="true">
                    ·
                  </span>
                  <span>{plural(questions, "question")}</span>
                  {demo ? (
                    <>
                      <span className="dot" aria-hidden="true">
                        ·
                      </span>
                      <span className="doc-demo">seeded history</span>
                    </>
                  ) : null}
                </div>
              </header>

              {loading && !hasTurns ? (
                <div className="doc-skeleton" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}

              {!loading && !hasTurns && stream === null ? (
                <div className="quiet-start">
                  <p>
                    Nothing is stored in this conversation yet. Ask the first
                    question; the answer and its evidence will be written here.
                  </p>
                  <div className="starter-list">
                    {STARTERS.map((starter) => (
                      <button
                        key={starter}
                        type="button"
                        className="starter"
                        onClick={() => onDraftChange(starter)}
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {turns.map((turn) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  timezone={timezone}
                  live={receipts[turn.id]}
                  onOpenSource={onOpenSource}
                />
              ))}

              {stream !== null ? (
                <StreamAnswer
                  stream={stream}
                  timezone={timezone}
                  onOpenSource={onOpenSource}
                />
              ) : null}

              <div className="reader-tail" aria-hidden="true" />
            </>
          )}
        </div>
      </div>

      <Composer
        value={draft}
        onChange={onDraftChange}
        onSubmit={onAsk}
        onStop={onStop}
        streaming={stream !== null}
        placeholder={
          conversation === null
            ? "Ask the ledger a question…"
            : "Ask a follow-up, or what you did yesterday…"
        }
      />
    </div>
  );
}
