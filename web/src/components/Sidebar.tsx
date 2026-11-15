import { formatRelativeDay, plural } from "../lib/format.js";
import type { Conversation, Stats } from "../lib/types.js";

type Props = {
  conversations: Conversation[];
  activeId: string | null;
  timezone: string;
  now: Date;
  stats: Stats | null;
  demoAvailable: boolean;
  loading: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onLoadDemo: () => void;
};

export function Sidebar({
  conversations,
  activeId,
  timezone,
  now,
  stats,
  demoAvailable,
  loading,
  onSelect,
  onNew,
  onLoadDemo,
}: Props) {
  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="rail-title">Conversations</span>
        <button
          type="button"
          className="ghost-button"
          onClick={onNew}
          title="Start a new conversation"
        >
          + New
        </button>
      </div>

      <div className="rail-list">
        {loading && conversations.length === 0 ? (
          <div className="rail-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {!loading && conversations.length === 0 ? (
          <p className="rail-empty">
            No conversations yet. The first question creates one.
          </p>
        ) : null}

        {conversations.map((conversation) => {
          const active = conversation.id === activeId;
          return (
            <button
              key={conversation.id}
              type="button"
              className={active ? "rail-item is-active" : "rail-item"}
              onClick={() => onSelect(conversation.id)}
              aria-current={active ? "page" : undefined}
            >
              <span className="rail-item-title">{conversation.title}</span>
              <span className="rail-item-meta">
                {formatRelativeDay(conversation.updatedAt, timezone, now)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="rail-foot">
        {demoAvailable ? (
          <button
            type="button"
            className="demo-button"
            onClick={onLoadDemo}
            title="Seed three dated entries so recall and rechecks have something to read"
          >
            Load demo history
            <span className="demo-note">seeded, labelled as demo</span>
          </button>
        ) : null}

        <div className="rail-stats">
          <span>
            {stats === null
              ? "ledger unavailable"
              : `${plural(stats.counts.claims ?? 0, "claim")} · ${plural(
                  stats.counts.sources ?? 0,
                  "source",
                )}`}
          </span>
          <span className="rail-schema">
            {stats === null ? "" : `schema v${stats.schemaVersion} · local sqlite`}
          </span>
        </div>
      </div>
    </aside>
  );
}
