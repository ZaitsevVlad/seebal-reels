(() => {
  "use strict";

  const ROOT_ID = "local-reels-analyzer-root";
  const BUTTON_ID = "local-reels-analyzer-button";
  const STORE_KEY = "localReelsAnalyzerSettingsV1";
  const IG_APP_ID = "936619743392459";
  const MAX_SCRIPT_CODES = 220;
  const PAGE_SIZE = 36;
  const ANY_MAX = Number.MAX_SAFE_INTEGER;
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const GRAPHQL_DOC_IDS = {
    clipsHome: "26356844137343943",
    feedTimeline: "26119595701076165"
  };
  const GRAPHQL_QUERIES = [
    {
      kind: "clipsHome",
      friendlyName: "PolarisClipsTabDesktopPaginationQuery",
      rootField: "xdt_api__v1__clips__home__connection_v2"
    },
    {
      kind: "feedTimeline",
      friendlyName: "PolarisFeedTimelineRootV2Query",
      rootField: "xdt_api__v1__feed__timeline__connection"
    }
  ];

  const defaultFilters = {
    search: "",
    dateRange: "all",
    sortBy: "newest",
    sortOrder: "desc",
    showFilteredOut: false,
    ranges: {
      plays: [0, ANY_MAX],
      followers: [0, ANY_MAX],
      likes: [0, ANY_MAX],
      comments: [0, ANY_MAX],
      vph: [0, ANY_MAX],
      outlier: [0, ANY_MAX]
    },
    stats: ["plays", "likes", "comments", "followers"]
  };

  const builtInPresets = [
    {
      id: "recent",
      name: "Recent reels",
      description: "Newest reels from this week",
      filters: { dateRange: "thisWeek", sortBy: "newest", sortOrder: "desc" }
    },
    {
      id: "engagement",
      name: "Engagement darlings",
      description: "Strong likes and comments",
      filters: { sortBy: "likes", sortOrder: "desc", ranges: { likes: [1000, ANY_MAX], comments: [25, ANY_MAX] } }
    },
    {
      id: "breakout",
      name: "Breakout reels",
      description: "High plays from small creators",
      filters: { sortBy: "plays", sortOrder: "desc", ranges: { plays: [10000, ANY_MAX], followers: [0, 50000] } }
    },
    {
      id: "velocity",
      name: "Viral velocity",
      description: "Fastest views per hour",
      filters: { sortBy: "vph", sortOrder: "desc", ranges: { vph: [500, ANY_MAX] } }
    },
    {
      id: "outliers",
      name: "Hidden outliers",
      description: "High outlier scores from small creators",
      filters: { sortBy: "outlier", sortOrder: "desc", ranges: { outlier: [2, ANY_MAX], followers: [0, 50000] } }
    },
    {
      id: "evergreens",
      name: "Evergreens",
      description: "Older reels still performing",
      filters: { dateRange: "lastYear", sortBy: "vph", sortOrder: "desc", ranges: { vph: [100, ANY_MAX] } }
    }
  ];

  const state = {
    open: false,
    loading: false,
    loadingMore: false,
    error: "",
    reels: [],
    selectedCode: null,
    settings: structuredClone(defaultFilters),
    customPresets: [],
    hiddenCodes: new Set(),
    fetchedCodes: new Set(),
    nextCursor: null,
    graphqlKind: null,
    profileCache: new Map(),
    creatorMedianCache: new Map(),
    mediaCache: new Map()
  };

  function cloneFilters(value = defaultFilters) {
    return {
      ...structuredClone(defaultFilters),
      ...structuredClone(value),
      ranges: {
        ...structuredClone(defaultFilters.ranges),
        ...(value.ranges ? structuredClone(value.ranges) : {})
      },
      stats: Array.isArray(value.stats) ? [...value.stats] : [...defaultFilters.stats]
    };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function compact(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    if (value >= ANY_MAX / 2) return "Any";
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: digits
    }).format(value);
  }

  function numberInputValue(value) {
    return value >= ANY_MAX / 2 ? "" : String(value);
  }

  function parseNumber(value, fallback) {
    if (value === "") return fallback;
    const parsed = Number(String(value).replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function getCookie(name) {
    return document.cookie
      .split("; ")
      .find((item) => item.startsWith(`${name}=`))
      ?.split("=")[1] ?? "";
  }

  function headers(extra = {}) {
    const result = {
      "X-IG-App-ID": IG_APP_ID,
      "X-CSRFToken": getCookie("csrftoken"),
      ...extra
    };
    const claim = sessionStorage.getItem("www-claim-v2") || getCookie("ig_did");
    if (claim) result["X-IG-WWW-Claim"] = claim;
    return result;
  }

  async function fetchInstagramJson(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: headers(options.headers || {})
    });
    if (response.status === 429) throw new Error("Instagram rate limited this request. Try again later.");
    if (!response.ok) throw new Error(`Instagram request failed (${response.status})`);
    return response.json();
  }

  function scriptToken(name) {
    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent || "";
      const index = text.indexOf(`"${name}"`);
      if (index < 0) continue;
      const chunk = text.slice(index, index + 900);
      const match = chunk.match(/"token"\s*:\s*"([^"]+)"/);
      if (match) return match[1];
    }
    return null;
  }

  function scriptViewerId() {
    if (getCookie("ds_user_id")) return getCookie("ds_user_id");
    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent || "";
      const match = text.match(/"(?:USER_ID|viewerId)"\s*:\s*"(\d+)"/);
      if (match) return match[1];
    }
    return "0";
  }

  function currentReelCode() {
    const match = location.pathname.match(/^\/(?:reel|reels)\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
  }

  function jazoest(value) {
    let total = 0;
    for (const char of value) total += char.charCodeAt(0);
    return `2${total}`;
  }

  function graphqlVariables(query, cursor, count) {
    if (query.kind === "clipsHome") {
      const seenReels = state.reels
        .map((reel) => reel.id || reel.code)
        .filter(Boolean)
        .slice(-120)
        .map((id) => ({ id }));
      return JSON.stringify({
        after: cursor,
        before: null,
        data: {
          container_module: "clips_tab_desktop_page",
          seen_reels: JSON.stringify(seenReels),
          chaining_media_id: currentReelCode(),
          should_refetch_chaining_media: false
        },
        first: count,
        last: null
      });
    }
    return JSON.stringify({
      after: cursor,
      before: null,
      data: {
        device_id: getCookie("ig_did"),
        is_async_ads_double_request: "0",
        is_async_ads_in_headload_enabled: "0",
        is_async_ads_rti: "0",
        rti_delivery_backend: "0"
      },
      first: count,
      last: null,
      variant: "home",
      __relay_internal__pv__PolarisImmersiveFeedChainingEnabledrelayprovider: false
    });
  }

  function mediaNodeFromEdge(edge) {
    const node = edge?.node;
    if (!node || typeof node !== "object") return null;
    return node.media || node.media_or_ad || node.item || node.clips_media || node;
  }

  async function requestGraphqlPage(query, cursor, count) {
    const fbDtsg = scriptToken("DTSGInitialData") || scriptToken("DTSGInitData");
    const lsd = scriptToken("LSD");
    if (!fbDtsg || !lsd) return null;

    const body = new URLSearchParams();
    body.set("av", scriptViewerId());
    body.set("__d", "www");
    body.set("__user", "0");
    body.set("__a", "1");
    body.set("__req", "a");
    body.set("fb_dtsg", fbDtsg);
    body.set("jazoest", jazoest(fbDtsg));
    body.set("lsd", lsd);
    body.set("__spin_b", "trunk");
    body.set("__comet_req", "7");
    body.set("fb_api_caller_class", "RelayModern");
    body.set("fb_api_req_friendly_name", query.friendlyName);
    body.set("variables", graphqlVariables(query, cursor, count));
    body.set("server_timestamps", "true");
    body.set("doc_id", GRAPHQL_DOC_IDS[query.kind]);

    const response = await fetch("/graphql/query", {
      method: "POST",
      credentials: "same-origin",
      headers: headers({
        "Content-Type": "application/x-www-form-urlencoded",
        "X-FB-Friendly-Name": query.friendlyName,
        "X-Root-Field-Name": query.rootField,
        "X-FB-LSD": lsd
      }),
      body: body.toString()
    });
    if (!response.ok) throw new Error(`Instagram GraphQL failed (${response.status})`);
    const data = await response.json();
    const connection = data?.data?.[query.rootField];
    const edges = Array.isArray(connection?.edges) ? connection.edges : [];
    const reels = edges
      .map((edge) => parseMedia(mediaNodeFromEdge(edge)))
      .filter((reel) => reel && reel.code);
    return {
      reels,
      nextCursor: connection?.page_info?.has_next_page ? connection.page_info.end_cursor || null : null,
      kind: query.kind
    };
  }

  async function fetchGraphqlPage(count) {
    const preferred = state.graphqlKind ? GRAPHQL_QUERIES.find((query) => query.kind === state.graphqlKind) : null;
    const queries = preferred ? [preferred, ...GRAPHQL_QUERIES.filter((query) => query !== preferred)] : GRAPHQL_QUERIES;
    for (const query of queries) {
      try {
        const page = await requestGraphqlPage(query, state.nextCursor, count);
        if (page && (page.reels.length || page.nextCursor)) return page;
      } catch (error) {
        console.warn("[Local Reels Analyzer] GraphQL pagination fallback", error);
      }
    }
    return null;
  }

  function shortcodeToMediaId(code) {
    let id = 0n;
    for (const char of code) {
      const index = ALPHABET.indexOf(char);
      if (index < 0) continue;
      id = id * 64n + BigInt(index);
    }
    return id.toString();
  }

  function safeString(value) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
  }

  function safeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  function firstCandidateUrl(imageVersions) {
    const candidates = imageVersions?.candidates;
    return Array.isArray(candidates) && candidates[0] && typeof candidates[0].url === "string" ? candidates[0].url : null;
  }

  function parseMedia(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.code !== "string") return null;
    const user = raw.user && typeof raw.user === "object" ? raw.user : raw.owner && typeof raw.owner === "object" ? raw.owner : null;
    const video = Array.isArray(raw.video_versions) && raw.video_versions[0] ? raw.video_versions[0] : null;
    const coauthors = Array.isArray(raw.coauthor_producers)
      ? raw.coauthor_producers.map((item) => safeString(item?.username)).filter(Boolean)
      : null;

    return {
      id: safeString(raw.id) || safeString(raw.pk) || "",
      code: raw.code,
      media_type: safeNumber(raw.media_type),
      product_type: safeString(raw.product_type),
      play_count: safeNumber(raw.play_count) || safeNumber(raw.video_view_count) || safeNumber(raw.ig_play_count) || safeNumber(raw.view_count) || safeNumber(raw.video_play_count) || safeNumber(raw.fb_play_count),
      video_view_count: safeNumber(raw.video_view_count) || safeNumber(raw.view_count),
      like_count: safeNumber(raw.like_count),
      comment_count: safeNumber(raw.comment_count),
      taken_at: safeNumber(raw.taken_at),
      video_duration: safeNumber(raw.video_duration),
      owner_id: user ? safeString(user.pk) || safeString(user.id) : null,
      username: user ? safeString(user.username) : null,
      caption: safeString(raw.caption?.text) || "",
      thumbnail_url: firstCandidateUrl(raw.image_versions2),
      video_url: safeString(video?.url),
      is_verified: Boolean(user?.is_verified),
      location_name: safeString(raw.location?.name) || safeString(raw.location?.short_name),
      coauthor_producers: coauthors,
      profile_pic_url: safeString(user?.profile_pic_url),
      follower_count: null,
      outlier_score: null,
      fetched_at: Date.now()
    };
  }

  async function fetchMediaInfo(code) {
    if (state.mediaCache.has(code)) return state.mediaCache.get(code);
    const id = shortcodeToMediaId(code);
    const data = await fetchInstagramJson(`/api/v1/media/${id}/info/`);
    const media = Array.isArray(data.items) ? parseMedia(data.items[0]) : null;
    if (media) state.mediaCache.set(code, media);
    return media;
  }

  async function fetchProfile(username) {
    if (!username) return null;
    if (state.profileCache.has(username)) return state.profileCache.get(username);
    const data = await fetchInstagramJson(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
    const user = data?.data?.user;
    if (!user) return null;
    const profile = {
      userId: safeString(user.id),
      followerCount: safeNumber(user.edge_followed_by?.count) || safeNumber(user.follower_count),
      postCount: safeNumber(user.edge_owner_to_timeline_media?.count) || safeNumber(user.media_count),
      avatarUrl: safeString(user.profile_pic_url),
      fullName: safeString(user.full_name),
      isVerified: Boolean(user.is_verified)
    };
    state.profileCache.set(username, profile);
    return profile;
  }

  async function fetchCreatorMedian(ownerId) {
    if (!ownerId) return null;
    if (state.creatorMedianCache.has(ownerId)) return state.creatorMedianCache.get(ownerId);
    const body = `target_user_id=${encodeURIComponent(ownerId)}&page_size=12`;
    const data = await fetchInstagramJson("/api/v1/clips/user/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const likes = Array.isArray(data.items)
      ? data.items
          .map((item) => parseMedia(item?.media)?.like_count ?? 0)
          .filter((value) => value > 0)
          .sort((a, b) => a - b)
      : [];
    const median = medianNumber(likes);
    state.creatorMedianCache.set(ownerId, median);
    return median;
  }

  function medianNumber(values) {
    if (!values.length) return null;
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  }

  function vph(playCount, takenAt) {
    if (!playCount || !takenAt) return null;
    const hours = (Date.now() / 1000 - takenAt) / 3600;
    return playCount / Math.max(1, hours);
  }

  async function enrichReel(reel) {
    const next = { ...reel };
    try {
      if (next.username) {
        const profile = await fetchProfile(next.username);
        next.follower_count = profile?.followerCount ?? next.follower_count;
        next.profile_pic_url = next.profile_pic_url || profile?.avatarUrl || null;
      }
    } catch {}
    try {
      if (next.owner_id) {
        const creatorMedian = await fetchCreatorMedian(next.owner_id);
        next.outlier_score = creatorMedian && next.like_count > 0 ? next.like_count / creatorMedian : null;
      }
    } catch {}
    return next;
  }

  function collectCodes() {
    const codes = new Set();
    const current = location.pathname.match(/^\/(?:reel|reels)\/([A-Za-z0-9_-]+)/);
    if (current) codes.add(current[1]);

    document.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]').forEach((link) => {
      const href = link.getAttribute("href") || "";
      const match = href.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/);
      if (match) codes.add(match[1]);
    });

    if (codes.size < 12) {
      const scripts = Array.from(document.querySelectorAll("script:not([src])"));
      for (const script of scripts) {
        if (codes.size >= MAX_SCRIPT_CODES) break;
        const text = script.textContent || "";
        if (!text.includes('"code"')) continue;
        for (const match of text.matchAll(/"code"\s*:\s*"([A-Za-z0-9_-]{5,})"/g)) {
          codes.add(match[1]);
          if (codes.size >= MAX_SCRIPT_CODES) break;
        }
      }
    }

    return [...codes].filter(Boolean);
  }

  async function mapLimited(items, limit, task) {
    const results = [];
    let index = 0;
    const workers = Array.from({ length: limit }, async () => {
      while (index < items.length) {
        const item = items[index++];
        try {
          results.push(await task(item));
        } catch (error) {
          console.warn("[Local Reels Analyzer]", error);
        }
      }
    });
    await Promise.all(workers);
    return results.filter(Boolean);
  }

  async function loadReels({ more = false } = {}) {
    if (state.loading || state.loadingMore) return;
    state.error = "";
    if (more) {
      state.loadingMore = true;
    } else {
      state.loading = true;
    }
    render();

    try {
      const page = await fetchGraphqlPage(more ? PAGE_SIZE : PAGE_SIZE * 2);
      let media = [];
      if (page) {
        state.graphqlKind = page.kind;
        state.nextCursor = page.nextCursor;
        media = page.reels.filter((reel) => !state.fetchedCodes.has(reel.code));
        media.forEach((reel) => state.fetchedCodes.add(reel.code));
      }

      if (!media.length) {
        if (more) {
          window.scrollBy({ top: window.innerHeight * 2, behavior: "smooth" });
          await sleep(1000);
        }
        const codes = collectCodes().filter((code) => !state.fetchedCodes.has(code)).slice(0, more ? PAGE_SIZE : PAGE_SIZE * 2);
        if (!codes.length && !state.reels.length) {
          state.error = "No reels found on this page. Open /reels/ or a profile Reels grid, then try again.";
        }
        codes.forEach((code) => state.fetchedCodes.add(code));
        media = await mapLimited(codes, 3, fetchMediaInfo);
      }

      const enriched = await mapLimited(media, 2, enrichReel);
      mergeReels(enriched);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
      state.loadingMore = false;
      render();
    }
  }

  function mergeReels(nextItems) {
    const byCode = new Map(state.reels.map((item) => [item.code, item]));
    for (const reel of nextItems) {
      state.fetchedCodes.add(reel.code);
      byCode.set(reel.code, { ...byCode.get(reel.code), ...reel });
    }
    state.reels = [...byCode.values()];
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function resetDiscovery() {
    state.reels = [];
    state.selectedCode = null;
    state.fetchedCodes = new Set();
    state.nextCursor = null;
    state.graphqlKind = null;
  }

  function dateRange(range) {
    const now = Date.now();
    const day = 86400000;
    if (range === "last24Hours") return [now - day, now];
    if (range === "thisWeek") return [now - 7 * day, now];
    if (range === "thisMonth") return [now - 30 * day, now];
    if (range === "last3Months") return [now - 90 * day, now];
    if (range === "last6Months") return [now - 180 * day, now];
    if (range === "lastYear") return [now - 365 * day, now];
    return [0, ANY_MAX];
  }

  function metric(reel, key) {
    if (key === "plays") return reel.play_count;
    if (key === "followers") return reel.follower_count;
    if (key === "likes") return reel.like_count;
    if (key === "comments") return reel.comment_count;
    if (key === "vph") return vph(reel.play_count, reel.taken_at);
    if (key === "outlier") return reel.outlier_score;
    if (key === "newest") return reel.taken_at;
    return 0;
  }

  function applyFilters() {
    const settings = state.settings;
    const search = settings.search.trim().toLowerCase();
    const [from, to] = dateRange(settings.dateRange);

    const rows = state.reels.map((reel) => {
      const reasons = [];
      if (search) {
        const haystack = `${reel.username || ""} ${reel.caption || ""}`.toLowerCase();
        if (!haystack.includes(search.replace(/^@/, ""))) reasons.push("search");
      }
      for (const key of Object.keys(settings.ranges)) {
        const value = metric(reel, key);
        const [min, max] = settings.ranges[key];
        if (typeof value !== "number" || value < min || value > max) reasons.push(key);
      }
      const published = reel.taken_at ? reel.taken_at * 1000 : 0;
      if (!published || published < from || published > to) reasons.push("date");
      return { reel, reasons };
    });

    const visible = settings.showFilteredOut ? rows : rows.filter((row) => row.reasons.length === 0);
    const order = settings.sortOrder === "asc" ? 1 : -1;
    visible.sort((a, b) => {
      const left = metric(a.reel, settings.sortBy) ?? -1;
      const right = metric(b.reel, settings.sortBy) ?? -1;
      return (left - right) * order;
    });

    return {
      rows: visible,
      total: rows.length,
      filtered: rows.filter((row) => row.reasons.length === 0).length
    };
  }

  function statLabel(key) {
    return {
      plays: "Plays",
      followers: "Followers",
      likes: "Likes",
      comments: "Comments",
      vph: "VPH",
      outlier: "Outlier"
    }[key] || key;
  }

  function render() {
    ensureRoots();
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.innerHTML = state.open ? overlayHtml() : "";
    wireEvents(root);
  }

  function ensureRoots() {
    if (!document.getElementById(BUTTON_ID)) {
      const button = document.createElement("button");
      button.id = BUTTON_ID;
      button.type = "button";
      button.title = "Open Local Reels Analyzer";
      button.textContent = "LR";
      button.addEventListener("click", () => {
        state.open = true;
        render();
        if (!state.reels.length) loadReels();
      });
      document.body.appendChild(button);
    }
    if (!document.getElementById(ROOT_ID)) {
      const root = document.createElement("div");
      root.id = ROOT_ID;
      document.body.appendChild(root);
    }
  }

  function overlayHtml() {
    const { rows } = applyFilters();
    const selected = state.selectedCode ? state.reels.find((item) => item.code === state.selectedCode) : null;
    return `
      <div class="lra-overlay">
        <aside class="lra-sidebar">
          <div class="lra-side-head">
            <span>Presets</span>
            <button class="lra-icon" data-action="close">x</button>
          </div>
          <div class="lra-presets">
            ${builtInPresets.map(presetHtml).join("")}
            ${state.customPresets.map(presetHtml).join("")}
          </div>
          <div class="lra-divider"></div>
          ${filtersHtml()}
        </aside>
        <main class="lra-main">
          <header class="lra-topbar">
            <div class="lra-title"><span class="lra-logo">LR</span><strong>Discovery</strong></div>
            <label class="lra-control">Sort
              <select data-field="sortBy">
                ${option("newest", "Newest", state.settings.sortBy)}
                ${option("plays", "Plays", state.settings.sortBy)}
                ${option("likes", "Likes", state.settings.sortBy)}
                ${option("comments", "Comments", state.settings.sortBy)}
                ${option("followers", "Followers", state.settings.sortBy)}
                ${option("vph", "VPH", state.settings.sortBy)}
                ${option("outlier", "Outlier", state.settings.sortBy)}
              </select>
            </label>
            <button class="lra-sort-dir" data-action="toggle-sort">${state.settings.sortOrder === "asc" ? "Asc" : "Desc"}</button>
            <input class="lra-search" data-field="search" value="${escapeHtml(state.settings.search)}" placeholder="Search by caption or username">
            <span class="lra-count">${compact(rows.length, 0)} shown / ${compact(state.reels.length, 0)} loaded</span>
            <button class="lra-primary" data-action="load-more" ${state.loadingMore ? "disabled" : ""}>${state.loadingMore ? "Loading..." : "Load more reels"}</button>
          </header>
          <section class="lra-chips">
            ${activeChipsHtml()}
            <button class="lra-link" data-action="clear-filters">Clear all</button>
          </section>
          <section class="lra-banner">
            <span class="lra-banner-icon">LR</span>
            <strong>Local discovery mode</strong>
            <span>Instagram data only. No vidIQ backend, no analytics upload, no feature flags.</span>
          </section>
          ${state.error ? `<div class="lra-error">${escapeHtml(state.error)}</div>` : ""}
          ${state.loading ? `<div class="lra-loading">Loading reels from Instagram...</div>` : cardsHtml(rows)}
        </main>
        ${selected ? focusHtml(selected) : ""}
      </div>
    `;
  }

  function presetHtml(preset) {
    return `
      <button class="lra-preset" data-action="preset" data-preset="${escapeHtml(preset.id)}">
        <span class="lra-preset-icon">${preset.id === "outliers" ? "x" : preset.id === "velocity" ? "^" : "*"}</span>
        <span><strong>${escapeHtml(preset.name)}</strong><small>${escapeHtml(preset.description || "")}</small></span>
      </button>
    `;
  }

  function filtersHtml() {
    const settings = state.settings;
    return `
      <section class="lra-filter-block">
        <h3>Custom filters</h3>
        <label class="lra-check"><input type="checkbox" data-field="showFilteredOut" ${settings.showFilteredOut ? "checked" : ""}> Show filtered out cards</label>
        <label class="lra-control full">Publish date
          <select data-field="dateRange">
            ${option("all", "Any time", settings.dateRange)}
            ${option("last24Hours", "Last 24 hours", settings.dateRange)}
            ${option("thisWeek", "This week", settings.dateRange)}
            ${option("thisMonth", "This month", settings.dateRange)}
            ${option("last3Months", "Last 3 months", settings.dateRange)}
            ${option("last6Months", "Last 6 months", settings.dateRange)}
            ${option("lastYear", "Last year", settings.dateRange)}
          </select>
        </label>
        <div class="lra-stat-picks">
          <p>Show on cards</p>
          ${Object.keys(defaultFilters.ranges).map((key) => `
            <button class="lra-pill ${settings.stats.includes(key) ? "is-on" : ""}" data-action="toggle-stat" data-stat="${key}">${statLabel(key)}</button>
          `).join("")}
        </div>
        ${rangeHtml("plays", "Plays")}
        ${rangeHtml("followers", "Followers")}
        ${rangeHtml("likes", "Likes")}
        ${rangeHtml("comments", "Comments")}
        ${rangeHtml("vph", "VPH")}
        ${rangeHtml("outlier", "Outlier")}
        <div class="lra-side-actions">
          <button data-action="reset">Reset</button>
          <button class="lra-primary" data-action="save-preset">Save preset</button>
        </div>
      </section>
    `;
  }

  function rangeHtml(key, label) {
    const [min, max] = state.settings.ranges[key];
    return `
      <div class="lra-range">
        <span>${label}</span>
        <input data-range="${key}" data-bound="min" placeholder="min" value="${escapeHtml(numberInputValue(min))}">
        <input data-range="${key}" data-bound="max" placeholder="max" value="${escapeHtml(numberInputValue(max))}">
      </div>
    `;
  }

  function activeChipsHtml() {
    const chips = [];
    const settings = state.settings;
    if (settings.dateRange !== "all") chips.push(`Publish date: ${settings.dateRange}`);
    for (const [key, [min, max]] of Object.entries(settings.ranges)) {
      if (min > 0 || max < ANY_MAX / 2) chips.push(`${statLabel(key)}: ${compact(min, 0)}-${compact(max, 0)}`);
    }
    if (!chips.length) return "";
    return chips.map((chip) => `<span class="lra-chip">${escapeHtml(chip)}</span>`).join("");
  }

  function cardsHtml(rows) {
    if (!rows.length) return `<div class="lra-empty">No reels match the current filters.</div>`;
    return `<section class="lra-grid">${rows.map(({ reel, reasons }) => cardHtml(reel, reasons)).join("")}</section>`;
  }

  function cardHtml(reel, reasons) {
    const score = reel.outlier_score ? `${reel.outlier_score >= 10 ? Math.round(reel.outlier_score) : reel.outlier_score.toFixed(1)}x` : null;
    return `
      <article class="lra-card" data-action="focus" data-code="${escapeHtml(reel.code)}">
        <div class="lra-media">
          ${reel.thumbnail_url ? `<img src="${escapeHtml(reel.thumbnail_url)}" loading="lazy" alt="">` : `<div class="lra-no-thumb">No preview</div>`}
          ${score ? `<span class="lra-badge">${escapeHtml(score)}</span>` : ""}
          ${reasons.length ? `<span class="lra-filtered">Filtered: ${escapeHtml(reasons.join(", "))}</span>` : ""}
        </div>
        <div class="lra-card-body">
          <div class="lra-user">${reel.profile_pic_url ? `<img src="${escapeHtml(reel.profile_pic_url)}" alt="">` : ""}<strong>@${escapeHtml(reel.username || "unknown")}</strong></div>
          <p>${escapeHtml((reel.caption || "").slice(0, 120))}</p>
          <div class="lra-stats">${state.settings.stats.slice(0, 4).map((stat) => `<span>${statLabel(stat)} <b>${compact(metric(reel, stat))}</b></span>`).join("")}</div>
        </div>
      </article>
    `;
  }

  function focusHtml(reel) {
    return `
      <div class="lra-modal-backdrop" data-action="unfocus">
        <div class="lra-modal" data-stop>
          <button class="lra-icon lra-modal-close" data-action="unfocus">x</button>
          <div class="lra-modal-media">
            ${reel.video_url ? `<video src="${escapeHtml(reel.video_url)}" poster="${escapeHtml(reel.thumbnail_url || "")}" controls autoplay loop playsinline></video>` : `<img src="${escapeHtml(reel.thumbnail_url || "")}" alt="">`}
          </div>
          <div class="lra-modal-info">
            <h2>@${escapeHtml(reel.username || "unknown")}</h2>
            <p>${escapeHtml(reel.caption || "")}</p>
            <div class="lra-modal-stats">
              ${Object.keys(defaultFilters.ranges).map((key) => `<span>${statLabel(key)} <b>${compact(metric(reel, key))}</b></span>`).join("")}
            </div>
            <div class="lra-modal-actions">
              <a href="https://www.instagram.com/reel/${escapeHtml(reel.code)}/" target="_blank" rel="noreferrer">Open on Instagram</a>
              ${reel.video_url ? `<a href="${escapeHtml(reel.video_url)}" target="_blank" rel="noreferrer">Open video file</a>` : ""}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function option(value, label, selected) {
    return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }

  function wireEvents(root) {
    root.querySelectorAll("[data-field]").forEach((element) => {
      element.addEventListener("change", handleField);
    });
    root.querySelectorAll("[data-range]").forEach((element) => {
      element.addEventListener("change", handleRange);
    });
    root.querySelectorAll("[data-action]").forEach((element) => {
      element.addEventListener("click", handleAction);
    });
  }

  function handleField(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    if (event.currentTarget.type === "checkbox") state.settings[field] = event.currentTarget.checked;
    else state.settings[field] = event.currentTarget.value;
    saveSettings();
    render();
  }

  function handleRange(event) {
    const key = event.currentTarget.dataset.range;
    const bound = event.currentTarget.dataset.bound;
    if (!key || !bound) return;
    const current = state.settings.ranges[key] || [0, ANY_MAX];
    const value = parseNumber(event.currentTarget.value, bound === "min" ? 0 : ANY_MAX);
    state.settings.ranges[key] = bound === "min" ? [value, current[1]] : [current[0], value];
    saveSettings();
    render();
  }

  function handleAction(event) {
    const target = event.currentTarget;
    const action = target.dataset.action;
    if (action === "unfocus" && target.classList.contains("lra-modal-backdrop") && event.target.closest("[data-stop]")) return;
    if (target.dataset.stop !== undefined) return;
    if (action === "close") state.open = false;
    if (action === "load-more") loadReels({ more: true });
    if (action === "toggle-sort") state.settings.sortOrder = state.settings.sortOrder === "asc" ? "desc" : "asc";
    if (action === "clear-filters") state.settings = { ...cloneFilters(state.settings), ranges: structuredClone(defaultFilters.ranges), dateRange: "all", search: "" };
    if (action === "reset") state.settings = cloneFilters(defaultFilters);
    if (action === "toggle-stat") toggleStat(target.dataset.stat);
    if (action === "preset") applyPreset(target.dataset.preset);
    if (action === "save-preset") savePreset();
    if (action === "focus") state.selectedCode = target.dataset.code;
    if (action === "unfocus") state.selectedCode = null;
    saveSettings();
    render();
  }

  function toggleStat(stat) {
    if (!stat) return;
    const stats = state.settings.stats;
    if (stats.includes(stat)) {
      if (stats.length > 1) state.settings.stats = stats.filter((item) => item !== stat);
    } else if (stats.length < 4) {
      state.settings.stats = [...stats, stat];
    }
  }

  function applyPreset(id) {
    const preset = [...builtInPresets, ...state.customPresets].find((item) => item.id === id);
    if (!preset) return;
    const next = cloneFilters(state.settings);
    const presetFilters = cloneFilters({ ...next, ...preset.filters });
    state.settings = presetFilters;
  }

  function savePreset() {
    const name = prompt("Preset name");
    if (!name || !name.trim()) return;
    state.customPresets.push({
      id: `custom-${Date.now()}`,
      name: name.trim(),
      description: "Saved locally",
      filters: cloneFilters(state.settings)
    });
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({
        [STORE_KEY]: {
          settings: state.settings,
          customPresets: state.customPresets
        }
      });
    } catch {}
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(STORE_KEY);
      const data = stored[STORE_KEY] || {};
      state.settings = cloneFilters(data.settings);
      state.customPresets = Array.isArray(data.customPresets) ? data.customPresets : [];
    } catch {}
  }

  function installRouteWatcher() {
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        resetDiscovery();
        if (state.open) loadReels();
      }
    }, 1000);
  }

  loadSettings().finally(() => {
    ensureRoots();
    installRouteWatcher();
  });
})();
