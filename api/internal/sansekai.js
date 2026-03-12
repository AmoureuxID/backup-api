const ALLOWED_SANSEKAI_PROVIDERS = new Set([
  "moviebox",
  "dramabox",
  "reelshort",
  "shortmax",
  "netshort",
  "melolo",
  "flickreels",
  "freereels",
]);

const SANSEKAI_API_BASE = "https://api.sansekai.my.id/api";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function one(value, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return String(value[0] || "").trim();
  if (typeof value === "string") return value.trim();
  return "";
}

function randomId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `sbridge-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveRequestId(req) {
  return firstHeaderValue(req?.headers?.["x-request-id"]) || randomId();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePath(value) {
  return String(value || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function buildUpstreamUrl(provider, path, query) {
  const normalizedPath = normalizePath(path);
  const url = new URL(`${SANSEKAI_API_BASE}/${provider}/${normalizedPath}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (key === "provider" || key === "path") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && String(item).trim() !== "") {
          url.searchParams.append(key, String(item));
        }
      }
      continue;
    }

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function getCacheControl(kind, path) {
  if (kind === "watch" || /(episode|stream|play)/i.test(path)) {
    return "public, s-maxage=15, stale-while-revalidate=30";
  }
  if (kind === "search" || /search/i.test(path)) {
    return "public, s-maxage=20, stale-while-revalidate=60";
  }
  if (kind === "detail" || /(detail|allepisode)/i.test(path)) {
    return "public, s-maxage=120, stale-while-revalidate=300";
  }
  return "public, s-maxage=45, stale-while-revalidate=120";
}

function copyResponseHeaders(res, upstream) {
  for (const [key, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "cache-control") continue;
    res.setHeader(key, value);
  }
}

function shouldRetryStatus(status) {
  return status === 408 || status === 425 || (status >= 500 && status <= 599);
}

async function fetchWithRetry(url, init, attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (attempt < attempts && shouldRetryStatus(response.status)) {
        await sleep(400 * attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(400 * attempt);
        continue;
      }
    }
  }

  throw lastError ?? new Error("Sansekai bridge fetch failed");
}

export default async function handler(req, res) {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-sansekai-bridge", "1");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const configuredSecret = process.env.SANSEKAI_BRIDGE_SECRET || process.env.PROXY_SECRET;
  if (!configuredSecret) {
    return res.status(500).json({ error: "Missing SANSEKAI_BRIDGE_SECRET or PROXY_SECRET" });
  }

  const suppliedSecret =
    firstHeaderValue(req.headers["x-bridge-secret"]) || firstHeaderValue(req.headers["x-proxy-secret"]);
  if (suppliedSecret !== configuredSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const provider = one(req.query.provider);
  const path = normalizePath(one(req.query.path));
  const kind = one(req.headers["x-upstream-kind"]) || one(req.query.kind) || "";

  if (!ALLOWED_SANSEKAI_PROVIDERS.has(provider)) {
    return res.status(404).json({ error: "Provider not found" });
  }

  if (!path) {
    return res.status(400).json({ error: "Missing path" });
  }

  const targetUrl = buildUpstreamUrl(provider, path, req.query);
  const cacheControl = getCacheControl(kind, path);

  try {
    const upstream = await fetchWithRetry(targetUrl.toString(), {
      method: req.method,
      headers: {
        accept: "application/json",
        "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "user-agent": firstHeaderValue(req.headers["user-agent"]) || "Mozilla/5.0",
        "x-request-id": requestId,
      },
      redirect: "follow",
    }, 2);

    copyResponseHeaders(res, upstream);
    res.setHeader("Cache-Control", cacheControl);
    res.setHeader("x-bridge-upstream-status", String(upstream.status));
    res.setHeader("x-bridge-provider", provider);
    res.setHeader("x-bridge-path", path);

    if (req.method === "HEAD") {
      return res.status(upstream.status).end();
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    return res.status(502).json({
      error: "Sansekai bridge transport failure",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
