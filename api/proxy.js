const ALLOWED = new Set(["moviebox", "dramabox", "netshort", "docs", "openapi"]);

function one(value, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function pathValue(value) {
  if (Array.isArray(value)) return value.join("/");
  return value ?? "";
}

function splitPath(path) {
  return String(path || "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
}

function toSearchParams(query) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k === "provider" || k === "path") continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, String(item));
    } else if (v !== undefined) {
      sp.append(k, String(v));
    }
  }
  return sp;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decodeUrlSafe(value) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeCompat(provider, rawPath, query) {
  const segments = splitPath(rawPath);
  const action = segments[0] || "";
  const params = toSearchParams(query);

  if (provider === "docs" || provider === "openapi") {
    return { path: action, params, transform: null, localJson: null };
  }

  if (provider === "dramabox") {
    if (action === "detail" && segments[1] && !params.get("bookId")) {
      params.set("bookId", segments[1]);
    }
    if (action === "allepisode" && segments[1] && !params.get("bookId")) {
      params.set("bookId", segments[1]);
    }
    if (action === "search") {
      const queryText = params.get("query");
      if (queryText && !params.get("keyword") && !params.get("q")) {
        params.set("keyword", queryText);
      }
    }
    if (action === "allepisode") {
      return { path: "batch-load", params, transform: null, localJson: null };
    }
    if (action === "trending") {
      if (!params.get("rankType")) params.set("rankType", "1");
      return { path: "rank", params, transform: null, localJson: null };
    }
    if (action === "dubindo") {
      const classify = (params.get("classify") || "terbaru").toLowerCase();
      params.delete("classify");
      if (classify === "terpopuler" || classify === "trending" || classify === "popular") {
        if (!params.get("rankType")) params.set("rankType", "1");
        return { path: "rank", params, transform: null, localJson: null };
      }
      if (classify === "vip") {
        return { path: "vip", params, transform: null, localJson: null };
      }
      return { path: "latest", params, transform: null, localJson: null };
    }
    if (action === "randomdrama") {
      return { path: "foryou", params, transform: "dramabox-random", localJson: null };
    }
    return { path: action, params, transform: null, localJson: null };
  }

  if (provider === "netshort") {
    if (action === "detail" && segments[1] && !params.get("shortPlayId")) {
      params.set("shortPlayId", segments[1]);
    }
    if (action === "allepisode" && segments[1] && !params.get("shortPlayId")) {
      params.set("shortPlayId", segments[1]);
    }
    if (action === "search") {
      const queryText = params.get("query");
      if (queryText && !params.get("keyword") && !params.get("q")) {
        params.set("keyword", queryText);
      }
    }
    if (action === "theaters") {
      return { path: "homepage", params, transform: null, localJson: null };
    }
    if (action === "foryou") {
      const page = Math.max(1, toInt(params.get("page"), 1));
      const limit = Math.max(1, toInt(params.get("limit"), 20));
      params.set("offset", String((page - 1) * limit));
      params.set("limit", String(limit));
      return { path: "recommend", params, transform: null, localJson: null };
    }
    if (action === "allepisode") {
      return { path: "detail", params, transform: null, localJson: null };
    }
    return { path: action, params, transform: null, localJson: null };
  }

  if (provider === "moviebox") {
    if (action === "generate-link-stream-video") {
      const input = decodeUrlSafe(one(query.url));
      return {
        path: action,
        params,
        transform: null,
        localJson: {
          success: true,
          url: input,
          link: input,
          playUrl: input,
          downloadUrl: input,
          streamUrl: input,
          data: {
            url: input,
            link: input,
            playUrl: input,
            downloadUrl: input,
            streamUrl: input,
          },
        },
      };
    }

    if (action === "detail" && segments[1] && !params.get("subjectId") && !params.get("detailPath")) {
      params.set("subjectId", segments[1]);
    }
    if (action === "sources" && segments[1] && !params.get("subjectId") && !params.get("detailPath")) {
      params.set("subjectId", segments[1]);
    }

    if (action === "search") {
      const queryText = params.get("query");
      if (queryText && !params.get("keyword") && !params.get("q")) {
        params.set("keyword", queryText);
      }
      return { path: "everyone-search", params, transform: null, localJson: null };
    }

    if (action === "homepage") {
      return { path: "home", params, transform: null, localJson: null };
    }

    if (action === "sources") {
      if (params.get("season") && !params.get("se")) {
        params.set("se", params.get("season"));
      }
      if (params.get("episode") && !params.get("ep")) {
        params.set("ep", params.get("episode"));
      }
      if (params.get("subjectId") && !params.get("detailPath")) {
        params.set("detailPath", params.get("subjectId"));
      }
      return { path: "play", params, transform: null, localJson: null };
    }

    if (action === "detail" && params.get("subjectId") && !params.get("detailPath")) {
      params.set("detailPath", params.get("subjectId"));
    }

    return { path: action, params, transform: null, localJson: null };
  }

  return { path: action, params, transform: null, localJson: null };
}

function setCors(res, req) {
  const origin = req.headers.origin || "https://www.terasdracin.my.id";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

function pickArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    payload.items,
    payload.list,
    payload.data,
    payload.results,
    payload.contentInfos,
    payload.records,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function shuffleTake(items, maxItems = 12) {
  const arr = Array.isArray(items) ? [...items] : [];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, maxItems);
}

async function forwardResponse(upstream, res) {
  const body = Buffer.from(await upstream.arrayBuffer());
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "transfer-encoding" || lower === "content-length") return;
    res.setHeader(key, value);
  });
  return res.send(body);
}

function buildTargetUrl(workerBase, provider, path, params) {
  let target = workerBase.replace(/\/+$/, "");
  if (provider === "docs") {
    target += "/docs";
  } else if (provider === "openapi") {
    target += "/openapi.json";
  } else {
    const cleanPath = String(path || "").replace(/^\/+|\/+$/g, "");
    target += cleanPath ? `/${provider}/${cleanPath}` : `/${provider}`;
  }
  const qs = params.toString();
  if (qs) target += `?${qs}`;
  return target;
}

export default async function handler(req, res) {
  setCors(res, req);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const provider = one(req.query.provider);
  if (!ALLOWED.has(provider)) {
    return res.status(404).json({ error: "Provider not found" });
  }

  const workerBase = process.env.WORKER_BASE_URL;
  const proxySecret = process.env.PROXY_SECRET;
  if (!workerBase || !proxySecret) {
    return res.status(500).json({ error: "Missing WORKER_BASE_URL or PROXY_SECRET" });
  }

  const rawPath = pathValue(req.query.path);
  const normalized = normalizeCompat(provider, rawPath, req.query);

  if (normalized.localJson) {
    return res.status(200).json(normalized.localJson);
  }

  const target = buildTargetUrl(workerBase, provider, normalized.path, normalized.params);

  try {
    const upstream = await fetch(target, {
      method: "GET",
      headers: {
        "x-proxy-secret": proxySecret,
        accept: req.headers.accept || "application/json",
        "user-agent": req.headers["user-agent"] || "vercel-proxy",
      },
    });

    if (normalized.transform === "dramabox-random" && upstream.ok) {
      const payload = await upstream.json().catch(() => null);
      const picked = shuffleTake(pickArray(payload), 12);
      return res.status(200).json({ items: picked });
    }

    return forwardResponse(upstream, res);
  } catch {
    return res.status(502).json({ error: "Bad Gateway" });
  }
}
