import path from "node:path";

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value ?? ""}`);
  }
  return port;
}

export const config = {
  port: parsePort(process.env.PORT),
  databasePath: path.resolve(
    process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "asof.db"),
  ),
  timezone: process.env.DEFAULT_TIMEZONE ?? "Asia/Kolkata",
  demoMode: process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true",
} as const;
