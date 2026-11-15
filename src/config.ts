import path from "node:path";

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value ?? ""}`);
  }
  return port;
}

function parseFakeNow(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid FAKE_NOW: ${value}`);
  }
  return date.toISOString();
}

export const config = {
  port: parsePort(process.env.PORT),
  databasePath: path.resolve(
    process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "asof.db"),
  ),
  timezone: process.env.DEFAULT_TIMEZONE ?? "Asia/Kolkata",
  demoMode: process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true",
  /**
   * One clock for the whole app. The eval harness, the demo and the reviewer
   * all need to run the same code at a different "now".
   */
  fakeNow: parseFakeNow(process.env.FAKE_NOW),
} as const;
