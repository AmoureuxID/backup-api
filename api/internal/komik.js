const KOMIK_API_BASE = "https://www.sankavollerei.com/comic/bacakomik";

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
  return `komik-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveRequestId(req) {
  return firstHeaderValue(req?.headers?.["x-request-id"]) || randomId();
}

function normalizePath(value) {
  return String(value || "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function shouldRetryStatus(status) {
  return status === 408 || status === 425 || (status >= 500 && status <= 599);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  throw lastError ?? new Error("Komik bridge fetch failed");
}

function buildCacheControl(kind, path) {
  const normalized = String(path || "").toLowerCase();
  if (kind === "watch" || /(chapter|page)/i.test(normalized)) {
    return "public, s-maxage=15, stale-while-revalidate=30";
  }
  if (kind === "search" || /search/i.test(normalized)) {
    return "public, s-maxage=25, stale-while-revalidate=60";
  }
  if (kind === "detail" || /detail/i.test(normalized)) {
    return "public, s-maxage=180, stale-while-revalidate=360";
  }
  return "public, s-maxage=60, stale-while-revalidate=120";
}

function buildUpstreamUrl(path, query) {
  const normalized = normalizePath(path);
  const url = new URL(`${KOMIK_API_BASE}/${normalized}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (key === "path") continue;
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

export default async function handler(req, res) {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-komik-bridge", "1");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const configuredSecret = normalizePath(process.env.KOMIK_BRIDGE_SECRET || "") ||
    normalizePath(process.env.PROXY_SECRET || "");
  if (!configuredSecret) {
    return res.status(500).json({ error: "Missing KOMIK_BRIDGE_SECRET or PROXY_SECRET" });
  }

  const suppliedSecret =
    firstHeaderValue(req.headers["x-bridge-secret"]) ||
    firstHeaderValue(req.headers["x-proxy-secret"]);
  if (suppliedSecret !== configuredSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const path = normalizePath(one(req.query.path));
  if (!path) {
    return res.status(400).json({ error: "Missing path" });
  }

  const kind = one(req.headers["x-upstream-kind"]) || one(req.query.kind) || "";
  const targetUrl = buildUpstreamUrl(path, req.query);
  const cacheControl = buildCacheControl(kind, path);

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
        "x-upstream-kind": kind,
      },
      redirect: "follow",
    }, 2);

    const contentType = upstream.headers.get("content-type");
    if (contentType) {
      res.setHeader("content-type", contentType);
    }
    res.setHeader("Cache-Control", cacheControl);
    res.setHeader("x-bridge-upstream-status", String(upstream.status));
    res.setHeader("x-bridge-path", path);

    if (req.method === "HEAD") {
      return res.status(upstream.status).end();
    }

    const bodyText = await upstream.text();
    return res.status(upstream.status).send(bodyText);
  } catch (error) {
    return res.status(502).json({
      error: "Komik bridge transport failure",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
