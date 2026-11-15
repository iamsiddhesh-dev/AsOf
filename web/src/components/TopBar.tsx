import { displayZone, formatTime } from "../lib/format.js";

type View = "reader" | "ledger";

type Props = {
  view: View;
  onView: (view: View) => void;
  now: Date;
  timezone: string;
};

export function TopBar({ view, onView, now, timezone }: Props) {
  const time = formatTime(now.toISOString(), timezone);
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(now);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">AsOf</span>
        <span className="brand-sub">claim ledger</span>
      </div>

      <nav className="views" aria-label="Views">
        <button
          type="button"
          className={view === "reader" ? "view-tab is-active" : "view-tab"}
          onClick={() => onView("reader")}
        >
          Reader
        </button>
        <button
          type="button"
          className={view === "ledger" ? "view-tab is-active" : "view-tab"}
          onClick={() => onView("ledger")}
        >
          Ledger
        </button>
      </nav>

      <div className="clock" title={`Ledger clock: ${timezone}`}>
        <span className="clock-date">{date}</span>
        <span className="clock-time">{time}</span>
        <span className="clock-zone">{displayZone(timezone)}</span>
      </div>
    </header>
  );
}
