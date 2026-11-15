import type { Context } from "hono";
import { isValidTimeZone } from "../time/resolve.js";

/**
 * The browser owns the timezone (review item 21). The conversation default is
 * only a fallback, so "yesterday" means the user's yesterday.
 */
export function requestTimezone(c: Context, fallback: string): string | null {
  const header = c.req.header("x-timezone");
  if (header !== undefined && header.trim().length > 0) {
    return isValidTimeZone(header.trim()) ? header.trim() : null;
  }

  const query = c.req.query("timezone");
  if (query !== undefined && query.trim().length > 0) {
    return isValidTimeZone(query.trim()) ? query.trim() : null;
  }

  return fallback;
}
