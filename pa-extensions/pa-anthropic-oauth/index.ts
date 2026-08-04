import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  OAuthCredentials,
  OAuthLoginCallbacks,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const AUTH_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI_AUTO = "http://localhost:54545/callback";
const REDIRECT_URI_MANUAL = "https://console.anthropic.com/oauth/code/callback";
const SCOPE = "org:create_api_key user:profile user:inference";
const CALLBACK_PORT = 54545;

const HOME = process.env.HOME || "/home/agent";
const AUTH_DIR = path.join(HOME, ".pi", "agent", "auth2api");
const CONFIG_PATH = path.join(AUTH_DIR, "config.yaml");
const AUTH2API_KEY = process.env.AUTH2API_KEY || "pa-anthropic-oauth-local";

function log(msg: string): void {
  try {
    fs.appendFileSync(
      path.join(AUTH_DIR, "extension.log"),
      `[${new Date().toISOString()}] ${msg}\n`,
    );
  } catch {}
}

interface PKCECodes {
  verifier: string;
  challenge: string;
}

async function generatePKCE(): Promise<PKCECodes> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = Buffer.from(array).toString("base64url");
  const hash = crypto.createHash("sha256").update(verifier).digest();
  const challenge = Buffer.from(hash).toString("base64url");
  return { verifier, challenge };
}

function startCallbackServer(): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = http
      .createServer((req, res) => {
        const url = new URL(req.url!, `http://localhost:${CALLBACK_PORT}`);
        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h2>${error ? "Login failed" : "Login successful!"}</h2>` +
              `<p>${error ? "Error: " + error : "You can close this window."}</p></body></html>`,
          );
          server.close();
          if (error) reject(new Error(`OAuth error: ${error}`));
          else if (code && state) resolve({ code, state });
          else reject(new Error("Missing code or state in callback"));
        } else {
          res.writeHead(404).end();
          server.close();
          reject(new Error("Unexpected callback path"));
        }
      })
      .listen(CALLBACK_PORT, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out (5 min)"));
    }, 5 * 60 * 1000);
  });
}

const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface RawTokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  account?: { email_address: string; uuid: string };
}

async function exchangeCode(
  code: string,
  state: string,
  verifier: string,
  redirectUri: string,
): Promise<RawTokenData> {
  const resp = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Token exchange failed (${resp.status}): ${await resp.text()}`);
  }
  return resp.json() as Promise<RawTokenData>;
}

