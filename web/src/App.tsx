import { useEffect, useMemo, useRef, useState } from "react";
import { Inspector } from "./components/Inspector.js";
import { LedgerView } from "./components/LedgerView.js";
import { Reader } from "./components/Reader.js";
import type { LiveReceipt } from "./components/Receipt.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopBar } from "./components/TopBar.js";
import { api, askStream, browserTimezone, type StreamOutcome } from "./lib/api.js";
import { appendDelta, upsertStep, type StreamState } from "./lib/stream.js";
import type {
  Conversation,
  InspectorTarget,
  SourceDetail,
  Stats,
  Turn,
} from "./lib/types.js";
import { useClock } from "./lib/useClock.js";

type View = "reader" | "ledger";

type Notice = {
  kind: "error" | "info";
  message: string;
  hint?: string;
};

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export default function App() {
  const clock = useClock();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<Conversation | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [view, setView] = useState<View>("reader");
  const [inspector, setInspector] = useState<InspectorTarget | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [demo, setDemo] = useState<"unknown" | "absent" | "loaded">("unknown");
  const [stream, setStream] = useState<StreamState | null>(null);
  const [receipts, setReceipts] = useState<Record<string, LiveReceipt>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [draft, setDraft] = useState("");
  const [booting, setBooting] = useState(true);
  const [ledgerVersion, setLedgerVersion] = useState(0);

  const activeIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopReason = useRef<"user" | "switch" | null>(null);

  const browserZone = useMemo(() => browserTimezone(), []);
  const timezone = active?.timezone ?? browserZone;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [list, statsBody, demoBody] = await Promise.all([
          api.listConversations(),
          api.stats(),
          api.demoState(),
        ]);
        if (cancelled) return;

        setConversations(list.conversations);
        setStats(statsBody);
        setDemo(demoBody.loaded ? "loaded" : "absent");

        const first = list.conversations[0];
        if (first !== undefined) {
          activeIdRef.current = first.id;
          setActiveId(first.id);
        }
      } catch {
        if (!cancelled) {
          setNotice({
            kind: "error",
            message: "Could not reach the API.",
            hint: "Start the server with npm run dev, then reload.",
          });
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Load the selected conversation's turns. The stream is cleared separately so
  // switching mid-answer cannot show one conversation's tokens under another.
  useEffect(() => {
    if (activeId === null) {
      setActive(null);
      setTurns([]);
      return;
    }

    let cancelled = false;
    setTurnsLoading(true);

    void (async () => {
      try {
        const [conversation, body] = await Promise.all([
          api.getConversation(activeId),
          api.listTurns(activeId),
        ]);
        if (cancelled) return;
        setActive(conversation);
        setTurns(body.turns);
      } catch (cause) {
        if (!cancelled) {
          setNotice({
            kind: "error",
            message: errorMessage(cause, "Could not open that conversation."),
          });
        }
      } finally {
        if (!cancelled) setTurnsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    document.title =
      active === null ? "AsOf — claim ledger" : `${active.title} — AsOf`;
  }, [active]);

  useEffect(() => {
    if (inspector === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setInspector(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspector]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function refreshTurns(id: string): Promise<boolean> {
    try {
      const body = await api.listTurns(id);
      if (activeIdRef.current === id) setTurns(body.turns);
      return true;
    } catch {
      return false;
    }
  }

  function refreshConversations(): void {
    void api
      .listConversations()
      .then((body) => setConversations(body.conversations))
      .catch(() => {
        // The reader still works; the rail is just stale.
      });
  }

  function refreshStats(): void {
    void api
      .stats()
      .then(setStats)
      .catch(() => {
        // Counts are decoration, not the answer.
      });
  }

  function selectConversation(id: string): void {
    if (id === activeIdRef.current) {
      setView("reader");
      return;
    }

    if (abortRef.current !== null) {
      stopReason.current = "switch";
      abortRef.current.abort();
      abortRef.current = null;
    }

    setStream(null);
    setInspector(null);
    setNotice(null);
    setView("reader");
    setDraft("");

    activeIdRef.current = id;
    setActiveId(id);
  }

  async function createConversation(): Promise<Conversation | null> {
    try {
      const conversation = await api.createConversation();
      setConversations((previous) => [conversation, ...previous]);
      activeIdRef.current = conversation.id;
      setActiveId(conversation.id);
      setActive(conversation);
      setTurns([]);
      setView("reader");
      setInspector(null);
      setNotice(null);
      return conversation;
    } catch (cause) {
      setNotice({
        kind: "error",
        message: errorMessage(cause, "Could not start a conversation."),
      });
      return null;
    }
  }

  async function loadDemo(): Promise<void> {
    try {
      const body = await api.loadDemo();
      setDemo("loaded");
      activeIdRef.current = body.conversation.id;
      setActiveId(body.conversation.id);
      setActive(body.conversation);
      setView("reader");
      setDraft("");
      setNotice({
        kind: "info",
        message: "Demo history loaded.",
        hint: "The seeded turns are labelled as demo, so recall never passes them off as your own words.",
      });
      refreshConversations();
      refreshStats();
      setLedgerVersion((value) => value + 1);
    } catch (cause) {
      setNotice({
        kind: "error",
        message: errorMessage(cause, "Could not load the demo history."),
      });
    }
  }

  function stop(): void {
    stopReason.current = "user";
    abortRef.current?.abort();
    abortRef.current = null;
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (text.length === 0 || stream !== null) return;

    let conversation = active;
    if (conversation === null && activeIdRef.current !== null) {
      try {
        conversation = await api.getConversation(activeIdRef.current);
        setActive(conversation);
      } catch {
        conversation = null;
      }
    }
    if (conversation === null) {
      conversation = await createConversation();
    }
    if (conversation === null) return;

    const conversationId = conversation.id;
    setDraft("");
    setNotice(null);
    setStream({
      question: text,
      decision: null,
      steps: [],
      sources: [],
      parts: {},
      startedAt: Date.now(),
    });

    const controller = new AbortController();
    abortRef.current = controller;
    stopReason.current = null;

    let outcome: StreamOutcome | null = null;
    try {
      outcome = await askStream(
        conversationId,
        text,
        {
          onDecision: (decision) =>
            setStream((previous) =>
              previous === null ? previous : { ...previous, decision },
            ),
          onStep: (step) =>
            setStream((previous) =>
              previous === null
                ? previous
                : { ...previous, steps: upsertStep(previous.steps, step) },
            ),
          onSources: (citations) =>
            setStream((previous) =>
              previous === null ? previous : { ...previous, sources: citations },
            ),
          onBlock: (block) =>
            setStream((previous) =>
              previous === null
                ? previous
                : {
                    ...previous,
                    parts: {
                      ...previous.parts,
                      [block.index]: { text: block.text, kind: block.kind },
                    },
                  },
            ),
          onDelta: (index, delta) =>
            setStream((previous) =>
              previous === null
                ? previous
                : { ...previous, parts: appendDelta(previous.parts, index, delta) },
            ),
        },
        controller.signal,
      );
    } catch (cause) {
      if (!controller.signal.aborted) {
        setNotice({
          kind: "error",
          message: errorMessage(cause, "The answer stream failed."),
        });
      }
    } finally {
      abortRef.current = null;
    }

    if (controller.signal.aborted) {
      if (stopReason.current === "user") {
        setNotice({
          kind: "info",
          message: "Stopped before the answer finished.",
          hint: "The partial answer and the question were not stored, because the plan never completed.",
        });
      }
      stopReason.current = null;
      setStream(null);
      await refreshTurns(conversationId);
      return;
    }

    if (outcome === null) {
      setStream(null);
      setNotice({ kind: "error", message: "The stream ended without an answer." });
      await refreshTurns(conversationId);
      return;
    }

    if (!outcome.ok) {
      setStream(null);
      setNotice({
        kind: "error",
        message: outcome.message,
        hint:
          outcome.error?.retryable === true
            ? "The provider asked for a retry. The question was recorded; the answer was not."
            : outcome.error?.provider !== null &&
                outcome.error?.provider !== undefined
              ? `Provider: ${outcome.error.provider}`
              : undefined,
      });
      await refreshTurns(conversationId);
      return;
    }

    const result = outcome.result;
    setReceipts((previous) => ({
      ...previous,
      [result.assistantTurnId]: {
        grounded: result.grounded,
        steps: result.steps,
        claims: result.claims,
        claimsStatus: result.claimsStatus,
      },
    }));

    const loaded = await refreshTurns(conversationId);
    if (loaded) setStream(null);

    refreshConversations();
    refreshStats();
    setLedgerVersion((value) => value + 1);
  }

  function openSource(source: SourceDetail): void {
    setInspector({ kind: "source", source });
  }

  function openClaim(claimId: string): void {
    setInspector({ kind: "claim", claimId });
  }

  function openConversation(conversationId: string): void {
    setInspector(null);
    if (conversationId.length === 0) return;
    if (conversationId === activeIdRef.current) {
      setView("reader");
      return;
    }
    selectConversation(conversationId);
  }

  return (
    <div className="app" data-inspector={inspector === null ? "closed" : "open"}>
      <TopBar view={view} onView={setView} now={clock} timezone={timezone} />

      <Sidebar
        conversations={conversations}
        activeId={activeId}
        timezone={timezone}
        now={clock}
        stats={stats}
        demoAvailable={demo === "absent"}
        loading={booting}
        onSelect={selectConversation}
        onNew={() => void createConversation()}
        onLoadDemo={() => void loadDemo()}
      />

      <main className="stage">
        {notice !== null ? (
          <div
            className={`notice notice-${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            <span className="notice-mark" aria-hidden="true">
              {notice.kind === "error" ? "!" : "i"}
            </span>
            <div className="notice-body">
              <p>{notice.message}</p>
              {notice.hint !== undefined ? (
                <p className="notice-hint">{notice.hint}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ) : null}

        {view === "reader" ? (
          <Reader
            conversation={active}
            turns={turns}
            timezone={timezone}
            stream={stream}
            receipts={receipts}
            draft={draft}
            onDraftChange={setDraft}
            onAsk={() => void send()}
            onStop={stop}
            onOpenSource={openSource}
            onNewConversation={() => void createConversation()}
            onLoadDemo={() => void loadDemo()}
            demoAvailable={demo === "absent"}
            loading={turnsLoading}
            booting={booting}
          />
        ) : (
          <LedgerView
            timezone={timezone}
            refreshToken={ledgerVersion}
            onOpenClaim={openClaim}
          />
        )}
      </main>

      {inspector !== null ? (
        <Inspector
          target={inspector}
          timezone={timezone}
          onClose={() => setInspector(null)}
          onOpenConversation={openConversation}
        />
      ) : null}
    </div>
  );
}
