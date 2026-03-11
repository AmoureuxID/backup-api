const ALLOWED = new Set(["app", "moviebox", "dramabox", "netshort", "sdrama", "docs", "openapi"]);
const MOVIEBOX_CACHE_KEY = "__movieboxDetailPathCache";
const MOVIEBOX_CACHE_LIMIT = 5000;
const DRAMABOX_BATCH_SIZE = 6;
const DRAMABOX_MAX_CHUNK_REQUESTS = 24;
const SDRAMA_BASE = "https://api-short.stor.co.id";
const SDRAMA_PROVIDERS = new Set([
  "dramanow",
  "fundrama",
  "meloshort",
  "rapidtv",
  "dotdrama",
  "dramanova",
  "sodareels",
  "goodshort",
  "dramapops",
  "hishort",
  "microdrama",
  "starshort",
  "radreels",
  "shorten",
  "shortsky",
  "dramadash",
  "dramarush",
  "dramawave",
  "bilitv",
  "shortbox",
  "shotshort",
  "flextv",
  "vigloo",
  "dramabite",
]);
if (!globalThis[MOVIEBOX_CACHE_KEY]) {
  globalThis[MOVIEBOX_CACHE_KEY] = new Map();
}

function getMovieboxCache() {
  return globalThis[MOVIEBOX_CACHE_KEY];
}

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

function asArray(value) {
  if (Array.isArray(value)) return value;
  return [];
}