async function refreshTokens(refreshToken: string): Promise<RawTokenData> {
  const resp = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Token refresh failed (${resp.status}): ${await resp.text()}`);
  }
  return resp.json() as Promise<RawTokenData>;
}

function saveTokenFile(data: RawTokenData): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  const email = data.account?.email_address || "unknown";
  const sanitized = email.replace(/[^a-zA-Z0-9@._-]/g, "_").replace(/\.\./g, "_");
  const filename = `claude-${sanitized}.json`;
  const storage = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    email,
    type: "claude",
    expired: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    account_uuid: data.account?.uuid || "",
    last_refresh: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(AUTH_DIR, filename), JSON.stringify(storage, null, 2), {
    mode: 0o600,
  });
  log(`Saved token for ${email}`);
}

async function loginAnthropic(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE();
  const state = verifier;

  const method = await callbacks.onSelect({
    message: "Login method:",
    options: [
      { id: "manual", label: "Manual (paste authorization code)" },
      { id: "browser", label: "Auto-capture callback (needs port 54545 forwarding)" },
    ],
  });

  const redirectUri = method === "browser" ? REDIRECT_URI_AUTO : REDIRECT_URI_MANUAL;

  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  const scopeEncoded = SCOPE.split(" ")
    .map((s) => encodeURIComponent(s).replace(/%3A/g, ":"))
    .join("+");
  const authUrl = `${AUTH_URL}?${params.toString()}&scope=${scopeEncoded}`;

  let code: string;
  let returnedState: string;

  if (method === "browser") {
    const callbackPromise = startCallbackServer();
    callbacks.onAuth({ url: authUrl });
    const result = await callbackPromise;
    code = result.code;
    returnedState = result.state;
  } else {
    callbacks.onAuth({ url: authUrl });
    const input = await callbacks.onPrompt({
      message: "Paste the authorization code (code#state or full URL):",
    });
    const trimmed = input.trim();
    if (!trimmed) throw new Error("No authorization code provided");

    if (trimmed.includes("#")) {
      const [codePart, statePart] = trimmed.split("#");
      code = codePart!;
      returnedState = statePart ?? state;
    } else if (trimmed.startsWith("http")) {
      const url = new URL(trimmed);
      code = url.searchParams.get("code")!;
      returnedState = url.searchParams.get("state") ?? state;
    } else {
      code = trimmed;
      returnedState = state;
    }
    if (!code) throw new Error("No authorization code found in the input");
  }

  if (returnedState !== state) {
    throw new Error("OAuth state mismatch — possible CSRF attack");
  }

  const data = await exchangeCode(code, state, verifier, redirectUri);
  saveTokenFile(data);
  log("Token saved");

  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

async function refreshAnthropicToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const data = await refreshTokens(credentials.refresh);
  saveTokenFile(data);
  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

function getBaseUrl(): string {
  return process.env.AUTH2API_URL || "http://127.0.0.1:8317";
}

function loadModels(): ProviderModelConfig[] {
  const catalogPath = path.join(
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
    "node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json",
  );
  let raw: string;
  try {
    raw = fs.readFileSync(catalogPath, "utf8");
  } catch {
    log("anthropic.json not found");
    return [];
  }

  const parsed = JSON.parse(raw) as {
    "anthropic-messages": Record<
      string,
      {
        id: string;
        name: string;
        reasoning: boolean;
        input: string[];
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
        contextWindow: number;
        maxTokens: number;
      }
    >;
  };

  const models = Object.values(parsed["anthropic-messages"]).map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));
  log(`Loaded ${models.length} models`);
  return models;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_TTL_MS = 5 * 60 * 1000;
const USAGE_CACHE_PATH = path.join(AUTH_DIR, "usage-cache.json");

interface UsageData {
  five_hour_pct: number | null;
  five_hour_resets_at: string | null;
  seven_day_pct: number | null;
  seven_day_resets_at: string | null;
  fetched_at: number;
}

function readCachedUsage(): UsageData | null {
  try {
    return JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, "utf8")) as UsageData;
  } catch {
    return null;
  }
}

function writeCachedUsage(data: UsageData): void {
  try {
    fs.writeFileSync(USAGE_CACHE_PATH, JSON.stringify(data), { mode: 0o600 });
  } catch {}
}

function getLatestAccessToken(): string | null {
  try {
    const files = fs
      .readdirSync(AUTH_DIR)
      .filter((f) => f.startsWith("claude-") && f.endsWith(".json"))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(AUTH_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    const raw = fs.readFileSync(path.join(AUTH_DIR, files[0]!.name), "utf8");
    return (JSON.parse(raw) as { access_token: string }).access_token;
  } catch {
    return null;
  }
}

async function fetchUsage(token: string): Promise<UsageData | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const resp = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      if (!resp.ok) return null;
      const body = (await resp.json()) as {
        five_hour?: { utilization?: number; resets_at?: string };
        seven_day?: { utilization?: number; resets_at?: string };
      };
      const data: UsageData = {
        five_hour_pct: body.five_hour?.utilization ?? null,
        five_hour_resets_at: body.five_hour?.resets_at ?? null,
        seven_day_pct: body.seven_day?.utilization ?? null,
        seven_day_resets_at: body.seven_day?.resets_at ?? null,
        fetched_at: Date.now(),
      };
      writeCachedUsage(data);
      return data;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function formatRemaining(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const target = new Date(resetsAt).getTime();
  const diff = target - Date.now();
  if (diff < 0) return "due";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return `${h}h${m.toString().padStart(2, "0")}m`;
}

const BAR_CHARS = "█▉▊▋▌▍▎▏░";

function buildBar(filled: number, cells: number): string {
  if (cells < 1) return "";
  const clamped = Math.max(0, Math.min(1, filled));
  const totalEighths = Math.round(clamped * cells * 8);
  let bar = "";
  for (let i = 0; i < cells; i++) {
    const eighths = Math.max(0, Math.min(8, totalEighths - i * 8));
    bar += BAR_CHARS[8 - eighths];
  }
  return bar;
}

function formatUsageStatus(data: UsageData, maxWidth: number, theme: any): string {
  const p5 = data.five_hour_pct;
  const p7 = data.seven_day_pct;
  if (p5 === null && p7 === null) return "";

  const lbl5 = "5h ";
  const pct5 = p5 !== null ? ` ${Math.round(p5)}%${formatRemaining(data.five_hour_resets_at) ? `(${formatRemaining(data.five_hour_resets_at)})` : ""}` : " --";
  const sep = " | ";
  const lbl7 = "7d ";
  const pct7 = p7 !== null ? ` ${Math.round(p7)}%` : " --";

  const staleTag = Date.now() - data.fetched_at > USAGE_TTL_MS ? " [stale]" : "";

  const fixedWidth =
    visibleWidth(lbl5) + visibleWidth(pct5) + visibleWidth(sep) +
    visibleWidth(lbl7) + visibleWidth(pct7) + visibleWidth(staleTag);
  const barTotal = Math.max(0, maxWidth - fixedWidth);
  const bar5 = Math.max(3, Math.floor(barTotal * 0.6));
  const bar7 = Math.max(3, Math.floor(barTotal * 0.4));

  const rem5 = p5 !== null ? (100 - p5) / 100 : 0;
  const rem7 = p7 !== null ? (100 - p7) / 100 : 0;

  const bar5Str = theme.fg("success", buildBar(rem5, bar5));
  const bar7Str = theme.fg("accent", buildBar(rem7, bar7));

  const line =
    `${lbl5}${bar5Str}${theme.fg("dim", pct5)}${theme.fg("dim", sep)}` +
    `${lbl7}${bar7Str}${theme.fg("dim", pct7)}` +
    `${staleTag ? theme.fg("warning", staleTag) : ""}`;
  return truncateToWidth(line, maxWidth);
}

let usageData: UsageData | null = null;
let lastStatus: string | undefined = undefined;

function updateUsageStatus(ctx: any): void {
  if (!usageData) {
    if (lastStatus !== undefined) {
      try { ctx.ui.setStatus("anthropic-oauth-usage", undefined); } catch {}
      lastStatus = undefined;
    }
    return;
  }
  const termWidth = process.stdout.columns || 80;
  const status = formatUsageStatus(usageData, termWidth, ctx.ui.theme);
  if (status === lastStatus) return;
  lastStatus = status;
  try { ctx.ui.setStatus("anthropic-oauth-usage", status || undefined); } catch {}
}

function startUsagePoller(pi: ExtensionAPI, ctx: any): void {
  let active = ctx.model?.provider === "anthropic-oauth";
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  async function poll(): Promise<void> {
    const cached = readCachedUsage();
    if (cached) usageData = cached;

    const cacheAge = cached ? Date.now() - cached.fetched_at : Infinity;
    if (cacheAge > USAGE_TTL_MS) {
      const token = getLatestAccessToken();
      if (token) {
        const fresh = await fetchUsage(token);
        if (fresh) usageData = fresh;
      }
    }

    if (active && usageData) {
      updateUsageStatus(ctx);
    } else {
      try { ctx.ui.setStatus("anthropic-oauth-usage", undefined); } catch {}
    }
  }

  function refresh(): void {
    lastStatus = undefined;
    if (active && usageData) updateUsageStatus(ctx);
  }

  (startUsagePoller as any).setActive = (val: boolean) => {
    active = val;
    if (val) {
      poll();
    } else {
      try { ctx.ui.setStatus("anthropic-oauth-usage", undefined); } catch {}
    }
  };
  (startUsagePoller as any).refresh = refresh;

  poll();
  pollTimer = setInterval(poll, 60_000);
  pollTimer.unref?.();
}

export default function (pi: ExtensionAPI) {
  const models = loadModels();

  pi.registerProvider("anthropic-oauth", {
    name: "Anthropic (OAuth via auth2api)",
    baseUrl: getBaseUrl(),
    apiKey: AUTH2API_KEY,
    api: "anthropic-messages",
    models,
    oauth: {
      name: "Claude (Pro/Max)",
      login: loginAnthropic,
      refreshToken: refreshAnthropicToken,
      getApiKey: () => AUTH2API_KEY,
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    startUsagePoller(pi, ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    const isActive = event.model.provider === "anthropic-oauth";
    (startUsagePoller as any).setActive?.(isActive);
  });

  process.stdout.on("resize", () => {
    (startUsagePoller as any).refresh?.();
  });
}
