import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

/**
 * The header clock is the server's clock, not the laptop's: with `FAKE_NOW`
 * set, the ledger's "today" and the header must agree or the premise looks
 * broken. Drift is measured once and applied to a local tick.
 */
export function useClock(): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  const skew = useRef(0);

  useEffect(() => {
    let cancelled = false;

    void api
      .health()
      .then((health) => {
        if (cancelled) return;
        skew.current = new Date(health.time).getTime() - Date.now();
        setNow(new Date(Date.now() + skew.current));
      })
      .catch(() => {
        // Offline UI still needs a clock; local time is the honest fallback.
      });

    const timer = window.setInterval(() => {
      setNow(new Date(Date.now() + skew.current));
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return now;
}
