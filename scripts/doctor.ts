/**
 * Pre-flight check. Run this before blaming the code.
 *
 * It answers three questions a wrong `.env` makes painful to debug:
 *   1. are the required keys present?
 *   2. does each key belong to the provider its base URL points at?
 *   3. does that provider actually serve the model ID we configured?
 *
 *   npm run doctor
 *
 * No model is called, so it costs no tokens. Tavily is checked for presence
 * only: verifying a search key would spend one of its monthly credits.
 */
import { config, missingKeys } from "../src/config.js";
import { dotEnvExists, dotEnvPath, loadedEnvKeys } from "../src/env.js";

type Provider = {
  role: "main" | "fast";
  baseUrl: string;
  apiKey: string | null;
  model: string;
};

type ModelsBody = {
  data?: Array<{ id?: string }>;
};

type Check = { ok: boolean; label: string; detail: string };

const providers: Provider[] = [
  {
    role: "main",
    baseUrl: config.model.main.baseUrl.replace(/\/+$/, ""),
    apiKey: config.model.main.apiKey,
    model: config.model.main.model,
  },
  {
    role: "fast",
    baseUrl: config.model.fast.baseUrl.replace(/\/+$/, ""),
    apiKey: config.model.fast.apiKey,
    model: config.model.fast.model,
  },
];

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) {
    return "••••";
  }
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Keys carry their provider's fingerprint. A mismatch is a five-minute bug. */
function expectedKeyOwner(baseUrl: string): { prefix: string; name: string } | null {
  const host = hostOf(baseUrl).toLowerCase();
  if (host === "api.groq.com" || host.endsWith(".groq.com")) {
    return { prefix: "gsk_", name: "Groq" };
  }
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) {
    return { prefix: "sk-or-", name: "OpenRouter" };
  }
  if (host.endsWith("googleapis.com")) {
    return { prefix: "AIza", name: "Google AI Studio" };
  }
  return null;
}

function headers(provider: Provider): Record<string, string> {
  const out: Record<string, string> = { authorization: `Bearer ${provider.apiKey ?? ""}` };
  const host = hostOf(provider.baseUrl).toLowerCase();
  if (host.endsWith("openrouter.ai")) {
    out["http-referer"] = "https://github.com/iamsiddhesh-dev/AsOf";
    out["x-title"] = "AsOf doctor";
  }
  return out;
}

async function checkProvider(provider: Provider): Promise<Check[]> {
  const checks: Check[] = [];
  const where = `${provider.role} (${hostOf(provider.baseUrl)})`;

  if (provider.apiKey === null) {
    checks.push({ ok: false, label: where, detail: "no API key set" });
    return checks;
  }

  checks.push({
    ok: true,
    label: where,
    detail: `key ${maskKey(provider.apiKey)}`,
  });

  const owner = expectedKeyOwner(provider.baseUrl);
  if (owner !== null) {
    const matches = provider.apiKey.startsWith(owner.prefix);
    checks.push({
      ok: matches,
      label: `${provider.role} key`,
      detail: matches
        ? `looks like a ${owner.name} key`
        : `expected a ${owner.name} key starting ${owner.prefix} — this looks like another provider's key, so the base URL and key disagree`,
    });
  }

  try {
    const response = await fetch(`${provider.baseUrl}/models`, {
      headers: headers(provider),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as ModelsBody | null;

    if (!response.ok) {
      checks.push({
        ok: false,
        label: `${provider.role} auth`,
        detail: `GET /models returned ${response.status} — key rejected or base URL wrong`,
      });
      return checks;
    }

    checks.push({ ok: true, label: `${provider.role} auth`, detail: "GET /models accepted" });

    const ids = Array.isArray(body?.data)
      ? body.data
          .map((row) => row.id)
          .filter((id): id is string => typeof id === "string")
      : [];

    if (ids.length === 0) {
      checks.push({
        ok: true,
        label: `${provider.role} model`,
        detail: `${provider.model} (provider did not list models, cannot verify the ID)`,
      });
      return checks;
    }

    const listed = ids.includes(provider.model);
    checks.push({
      ok: listed,
      label: `${provider.role} model`,
      detail: listed
        ? `${provider.model} is served`
        : `${provider.model} is NOT served — available: ${ids.join(", ")}`,
    });
  } catch (error) {
    checks.push({
      ok: false,
      label: `${provider.role} auth`,
      detail: `could not reach ${provider.baseUrl}: ${(error as Error).message}`,
    });
  }

  return checks;
}

function mark(ok: boolean): string {
  return ok ? "pass" : "FAIL";
}

async function main(): Promise<void> {
  console.log("");
  console.log("AsOf doctor");
  console.log("");

  console.log(
    dotEnvExists()
      ? `env       ${dotEnvPath()} — ${loadedEnvKeys().length} key(s) loaded`
      : `env       no .env at ${dotEnvPath()} — relying on the real environment`,
  );

  const missing = missingKeys();
  if (missing.length > 0) {
    console.log(`keys      missing: ${missing.join(", ")}`);
  } else {
    console.log("keys      LLM_API_KEY, TAVILY_API_KEY present");
  }

  console.log(
    `clock     ${config.fakeNow === null ? "real time" : `faked at ${config.fakeNow}`}  ·  ${config.timezone}`,
  );
  console.log("");

  const checks: Check[] = [];

  for (const provider of providers) {
    checks.push(...(await checkProvider(provider)));
  }

  checks.push(
    config.search.apiKey === null
      ? { ok: false, label: `${config.search.name} search`, detail: "no API key set" }
      : {
          ok: true,
          label: `${config.search.name} search`,
          detail: `key ${maskKey(config.search.apiKey)} (not pinged: a search check spends a credit)`,
        },
  );

  for (const check of checks) {
    console.log(`${mark(check.ok)}  ${check.label.padEnd(18)} ${check.detail}`);
  }

  console.log("");

  const failures = checks.filter((check) => !check.ok);
  if (failures.length > 0 || missing.length > 0) {
    console.log(`${failures.length + missing.length} problem(s). Fix these before running the app.`);
    console.log("");
    process.exitCode = 1;
    return;
  }

  console.log("everything configured. Next: npm run probe:models -- --finalists");
  console.log("");
}

await main();
