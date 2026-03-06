const ALLOWED = new Set(["moviebox", "dramabox", "netshort", "docs", "openapi"]);

function one(value, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function pathValue(value) {
  if (Array.isArray(value)) return value.join("/");
  return value ?? "";
}

function buildQuery(query) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k === "provider" || k === "path") continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, String(item));
    } else if (v !== undefined) {
      sp.append(k, String(v));
    }
  }
  return sp.toString();
}

function setCors(res, req) {
  const origin = req.headers.origin || "https://www.terasdracin.my.id";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
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

  let target = workerBase.replace(/\/+$/, "");
  if (provider === "docs") {
    target += "/docs";
  } else if (provider === "openapi") {
    target += "/openapi.json";
  } else {
    const path = pathValue(req.query.path);
    target += `/${provider}/${path}`;
  }

  const qs = buildQuery(req.query);
  if (qs) target += `?${qs}`;

  try {
    const upstream = await fetch(target, {
      method: "GET",
      headers: {
        "x-proxy-secret": proxySecret,
        "accept": req.headers.accept || "application/json",
        "user-agent": req.headers["user-agent"] || "vercel-proxy"
      }
    });

    const body = Buffer.from(await upstream.arrayBuffer());

    // Forward status
    res.status(upstream.status);

    // Forward safe headers
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === "transfer-encoding") return;
      res.setHeader(key, value);
    });

    return res.send(body);
  } catch {
    return res.status(502).json({ error: "Bad Gateway" });
  }
}
