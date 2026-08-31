import fs from "node:fs";
import path from "node:path";

const DEFAULT_API_URL = "https://rodeo-data-api.psides83.workers.dev";
const DEFAULT_LIMIT = 5;
const DEFAULT_BATCH_DELAY_MS = 2000;

function argValue(name) {
  const prefixed = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefixed));
  if (match) return match.slice(prefixed.length);

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];

  return null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function loadEnvFile(fileName) {
  const filePath = path.join(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) return {};

  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const [key, ...valueParts] = line.split("=");
        const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
        return [key.trim(), value];
      })
  );
}

function numberOption(name, fallback, min, max) {
  const raw = argValue(name);
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} must be a number`);
  }

  return Math.min(Math.max(Math.floor(value), min), max);
}

function timestamp() {
  return new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }

  return body;
}

function printRecentRodeos(recentRodeos) {
  for (const rodeo of recentRodeos.slice(0, 5)) {
    const name = rodeo.rodeo_name ?? rodeo.rodeo_id;
    const rows = Number(rodeo.result_rows_count ?? 0);
    log(`recent: ${name} (${rodeo.month}) ${rodeo.status}, ${rows} result rows`);
  }
}

async function main() {
  if (hasFlag("help")) {
    console.log(`
Usage:
  npm run backfill:monthly-money -- --year=2026

Options:
  --year=2026                 Year to backfill. Defaults to the current year.
  --limit=5                   Rodeos per batch. Max is 10.
  --api-url=https://...       Worker base URL.
  --admin-key=...             Admin key. Defaults to ADMIN_API_KEY from .dev.vars or your shell.
  --rodeo-id=16552            Process one exact rodeo.
  --batch-delay-ms=2000       Delay between batches.
  --max-batches=10            Stop after this many batches.
  --retry-empty               Reprocess rodeos that previously saved 0 result rows.
  --retry-bad-text            Reprocess AP fallback rows with scores/times in contestant IDs.
  --retry-all                 Reprocess already processed rodeos too.
`);
    return;
  }

  const envFile = { ...loadEnvFile(".env"), ...loadEnvFile(".dev.vars") };
  const apiUrl = (argValue("api-url") ?? process.env.RODEO_DATA_API_URL ?? envFile.RODEO_DATA_API_URL ?? DEFAULT_API_URL).replace(/\/$/, "");
  const adminKey = argValue("admin-key") ?? process.env.ADMIN_API_KEY ?? envFile.ADMIN_API_KEY;
  const year = numberOption("year", new Date().getFullYear(), 2000, 2100);
  const limit = numberOption("limit", DEFAULT_LIMIT, 1, 10);
  const rodeoId = argValue("rodeo-id");
  const batchDelayMs = numberOption("batch-delay-ms", DEFAULT_BATCH_DELAY_MS, 0, 60_000);
  const maxBatches = numberOption("max-batches", Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
  const retryEmpty = hasFlag("retry-empty");
  const retryBadText = hasFlag("retry-bad-text");
  const retryAll = hasFlag("retry-all");

  if (!adminKey) {
    throw new Error("ADMIN_API_KEY was not found. Put it in .dev.vars, export it in your terminal, or pass --admin-key=...");
  }

  const headers = { authorization: `Bearer ${adminKey}` };
  const statusUrl = `${apiUrl}/v1/admin/monthly-money-earners/backfill/status?year=${year}`;
  const backfillUrl = `${apiUrl}/v1/admin/monthly-money-earners/backfill?year=${year}&limit=${limit}${
    retryEmpty ? "&retry_empty=true" : ""
  }${retryBadText ? "&retry_bad_text=true" : ""}${retryAll ? "&retry_all=true" : ""}${
    rodeoId ? `&rodeo_id=${encodeURIComponent(rodeoId)}` : ""
  }`;

  log(`Checking ${year} monthly money backfill status`);
  const startingStatus = await requestJson(statusUrl, { headers });
  log(`remaining before start: ${startingStatus.remaining_rodeos_count}`);
  if (retryEmpty) {
    log("retry-empty is on: previously processed rodeos with 0 result rows will be tried again");
  }
  if (retryBadText) {
    log("retry-bad-text is on: AP fallback rows with scores/times in contestant IDs will be repaired");
  }
  if (retryAll) {
    log("retry-all is on: already processed rodeos will be reprocessed and overwritten");
  }
  if (rodeoId) {
    log(`single rodeo mode is on: ${rodeoId}`);
  }

  let remaining = Number(startingStatus.remaining_rodeos_count ?? 0);
  let batch = 0;

  while (remaining > 0 && batch < maxBatches) {
    batch += 1;
    log(`batch ${batch}: processing up to ${limit} rodeos`);

    const result = await requestJson(backfillUrl, {
      method: "POST",
      headers
    });

    remaining = Number(result.remaining_rodeos_count ?? 0);
    const touchedMonths = Array.isArray(result.touched_months) && result.touched_months.length
      ? result.touched_months.join(", ")
      : "none";

    log(
      `batch ${batch}: ${result.processed_rodeos_count} succeeded, ${result.failed_rodeos_count} failed, months touched: ${touchedMonths}`
    );
    log(`remaining after batch ${batch}: ${remaining}`);

    const status = await requestJson(statusUrl, { headers });
    printRecentRodeos(status.recent_rodeos ?? []);

    if (remaining <= 0) break;
    if (Number(result.processed_rodeos_count ?? 0) + Number(result.failed_rodeos_count ?? 0) === 0) {
      log("No rodeos were processed in the last batch, so the runner stopped.");
      break;
    }

    log(`waiting ${batchDelayMs}ms before the next batch`);
    await sleep(batchDelayMs);
  }

  if (remaining === 0) {
    log(`Backfill complete for ${year}.`);
  } else {
    log(`Stopped with ${remaining} rodeos remaining.`);
  }
}

main().catch((error) => {
  console.error(`Backfill failed: ${error.message}`);
  process.exitCode = 1;
});