function toSearchParams(query, options = {}) {
  const preserveProvider = Boolean(options.preserveProvider);
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k === "path") continue;
    if (k === "provider" && !preserveProvider) continue;

    if (Array.isArray(v)) {
      const values =
        k === "provider" && preserveProvider
          ? v.filter((item) => String(item) !== "app")
          : v;
      for (const item of values) sp.append(k, String(item));
    } else if (v !== undefined) {
      if (k === "provider" && preserveProvider && String(v) === "app") continue;
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

function randomId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `dbx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return String(value[0] || "").trim();
  if (typeof value === "string") return value.trim();
  return "";
}

function resolveRequestId(req) {
  return firstHeaderValue(req?.headers?.["x-request-id"]) || randomId();
}

function dedupeBy(items, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of asArray(items)) {
    if (!item || typeof item !== "object") continue;
    const key = keyFn(item);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(item);
  }
  return out;
}

function shuffleTake(items, maxItems = 12) {
  const arr = [...asArray(items)];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, maxItems);
}

function extractDramaboxList(payload) {
  const data = payload?.data ?? payload ?? {};
  const list = [];
  const classifyBookList =
    data?.classifyBookList && typeof data.classifyBookList === "object"
      ? data.classifyBookList
      : {};

  if (Array.isArray(data)) list.push(...data);
  if (Array.isArray(data.rankList)) list.push(...data.rankList);
  if (Array.isArray(data.searchList)) list.push(...data.searchList);
  if (Array.isArray(data.records)) list.push(...data.records);
  if (Array.isArray(classifyBookList.records)) list.push(...classifyBookList.records);
  if (Array.isArray(classifyBookList.list)) list.push(...classifyBookList.list);

  for (const column of asArray(data.columnVoList)) {
    list.push(...asArray(column?.bookList));
  }

  list.push(...asArray(data.newTheaterList?.records));

  for (const item of asArray(data.recommendList?.records)) {
    if (item?.bookId) list.push(item);
    list.push(...asArray(item?.tagCardVo?.tagBooks));
  }

  return dedupeBy(list, (item) => String(item?.bookId || item?.id || ""));
}

function sortDramaboxChapters(chapters) {
  return [...asArray(chapters)].sort((left, right) => {
    const leftIndex = toInt(left?.chapterIndex, 0);
    const rightIndex = toInt(right?.chapterIndex, 0);
    return leftIndex - rightIndex;
  });
}

function dedupeDramaboxChapters(chapters) {
  return dedupeBy(chapters, (chapter) =>
    String(chapter?.chapterId || chapter?.chapterIndex || chapter?.chapterName || "")
  );
}

function normalizeDramaboxEpisode(episode) {
  const chapterIndex = toInt(episode?.chapterIndex, 0);
  const isCharge = toInt(episode?.isCharge, 0);
  const isPay = toInt(episode?.isPay, isCharge ? 0 : 1);
  const chargeChapter =
    typeof episode?.chargeChapter === "boolean" ? episode.chargeChapter : Boolean(isCharge);

  return {
    ...episode,
    chapterId: String(episode?.chapterId || ""),
    chapterIndex,
    isCharge,
    isPay,
    chapterName: episode?.chapterName || `EP ${chapterIndex + 1}`,
    chapterImg: episode?.chapterImg || "",
    cdnList: asArray(episode?.cdnList),
    chargeChapter,
  };
}

function extractDramaboxEpisodes(payload) {
  const data = payload?.data ?? payload ?? {};
  const rawEpisodes = asArray(data.chapterList?.length ? data.chapterList : data.list);
  return sortDramaboxChapters(
    dedupeDramaboxChapters(rawEpisodes.map((episode) => normalizeDramaboxEpisode(episode)))
  );
}

function transformDramabox(transform, payload, params) {
  const data = payload?.data ?? payload ?? {};
  const bookData = data?.book && typeof data.book === "object" ? data.book : data;

  if (transform === "dramabox-list") {
    return extractDramaboxList(payload);
  }

  if (transform === "dramabox-search") {
    return dedupeBy(asArray(data.searchList), (item) => String(item?.bookId || ""));
  }

  if (transform === "dramabox-vip") {
    if (Array.isArray(data.columnVoList)) {
      return {
        columnVoList: data.columnVoList,
      };
    }
    return {
      columnVoList: [
        {
          title: "VIP",
          bookList: extractDramaboxList(payload),
        },
      ],
    };
  }

  if (transform === "dramabox-random") {
    return { items: shuffleTake(extractDramaboxList(payload), 12) };
  }

  if (transform === "dramabox-detail") {
    const chapterList = extractDramaboxEpisodes(payload);
    const chapterCount = Number(bookData.chapterCount || data.chapterCount || chapterList.length || 0);
    const availableChapterCount = chapterList.length;
    return {
      bookId: String(bookData.bookId || data.bookId || params.get("bookId") || ""),
      bookName: bookData.bookName || data.bookName || "",
      coverWap: bookData.bookCover || bookData.coverWap || bookData.cover || data.bookCover || data.coverWap || data.cover || "",
      cover: bookData.bookCover || bookData.cover || bookData.coverWap || data.bookCover || data.cover || data.coverWap || "",
      chapterCount,
      availableChapterCount,
      chapterLoadIncomplete: chapterCount > availableChapterCount,
      introduction: bookData.introduction || data.introduction || "",
      tags: asArray(bookData.tags?.length ? bookData.tags : data.tags),
      tagV3s: asArray(bookData.tagV3s?.length ? bookData.tagV3s : data.tagV3s),
      shelfTime: bookData.shelfTime || data.shelfTime || "",
      inLibrary: Boolean(bookData.inLibrary ?? data.inLibrary),
      playChapterIndex: Number(data.playChapterIndex || 0),
      payChapterNum: Number(data.payChapterNum || 0),
      chapterList,
      episodes: chapterList,
    };
  }

  if (transform === "dramabox-episodes") {
    return extractDramaboxEpisodes(payload);
  }

  return payload;
}

function unwrapNetshort(payload) {
  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") {
    return payload.data;
  }
  return payload ?? {};
}

function transformNetshort(transform, payload) {
  const data = unwrapNetshort(payload);

  if (transform === "netshort-foryou") {
    return {
      maxOffset: data.maxOffset,
      completed: data.completed,
      contentInfos: asArray(data.contentInfos?.length ? data.contentInfos : data.dataList),
    };
  }

  if (transform === "netshort-theaters") {
    const contentInfos = asArray(data.contentInfos?.length ? data.contentInfos : data.dataList);
    if (!contentInfos.length) return [];
    return [
      {
        groupId: "netshort-for-you",
        contentName: "For You",
        contentRemark: "Recommended",
        contentInfos,
      },
    ];
  }

  if (transform === "netshort-detail") {
    const episodeInfos = asArray(data.shortPlayEpisodeInfos);
    const normalizedEpisodes = episodeInfos.map((episode) => ({
      episodeId: episode?.episodeId || "",
      episodeNo: Number(episode?.episodeNo || 0),
      cover: episode?.episodeCover || data.shortPlayCover || "",
      videoUrl: episode?.playVoucher || "",
      quality: episode?.playClarity || "",
      isLock: Boolean(episode?.isLock),
      likeNums: episode?.likeNums || "",
      subtitleUrl: asArray(episode?.subtitleList)[0]?.url || "",
    }));

    return {
      ...data,
      title: data.shortPlayName || data.title || "",
      cover: data.shortPlayCover || data.cover || "",
      description: data.shotIntroduce || data.description || "",
      labels: asArray(data.shortPlayLabels?.length ? data.shortPlayLabels : data.labelArray),
      totalEpisodes: Number(data.totalEpisode || episodeInfos.length || 0),
      availableEpisodeCount: normalizedEpisodes.length,
      episodes: normalizedEpisodes,
      shortPlayEpisodeInfos: episodeInfos,
      success: payload?.success ?? true,
      status: payload?.status,
      message: payload?.message,
    };
  }

  if (transform === "netshort-search") {
    return {
      searchCodeSearchResult: asArray(data.searchCodeSearchResult),
    };
  }

  return payload;
}

function rememberMovieboxSubject(subject) {
  if (!subject || typeof subject !== "object") return;
  const subjectId = subject.subjectId ?? subject.id ?? subject.movieId ?? subject.tvId;
  const detailPath = subject.detailPath ?? subject.path;
  if (!subjectId || !detailPath || typeof detailPath !== "string") return;
  const cache = getMovieboxCache();
  if (cache.size >= MOVIEBOX_CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(String(subjectId), detailPath);
}

function rememberMovieboxFromPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  const stack = [payload];
  const visited = new Set();
  let steps = 0;
  const maxSteps = 20000;

  while (stack.length && steps < maxSteps) {
    const node = stack.pop();
    steps += 1;
    if (!node || typeof node !== "object") continue;
    if (visited.has(node)) continue;
    visited.add(node);

    rememberMovieboxSubject(node);
    if (node.subject && typeof node.subject === "object") {
      rememberMovieboxSubject(node.subject);
    }

    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
}

function transformMoviebox(transform, payload) {
  rememberMovieboxFromPayload(payload);

  if (transform === "moviebox-search") {
    const data = payload?.data ?? {};
    const searchList = asArray(
      data.items ||
      data.subjectList ||
      data.everyoneSearch ||
      payload?.items ||
      payload?.subjectList
    ).filter((item) => {
      const subjectType = Number(item?.subjectType ?? item?.subject?.subjectType ?? 0);
      return !subjectType || subjectType === 1 || subjectType === 2;
    });
    return {
      data,
      subjectList: searchList,
      items: searchList,
      list: searchList,
      results: searchList,
      pager: data?.pager || payload?.pager || null,
      counts: asArray(data?.counts),
    };
  }

  if (transform === "moviebox-sources") {
    const data = payload?.data ?? {};
    const streams = asArray(data.streams);
    const firstUrl = streams.find((item) => item?.url)?.url || "";
    const normalizedData = {
      list: streams,
      items: streams,
      sources: streams,
      streams,
      hls: asArray(data.hls),
      dash: asArray(data.dash),
      hasResource: Boolean(data.hasResource ?? streams.length > 0),
      freeNum: data.freeNum,
      limited: Boolean(data.limited),
      limitedCode: data.limitedCode || "",
      url: firstUrl,
      link: firstUrl,
      playUrl: firstUrl,
      downloadUrl: firstUrl,
    };
    return {
      data: normalizedData,
      list: streams,
      items: streams,
      sources: streams,
      streams,
      hls: normalizedData.hls,
      dash: normalizedData.dash,
      hasResource: normalizedData.hasResource,
      freeNum: normalizedData.freeNum,
      limited: normalizedData.limited,
      limitedCode: normalizedData.limitedCode,
      url: firstUrl,
      link: firstUrl,
      playUrl: firstUrl,
      downloadUrl: firstUrl,
    };
  }

  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function titleCase(value) {
  return String(value || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function sortSDramaEpisodes(episodes) {
  return [...asArray(episodes)].sort((left, right) => {
    const leftIndex = toInt(left?.episode_index, 0);
    const rightIndex = toInt(right?.episode_index, 0);
    return leftIndex - rightIndex;
  });
}

function normalizeSDramaItem(item) {
  const raw = item?.raw_data && typeof item.raw_data === "object" ? item.raw_data : {};
  return {
    ...item,
    id: Number(item?.id || 0),
    external_id: String(item?.external_id || raw?.book_id || ""),
    title: item?.title || raw?.title || "",
    cover_url: item?.cover_url || raw?.cover || "",
    introduction: item?.introduction || "",
    chapter_count: Number(item?.chapter_count || 0),
    provider_slug: item?.provider_slug || "",
    provider_name: item?.provider_name || titleCase(item?.provider_slug || ""),
    play_count: Number(item?.play_count || 0),
    is_dubbed: Boolean(item?.is_dubbed),
    raw_data: raw,
  };
}

function normalizeSDramaEpisode(episode) {
  const qualities =
    episode?.qualities && typeof episode.qualities === "object" && !Array.isArray(episode.qualities)
      ? episode.qualities
      : null;
  const qualityEntries = qualities
    ? Object.entries(qualities).filter(([, value]) => typeof value === "string" && value.length > 0)
    : [];
  const defaultUrl =
    (typeof episode?.video_url === "string" && episode.video_url) ||
    qualityEntries[0]?.[1] ||
    "";
  const subtitles = asArray(episode?.subtitles).filter(
    (item) => item && typeof item.url === "string" && typeof item.lang === "string"
  );

  return {
    ...episode,
    id: String(episode?.id || episode?.external_id || episode?.episode_index || ""),
    episode_index: Number(episode?.episode_index || 0),
    episode_name: episode?.episode_name || `Episode ${Number(episode?.episode_index || 0)}`,
    video_url: defaultUrl,
    subtitle_url:
      (typeof episode?.subtitle_url === "string" && episode.subtitle_url) ||
      subtitles[0]?.url ||
      "",
    subtitles,
    qualities,
    status: episode?.status || "",
    released_at: episode?.released_at || null,
    created_at: episode?.created_at || null,
    is_playable: Boolean(defaultUrl),
  };
}

function transformSDrama(transform, payload, normalized) {
  const providerSlug = normalized?.providerSlug || "";
  const providerName = titleCase(providerSlug);

  if (["sdrama-list", "sdrama-popular", "sdrama-search"].includes(transform)) {
    const items = asArray(payload?.data).map((item) => normalizeSDramaItem(item));
    return {
      success: true,
      items,
      data: items,
      meta: payload?.meta || {
        page: 1,
        per_page: items.length,
        total: items.length,
        total_pages: 1,
      },
      provider: {
        slug: providerSlug,
        name: items[0]?.provider_name || providerName,
      },
    };
  }

  if (transform === "sdrama-detail") {
    const root = payload?.data || {};
    const drama = normalizeSDramaItem(root?.drama || {});
    const episodes = sortSDramaEpisodes(asArray(root?.episodes).map((episode) => normalizeSDramaEpisode(episode)));
    const playableEpisodes = episodes.filter((episode) => episode?.is_playable);
    return {
      success: true,
      drama,
      tags: asArray(root?.tags),
      episodes,
      playableEpisodes,
      totalEpisodes: episodes.length || drama.chapter_count || 0,
      publishedEpisodeCount: playableEpisodes.length,
      firstPlayableEpisode: playableEpisodes[0] || null,
    };
  }

  if (transform === "sdrama-episodes") {
    const episodes = sortSDramaEpisodes(asArray(payload?.data).map((episode) => normalizeSDramaEpisode(episode)));
    return {
      success: true,
      episodes,
      data: episodes,
      playableEpisodes: episodes.filter((episode) => episode?.is_playable),
      meta: payload?.meta || {
        page: 1,
        per_page: episodes.length,
        total: episodes.length,
        total_pages: 1,
      },
      provider: {
        slug: providerSlug,
        name: providerName,
      },
    };
  }

  return payload;
}

function buildSDramaUrl(normalized) {
  const url = new URL(SDRAMA_BASE);

  if (normalized.action === "list") {
    url.pathname = "/api/dramas";
  } else if (normalized.action === "popular") {
    url.pathname = "/api/dramas/popular";
  } else if (normalized.action === "search") {
    url.pathname = "/api/search";
  } else if (normalized.action === "detail") {
    url.pathname = `/api/dramas/${encodeURIComponent(normalized.params.get("id") || "")}`;
  } else if (normalized.action === "episodes") {
    url.pathname = `/api/dramas/${encodeURIComponent(normalized.params.get("id") || "")}/episodes`;
  } else {
    url.pathname = "/api/dramas";
  }

  normalized.params.forEach((value, key) => {
    if (key === "id") return;
    url.searchParams.set(key, value);
  });

  return url;
}

async function fetchSDramaPayload(normalized) {
  const upstreamUrl = buildSDramaUrl(normalized);
  let lastResponse = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(upstreamUrl.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "terasdracin-vercel-proxy",
      },
      redirect: "follow",
    });

    if (response.status !== 429) {
      const payload = response.ok ? await response.clone().json().catch(() => null) : null;
      return { upstream: response, payload };
    }

    lastResponse = response;
    const retryAfter = Number.parseInt(response.headers.get("retry-after") || "", 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.pow(2, attempt) * 1000;
    await sleep(waitMs);
  }

  return { upstream: lastResponse, payload: null };
}

function setCors(res, req) {
  const origin = req.headers.origin || "https://www.terasdracin.my.id";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Range, If-Range, X-Request-Id");
  res.setHeader("Access-Control-Expose-Headers", "x-request-id");
}

function buildWorkerRequestHeaders(proxySecret, reqHeaders, requestId) {
  return {
    "x-proxy-secret": proxySecret,
    "x-request-id": requestId,
    accept: reqHeaders.accept || "application/json",
    "user-agent": reqHeaders["user-agent"] || "vercel-proxy",
    ...(reqHeaders.range ? { range: reqHeaders.range } : {}),
    ...(reqHeaders["if-range"] ? { "if-range": reqHeaders["if-range"] } : {}),
    ...(reqHeaders["accept-language"] ? { "accept-language": reqHeaders["accept-language"] } : {}),
    ...(reqHeaders["accept-encoding"] ? { "accept-encoding": reqHeaders["accept-encoding"] } : {}),
    ...(reqHeaders["cache-control"] ? { "cache-control": reqHeaders["cache-control"] } : {}),
  };
}

async function forwardResponse(upstream, res, method = "GET") {
  const body = method === "HEAD" ? null : Buffer.from(await upstream.arrayBuffer());
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "transfer-encoding" ||
      lower === "content-encoding"
    ) {
      return;
    }
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

function normalizeCompat(provider, rawPath, query) {
  const segments = splitPath(rawPath);
  const action = segments[0] || "";
  const params = toSearchParams(query, { preserveProvider: provider === "app" });

  if (provider === "docs" || provider === "openapi") {
    return { provider, action, path: action, params, transform: null, localJson: null, needDetailPath: false };
  }

  if (provider === "app") {
    return { provider, action, path: rawPath, params, transform: null, localJson: null, needDetailPath: false };
  }

  if (provider === "dramabox") {
    if (["detail", "allepisode"].includes(action) && segments[1] && !params.get("bookId")) {
      params.set("bookId", segments[1]);
    }
    if (action === "search") {
      const queryText = params.get("query");
      if (queryText && !params.get("keyword") && !params.get("q")) {
        params.set("keyword", queryText);
      }
    }

    if (action === "trending") {
      return { provider, action, path: "rank", params, transform: "dramabox-list", localJson: null, needDetailPath: false };
    }
    if (action === "rekomendasi") {
      if (!params.get("pageNo")) {
        params.set("pageNo", params.get("page") || "1");
      }
      return { provider, action, path: "recommend", params, transform: "dramabox-list", localJson: null, needDetailPath: false };
    }
    if (action === "dubindo") {
      if (!params.get("classify")) params.set("classify", "terbaru");
      if (!params.get("audio")) params.set("audio", "1");
      if (!params.get("pageSize")) params.set("pageSize", "15");
      return { provider, action, path: "classify", params, transform: "dramabox-list", localJson: null, needDetailPath: false };
    }
    if (action === "randomdrama") {
      return { provider, action, path: "foryou", params, transform: "dramabox-random", localJson: null, needDetailPath: false };
    }
    if (action === "detail") {
      return { provider, action, path: "detail", params, transform: "dramabox-detail", localJson: null, needDetailPath: false };
    }
    if (action === "allepisode") {
      return { provider, action, path: "detail", params, transform: "dramabox-episodes", localJson: null, needDetailPath: false };
    }
    if (action === "search") {
      return { provider, action, path: "search", params, transform: "dramabox-search", localJson: null, needDetailPath: false };
    }
    if (["foryou", "latest", "vip"].includes(action)) {
      return {
        provider,
        action,
        path: action,
        params,
        transform: action === "vip" ? "dramabox-vip" : "dramabox-list",
        localJson: null,
        needDetailPath: false,
      };
    }
    return { provider, action, path: action, params, transform: null, localJson: null, needDetailPath: false };
  }

  if (provider === "netshort") {
    if (["detail", "allepisode"].includes(action) && segments[1] && !params.get("shortPlayId")) {
      params.set("shortPlayId", segments[1]);
    }
    if (action === "search") {
      const queryText = params.get("query");
      if (queryText && !params.get("keyword") && !params.get("q")) {
        params.set("keyword", queryText);
      }
    }

    if (action === "foryou") {
      const page = Math.max(1, toInt(params.get("page"), 1));
      const limit = Math.max(1, toInt(params.get("limit"), 20));
      params.set("offset", String((page - 1) * limit));
      params.set("limit", String(limit));
      return { provider, action, path: "recommend", params, transform: "netshort-foryou", localJson: null, needDetailPath: false };
    }
    if (action === "theaters") {
      if (!params.get("offset")) params.set("offset", "0");
      if (!params.get("limit")) params.set("limit", "60");
      return { provider, action, path: "recommend", params, transform: "netshort-theaters", localJson: null, needDetailPath: false };
    }
    if (action === "search") {
      return { provider, action, path: "search", params, transform: "netshort-search", localJson: null, needDetailPath: false };
    }
    if (action === "detail" || action === "allepisode") {
      return { provider, action, path: "detail", params, transform: "netshort-detail", localJson: null, needDetailPath: false };
    }
    return { provider, action, path: action, params, transform: null, localJson: null, needDetailPath: false };
  }

  if (provider === "sdrama") {
    const sdramaPath = String(rawPath || params.get("target") || params.get("path") || "");
    const sdramaSegments = splitPath(sdramaPath);
    const providerSlug = sdramaSegments[0] || params.get("providerSlug") || "";
    const compatAction = sdramaSegments[1] || "list";

    if (!SDRAMA_PROVIDERS.has(providerSlug)) {
      return {
        provider,
        action: compatAction,
        path: compatAction,
        params,
        transform: null,
        localJson: null,
        needDetailPath: false,
        invalidStatus: 404,
        invalidMessage: "SDrama provider not found",
      };
    }

    params.delete("target");
    params.delete("path");
    params.delete("providerSlug");
    params.set("provider", providerSlug);
    if (!params.get("page")) params.set("page", "1");
    if (!params.get("per_page")) {
      params.set("per_page", compatAction === "search" ? "12" : "24");
    }

    if (compatAction === "search") {
      const queryText = params.get("query");
      if (queryText && !params.get("q")) {
        params.set("q", queryText);
      }
    }

    return {
      provider,
      action: compatAction,
      path: compatAction,
      params,
      transform:
        compatAction === "popular"
          ? "sdrama-popular"
          : compatAction === "search"
            ? "sdrama-search"
            : compatAction === "detail"
              ? "sdrama-detail"
              : compatAction === "episodes"
                ? "sdrama-episodes"
                : "sdrama-list",
      localJson: null,
      needDetailPath: false,
      providerSlug,
    };
  }

  if (provider === "moviebox") {
    if (action === "generate-link-stream-video") {
      const input = decodeUrlSafe(one(query.url));
      return {
        provider,
        action,
        path: action,
        params,
        transform: null,
        needDetailPath: false,
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

    if (action === "stream") {
      return { provider, action, path: "stream", params, transform: null, localJson: null, needDetailPath: false };
    }

    if (["detail", "sources"].includes(action) && segments[1] && !params.get("subjectId")) {
      params.set("subjectId", segments[1]);
    }

    if (action === "homepage") {
      return { provider, action, path: "home", params, transform: "moviebox-identity", localJson: null, needDetailPath: false };
    }
    if (action === "trending") {
      return { provider, action, path: "trending", params, transform: "moviebox-identity", localJson: null, needDetailPath: false };
    }
    if (action === "search") {
      const queryText = params.get("query");
      if (queryText && !params.get("keyword") && !params.get("q")) {
        params.set("keyword", queryText);
      }
      if (!params.get("page")) params.set("page", "1");
      if (!params.get("perPage")) params.set("perPage", "20");
      return { provider, action, path: "search", params, transform: "moviebox-search", localJson: null, needDetailPath: false };
    }
    if (action === "search-suggest") {
      const queryText = params.get("query");
      if (queryText && !params.get("keyword") && !params.get("q")) {
        params.set("keyword", queryText);
      }
      return { provider, action, path: "search-suggest", params, transform: "moviebox-identity", localJson: null, needDetailPath: false };
    }
    if (action === "sources") {
      if (params.get("season") && !params.get("se")) {
        params.set("se", params.get("season"));
      }
      if (params.get("episode") && !params.get("ep")) {
        params.set("ep", params.get("episode"));
      }
      return { provider, action, path: "play", params, transform: "moviebox-sources", localJson: null, needDetailPath: false };
    }
    if (action === "detail") {
      return { provider, action, path: "detail", params, transform: "moviebox-identity", localJson: null, needDetailPath: false };
    }
    return { provider, action, path: action, params, transform: null, localJson: null, needDetailPath: false };
  }

  return { provider, action, path: action, params, transform: null, localJson: null, needDetailPath: false };
}

async function fetchWorkerJson(workerBase, provider, path, params, proxySecret, reqHeaders, requestId) {
  const url = buildTargetUrl(workerBase, provider, path, params);
  const response = await fetch(url, {
    method: "GET",
    headers: buildWorkerRequestHeaders(proxySecret, reqHeaders, requestId),
  });
  if (!response.ok) return null;
  return await response.json().catch(() => null);
}

function enrichDramaboxBatchParams(params, detailPayload) {
  const nextParams = new URLSearchParams(params);
  const detailData = detailPayload?.data ?? {};
  const firstPlaySourceVo =
    detailData?.firstPlaySourceVo && typeof detailData.firstPlaySourceVo === "object"
      ? detailData.firstPlaySourceVo
      : {};

  if (!nextParams.get("currencyPlaySource")) {
    nextParams.set("currencyPlaySource", firstPlaySourceVo.firstPlaySource || "discover_175_rec");
  }
  if (!nextParams.get("currencyPlaySourceName")) {
    nextParams.set(
      "currencyPlaySourceName",
      firstPlaySourceVo.firstPlaySourceName || "首页发现_Untukmu_推荐列表"
    );
  }
  if (!nextParams.get("startUpKey")) {
    nextParams.set("startUpKey", randomId());
  }
  if (!nextParams.get("rid")) {
    nextParams.set("rid", "");
  }
  if (!nextParams.get("pullCid")) {
    nextParams.set("pullCid", "");
  }
  if (!nextParams.get("needEndRecommend")) {
    nextParams.set("needEndRecommend", "0");
  }
  if (!nextParams.get("enterReaderChapterIndex")) {
    nextParams.set("enterReaderChapterIndex", "0");
  }
  return nextParams;
}

async function fetchAggregatedDramaboxPayload(workerBase, params, proxySecret, reqHeaders, requestId) {
  const baseParams = new URLSearchParams(params);
  const initialParams = new URLSearchParams(baseParams);
  initialParams.set("index", "1");
  initialParams.set("boundaryIndex", "0");
  initialParams.set("loadDirection", "2");

  const firstPayload = await fetchWorkerJson(
    workerBase,
    "dramabox",
    "batch-load",
    initialParams,
    proxySecret,
    reqHeaders,
    requestId
  );

  if (!firstPayload?.data || typeof firstPayload.data !== "object") {
    return null;
  }

  const mergedPayload =
    typeof structuredClone === "function"
      ? structuredClone(firstPayload)
      : JSON.parse(JSON.stringify(firstPayload));
  const mergedData = mergedPayload.data ?? {};
  const chapterCount = Math.max(0, toInt(mergedData.chapterCount, 0));

  let chapters = sortDramaboxChapters(dedupeDramaboxChapters(mergedData.chapterList));
  let nextIndex = chapters.length + 1;
  let requests = 1;

  while (
    chapterCount > 0 &&
    chapters.length < chapterCount &&
    requests < DRAMABOX_MAX_CHUNK_REQUESTS
  ) {
    const chunkParams = new URLSearchParams(baseParams);
    chunkParams.set("index", String(nextIndex));
    chunkParams.set("boundaryIndex", String(Math.max(nextIndex - 1, 0)));
    chunkParams.set("loadDirection", "2");

    const chunkPayload = await fetchWorkerJson(
      workerBase,
      "dramabox",
      "batch-load",
      chunkParams,
      proxySecret,
      reqHeaders,
      requestId
    );

    requests += 1;

    if (!chunkPayload?.success || !chunkPayload?.data || typeof chunkPayload.data !== "object") {
      break;
    }

    const nextChapters = sortDramaboxChapters(chunkPayload.data.chapterList);
    if (!nextChapters.length) {
      break;
    }

    const mergedChapters = sortDramaboxChapters(
      dedupeDramaboxChapters([...chapters, ...nextChapters])
    );

    if (mergedChapters.length === chapters.length) {
      break;
    }

    chapters = mergedChapters;
    nextIndex += Math.max(nextChapters.length, DRAMABOX_BATCH_SIZE);
  }

  mergedData.chapterList = chapters;
  mergedData.availableChapterCount = chapters.length;
  mergedData.chapterLoadIncomplete = chapterCount > 0 && chapters.length < chapterCount;
  mergedPayload.data = mergedData;
  return mergedPayload;
}

async function buildDramaboxEpisodesPayload(workerBase, params, proxySecret, reqHeaders, requestId) {
  const detailPayload = await fetchWorkerJson(
    workerBase,
    "dramabox",
    "detail",
    params,
    proxySecret,
    reqHeaders,
    requestId
  );

  if (!detailPayload?.data || typeof detailPayload.data !== "object") {
    return null;
  }

  const detailEpisodes = extractDramaboxEpisodes(detailPayload);
  const playbackParams = enrichDramaboxBatchParams(params, detailPayload);
  const playablePayload = await fetchAggregatedDramaboxPayload(
    workerBase,
    playbackParams,
    proxySecret,
    reqHeaders,
    requestId
  );
  const playableEpisodes = playablePayload ? extractDramaboxEpisodes(playablePayload) : [];

  const playableMap = new Map(
    playableEpisodes.map((episode) => [
      String(episode.chapterId || episode.chapterIndex || ""),
      episode,
    ])
  );

  const mergedEpisodes = detailEpisodes.map((episode) => {
    const key = String(episode.chapterId || episode.chapterIndex || "");
    const playableEpisode = playableMap.get(key);
    return playableEpisode ? { ...episode, ...playableEpisode } : episode;
  });

  const mergedPayload =
    typeof structuredClone === "function"
      ? structuredClone(detailPayload)
      : JSON.parse(JSON.stringify(detailPayload));

  mergedPayload.data = {
    ...(mergedPayload.data || {}),
    chapterList: mergedEpisodes,
    availableChapterCount: playableEpisodes.length || mergedEpisodes.length,
    chapterLoadIncomplete:
      playablePayload?.data?.chapterLoadIncomplete ||
      (toInt(mergedPayload.data?.chapterCount, mergedEpisodes.length) > playableEpisodes.length &&
        playableEpisodes.length > 0),
  };

  return mergedPayload;
}

async function resolveMovieboxDetailPath(subjectId, workerBase, proxySecret, reqHeaders, requestId) {
  if (!subjectId) return null;
  const cache = getMovieboxCache();
  const cacheKey = String(subjectId);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const probes = [
    { path: "trending", params: new URLSearchParams({ page: "0" }) },
    { path: "home", params: new URLSearchParams() },
  ];

  for (const probe of probes) {
    try {
      const payload = await fetchWorkerJson(
        workerBase,
        "moviebox",
        probe.path,
        probe.params,
        proxySecret,
        reqHeaders,
        requestId
      );
      if (!payload) continue;
      rememberMovieboxFromPayload(payload);
      if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
      }
    } catch {
      // Keep probing until exhausted.
    }
  }

  return null;
}

function applyTransform(normalized, payload) {
  if (normalized.provider === "dramabox") {
    return transformDramabox(normalized.transform, payload, normalized.params);
  }
  if (normalized.provider === "netshort") {
    return transformNetshort(normalized.transform, payload);
  }
  if (normalized.provider === "moviebox") {
    return transformMoviebox(normalized.transform, payload);
  }
  if (normalized.provider === "sdrama") {
    return transformSDrama(normalized.transform, payload, normalized);
  }
  return payload;
}

async function fetchNormalizedPayload(workerBase, proxySecret, reqHeaders, normalized, requestId, method = "GET") {
  const target = buildTargetUrl(workerBase, normalized.provider, normalized.path, normalized.params);
  const upstream = await fetch(target, {
    method,
    headers: buildWorkerRequestHeaders(proxySecret, reqHeaders, requestId),
  });

  if (!normalized.transform || !upstream.ok) {
    return { upstream, payload: null, transformed: null };
  }

  const payload = await upstream.clone().json().catch(() => null);
  if (!payload) {
    return { upstream, payload: null, transformed: null };
  }

  return {
    upstream,
    payload,
    transformed: applyTransform(normalized, payload),
  };
}

async function fetchMergedDramaboxTrending(workerBase, proxySecret, reqHeaders, normalized, requestId) {
  const rankTypes = ["1", "2", "3"];
  const results = await Promise.all(
    rankTypes.map(async (rankType) => {
      const params = new URLSearchParams(normalized.params);
      params.set("rankType", rankType);
      return fetchNormalizedPayload(workerBase, proxySecret, reqHeaders, {
        ...normalized,
        params,
      }, requestId, "GET");
    })
  );

  const failed = results.find(({ upstream }) => !upstream.ok);
  if (failed) {
    return failed;
  }

  const merged = results.flatMap(({ transformed }) =>
    Array.isArray(transformed) ? transformed : []
  );

  const seen = new Set();
  const transformed = merged.filter((item) => {
    const id = String(item?.bookId || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return {
    upstream: results[0]?.upstream,
    payload: null,
    transformed,
  };
}

export default async function handler(req, res) {
  setCors(res, req);
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const provider = one(req.query.proxyProvider) || one(req.query.provider);
  if (!ALLOWED.has(provider)) {
    return res.status(404).json({ error: "Provider not found" });
  }

  const rawPath = pathValue(req.query.path || req.query.target);
  const normalized = normalizeCompat(provider, rawPath, req.query);

  if (normalized.invalidStatus) {
    return res.status(normalized.invalidStatus).json({ error: normalized.invalidMessage || "Invalid request" });
  }

  if (normalized.localJson) {
    return res.status(normalized.localStatus || 200).json(normalized.localJson);
  }

  const workerBase = process.env.WORKER_BASE_URL;
  const proxySecret = process.env.PROXY_SECRET;
  if (provider !== "sdrama" && (!workerBase || !proxySecret)) {
    return res.status(500).json({ error: "Missing WORKER_BASE_URL or PROXY_SECRET" });
  }

  if (
    normalized.provider === "moviebox" &&
    normalized.needDetailPath &&
    !normalized.params.get("detailPath")
  ) {
    const subjectId = normalized.params.get("subjectId");
    const resolvedDetailPath = await resolveMovieboxDetailPath(
      subjectId,
      workerBase,
      proxySecret,
      req.headers,
      requestId
    );
    if (resolvedDetailPath) {
      normalized.params.set("detailPath", resolvedDetailPath);
    } else if (subjectId) {
      normalized.params.set("detailPath", subjectId);
    }
  }

  if (normalized.provider === "dramabox" && normalized.transform === "dramabox-episodes") {
    const episodePayload = await buildDramaboxEpisodesPayload(
      workerBase,
      normalized.params,
      proxySecret,
      req.headers,
      requestId
    );

    if (episodePayload) {
      const transformed = applyTransform(normalized, episodePayload);
      return res.status(200).json(transformed);
    }
  }

  try {
    const result =
            normalized.provider === "dramabox" &&
            normalized.action === "trending" &&
            !normalized.params.get("rankType")
          ? await fetchMergedDramaboxTrending(workerBase, proxySecret, req.headers, normalized, requestId)
          : await fetchNormalizedPayload(workerBase, proxySecret, req.headers, normalized, requestId, req.method);

    const { upstream, payload, transformed } = result;

    if (normalized.provider === "sdrama") {
        if (!upstream?.ok) {
          const errorPayload = await upstream.clone().json().catch(() => null);
          if (errorPayload && typeof errorPayload === "object") {
            return res.status(upstream.status).json(errorPayload);
          }

          const message =
            (await upstream.text().catch(() => null)) ||
            "Upstream SDrama error";
          return res.status(upstream.status || 502).json({ error: message });
        }

        if (!payload) {
          return res.status(upstream?.status || 502).json({ error: "SDrama payload kosong." });
        }

        const cacheControl =
        normalized.action === "detail" || normalized.action === "episodes"
          ? "public, s-maxage=600, stale-while-revalidate=900"
          : "public, s-maxage=300, stale-while-revalidate=600";
      res.setHeader("Cache-Control", cacheControl);
      return res.status(upstream.status).json(applyTransform(normalized, payload));
    }

    if (!normalized.transform || !upstream.ok) {
      return forwardResponse(upstream, res, req.method);
    }

    if (!payload) {
      if (transformed !== null) {
        return res.status(upstream.status).json(transformed);
      }
      return forwardResponse(upstream, res, req.method);
    }

    return res.status(upstream.status).json(transformed);
  } catch {
    return res.status(502).json({ error: "Bad Gateway" });
  }
}
