const { app, BrowserWindow, ipcMain, dialog, Notification, session, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ─── Constants ────────────────────────────────────────
const IG_APP_ID = '936619743392459';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STORE_FILE = path.join(app.getPath('userData'), 'app-store.json');

let mainWindow = null;
let monitorTimers = {};
const igCooldowns = new Map();

const IG_RATE_LIMIT_MS = 2 * 60 * 1000;
const USER_CACHE_MS = 15 * 60 * 1000;
const userInfoCache = new Map();
const reelMetricsCache = new Map();

// ─── Simple JSON Store ────────────────────────────────
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveStore(data) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}
function getSetting(key, def) {
  return loadStore()[key] ?? def;
}
function setSetting(key, val) {
  const s = loadStore(); s[key] = val; saveStore(s);
}

// ─── Instagram Cookie Helpers ─────────────────────────
async function getIGCookies() {
  // Fetch cookies from all instagram domains
  const cookies = await session.defaultSession.cookies.get({ url: 'https://www.instagram.com' });
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}
async function getCSRFToken() {
  const cookies = await session.defaultSession.cookies.get({ url: 'https://www.instagram.com' });
  const csrf = cookies.find(c => c.name === 'csrftoken');
  return csrf?.value || '';
}
async function checkLoggedIn() {
  const cookies = await session.defaultSession.cookies.get({ url: 'https://www.instagram.com' });
  const sid = cookies.find(c => c.name === 'sessionid');
  return !!sid && !!sid.value;
}

// ─── Instagram Login Window ───────────────────────────
function openLoginWindow() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480, height: 780,
      parent: mainWindow, modal: true,
      title: 'Вход в Instagram',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // Allow the login page to load all scripts (needed for CAPTCHA)
        webSecurity: true
      }
    });
    win.setMenuBarVisibility(false);
    // Use a standard mobile user-agent so Instagram shows the regular login form
    win.webContents.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
    );
    win.loadURL('https://www.instagram.com/accounts/login/', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
    });

    let closed = false;
    let pollTimer = null;

    // Robust cookie polling – works regardless of what URL Instagram redirects to
    // after captcha, 2FA, challenge, or any regional variant
    const pollLogin = async () => {
      if (closed) return;
      try {
        const loggedIn = await checkLoggedIn();
        if (loggedIn) {
          closed = true;
          clearInterval(pollTimer);
          if (!win.isDestroyed()) win.close();
          resolve(true);
          return;
        }
      } catch (_) {}
      // Keep polling every 1.5 seconds while window is open
    };

    // Also check on every navigation (fast path for simple redirects)
    const checkOnNav = async (_e, url) => {
      if (closed) return;
      // Skip pages that are clearly still part of the auth flow
      const authPages = [
        '/accounts/login',
        '/accounts/onetap',
        '/challenge',
        '/two_factor',
        '/checkpoint',
        '/accounts/suspended',
        'login_attempt'
      ];
      const isAuthPage = authPages.some(p => url.includes(p));
      if (!isAuthPage && url.includes('instagram.com')) {
        // Navigation landed somewhere that isn't a login page — likely home
        const loggedIn = await checkLoggedIn();
        if (loggedIn && !closed) {
          closed = true;
          clearInterval(pollTimer);
          if (!win.isDestroyed()) win.close();
          resolve(true);
        }
      }
    };

    pollTimer = setInterval(pollLogin, 1500);
    win.webContents.on('did-navigate', checkOnNav);
    win.webContents.on('did-redirect-navigation', checkOnNav);
    win.on('closed', async () => {
      if (!closed) {
        closed = true;
        clearInterval(pollTimer);
        resolve(await checkLoggedIn());
      }
    });
  });
}

// ─── Instagram API Fetch ──────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getIGCooldownKey(url) {
  if (url.includes('/web_profile_info/')) return 'profile';
  if (url.includes('/web/search/topsearch/')) return 'search';
  if (url.includes('/clips/user/')) return 'reels';
  if (url.includes('/feed/user/')) return 'user-feed';
  if (url.includes('/clips/trending/')) return 'trending';
  return url;
}

function igError(message, code, status = 0) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function fetchIG(url, method = 'GET', body = null, retries = 0, options = {}) {
  const cooldownKey = getIGCooldownKey(url);
  const cooldownLeft = (igCooldowns.get(cooldownKey) || 0) - Date.now();
  if (!options.ignoreCooldown && cooldownLeft > 0) {
    const seconds = Math.ceil(cooldownLeft / 1000);
    throw igError(`Instagram временно ограничил запросы. Подождите ${seconds} сек.`, 'IG_COOLDOWN', 429);
  }

  const cookie = await getIGCookies();
  const csrf = await getCSRFToken();

  if (!cookie || !cookie.includes('sessionid')) {
    console.warn('[IG API] No sessionid cookie found! User may not be logged in.');
  }

  const headers = {
    'User-Agent': UA,
    'Cookie': cookie,
    'X-IG-App-ID': IG_APP_ID,
    'X-IG-WWW-Claim': '0',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRFToken': csrf,
    'Accept': '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://www.instagram.com/',
    'Origin': 'https://www.instagram.com',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"'
  };
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';

  const fetchOpts = {
    method,
    headers,
    credentials: 'include',
    redirect: 'follow'
  };
  if (body) fetchOpts.body = body;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(3000 * Math.pow(2, attempt - 1), 15000);
      console.log(`[IG API] Retry ${attempt}/${retries} after ${delay}ms...`);
      if (mainWindow) mainWindow.webContents.send('loading-status', `Повтор ${attempt}/${retries}...`);
      await sleep(delay);
    }

    let response, text;
    try {
      response = await net.fetch(url, fetchOpts);
      text = await response.text();
    } catch (netErr) {
      console.error(`[IG API] Network error on ${url}:`, netErr.message);
      if (attempt < retries) continue;
      throw new Error('Ошибка сети. Проверьте подключение к интернету.');
    }

    console.log(`[IG API] ${method} ${url.split('?')[0]} → ${response.status} (${text.length}b)`);
    if (text.length < 1000) {
      console.log(`[IG API] Body: ${text}`);
    } else {
      console.log(`[IG API] Body preview: ${text.substring(0, 300)}...`);
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '', 10);
      igCooldowns.set(cooldownKey, Date.now() + (Number.isFinite(retryAfter) ? retryAfter * 1000 : IG_RATE_LIMIT_MS));
      throw igError('Instagram ограничил запросы. Подождите 2 минуты.', 'IG_RATE_LIMITED', 429);
    }

    if (response.status === 401 || response.status === 403) {
      console.error(`[IG API] Auth error ${response.status}`);
      throw igError('Сессия истекла. Нажмите «Войти в Instagram» и авторизуйтесь заново.', 'IG_AUTH', response.status);
    }

    if (!response.ok) {
      console.error(`[IG API] HTTP ${response.status}`);
      throw igError(`Ошибка Instagram (${response.status}). Попробуйте позже.`, 'IG_HTTP', response.status);
    }

    // Parse JSON response
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error(`[IG API] Non-JSON response:`, text.substring(0, 300));
      if (text.includes('login') || text.includes('LoginAndSignupPage')) {
        throw new Error('Instagram требует авторизацию. Нажмите «Войти в Instagram».');
      }
      if (attempt < retries) continue;
      throw new Error('Instagram вернул неожиданный ответ. Попробуйте позже.');
    }

    if (data?.status === 'fail' || data?.message === 'login_required') {
      console.error('[IG API] login_required/fail:', JSON.stringify(data).substring(0, 300));
      throw new Error('Instagram требует авторизацию. Нажмите «Войти в Instagram».');
    }

    return data;
  }
}

// ─── Instagram: Get User Info ─────────────────────────
async function getUserInfo(username) {
  const normalized = username.trim().replace(/^@/, '').toLowerCase();
  const cached = userInfoCache.get(normalized);
  if (cached && Date.now() - cached.ts < USER_CACHE_MS) return cached.user;

  let user = null;
  try {
    const d = await fetchIG(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(normalized)}`);
    user = d?.data?.user;
  } catch (e) {
    if (e.code !== 'IG_RATE_LIMITED' && e.code !== 'IG_COOLDOWN') throw e;
    console.warn(`[IG API] web_profile_info failed for ${normalized}; trying topsearch fallback`);
  }

  if (!user) {
    const d = await fetchIG(`https://www.instagram.com/web/search/topsearch/?query=${encodeURIComponent(normalized)}`, 'GET', null, 0, { ignoreCooldown: true });
    const found = (d?.users || [])
      .map(item => item.user || item)
      .find(item => item?.username?.toLowerCase() === normalized);
    if (found) {
      user = {
        id: found.pk || found.pk_id || found.id,
        username: found.username,
        full_name: found.full_name,
        profile_pic_url_hd: found.profile_pic_url,
        profile_pic_url: found.profile_pic_url,
        is_private: !!found.is_private,
        edge_followed_by: { count: found.follower_count || 0 },
        edge_follow: { count: found.following_count || null },
        edge_owner_to_timeline_media: { count: null },
        _fromSearch: true
      };
    }
  }

  if (!user?.id) throw new Error('Пользователь не найден');
  const info = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    avatar: user.profile_pic_url_hd || user.profile_pic_url,
    isPrivate: user.is_private,
    followers: user.edge_followed_by?.count ?? null,
    following: user.edge_follow?.count ?? null,
    posts: user.edge_owner_to_timeline_media?.count ?? null,
    _fromSearch: !!user._fromSearch
  };
  userInfoCache.set(normalized, { ts: Date.now(), user: info });

  // Auto-update saved account data when we successfully fetch user info
  const savedAccounts = getSetting('savedAccounts', []);
  const savedIdx = savedAccounts.findIndex(a => a.username === info.username);
  if (savedIdx >= 0) {
    savedAccounts[savedIdx] = {
      ...savedAccounts[savedIdx],
      fullName: info.fullName,
      avatar: info.avatar,
      userId: info.id,
      followers: info.followers,
      following: info.following,
      posts: info.posts,
      lastUpdated: Date.now()
    };
    setSetting('savedAccounts', savedAccounts);
  }

  return info;
}

// ─── Instagram: Get Reels ─────────────────────────────
function parseReelItem(item) {
  const media = item.media || item;
  const videoVersions = media.video_versions || [];
  const bestVideo = videoVersions.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  const imageVersions = media.image_versions2?.candidates || [];
  const bestThumb = imageVersions.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];

  // Extract author info for discover feed
  const owner = media.user || media.owner || {};

  return {
    id: media.pk || media.id,
    code: media.code,
    videoUrl: bestVideo?.url || '',
    thumbnailUrl: bestThumb?.url || '',
    duration: media.video_duration || 0,
    viewCount: media.ig_play_count || media.play_count || media.fb_play_count || media.view_count || media.video_view_count || 0,
    likeCount: media.like_count || 0,
    commentCount: media.comment_count || 0,
    shareCount: media.reshare_count || media.share_count || 0,
    saveCount: media.save_count || 0,
    caption: media.caption?.text || '',
    takenAt: media.taken_at || 0,
    width: media.original_width || 0,
    height: media.original_height || 0,
    author: {
      id: owner.pk || owner.pk_id || owner.id || '',
      username: owner.username || '',
      fullName: owner.full_name || '',
      avatar: owner.profile_pic_url || '',
      isPrivate: !!owner.is_private
    }
  };
}

async function enrichReelMetrics(items) {
  for (const item of items) {
    const cached = reelMetricsCache.get(String(item.id));
    if (cached && Date.now() - cached.ts < USER_CACHE_MS) {
      item.viewCount = cached.viewCount;
      continue;
    }

    try {
      const data = await fetchIG(`https://www.instagram.com/api/v1/media/${encodeURIComponent(item.id)}/info/`);
      const media = data.items?.[0] || data.item;
      const viewCount = media?.ig_play_count || media?.play_count || media?.fb_play_count || media?.view_count || media?.video_view_count || 0;
      item.viewCount = viewCount;
      reelMetricsCache.set(String(item.id), { ts: Date.now(), viewCount });
      await sleep(100);
    } catch (error) {
      console.warn(`[Discover] Metrics unavailable for ${item.id}:`, error.message);
      if (error.code === 'IG_RATE_LIMITED' || error.code === 'IG_COOLDOWN') break;
    }
  }

  return items;
}

async function getUserReels(userId, cursor = '') {
  // Strategy 1: clips/user POST – returns only Reels (most accurate)
  const tryClips = async (cur) => {
    const params = new URLSearchParams({
      target_user_id: String(userId),
      page_size: '12',
      include_feed_video: 'true'
    });
    if (cur) params.append('max_id', cur);
    const d = await fetchIG('https://i.instagram.com/api/v1/clips/user/', 'POST', params.toString());
    const items = (d.items || []).map(parseReelItem).filter(i => i.videoUrl);
    return {
      items,
      hasMore: !!d.paging_info?.more_available,
      cursor: d.paging_info?.max_id || ''
    };
  };

  // Strategy 2: feed/user GET – returns all media, we filter for videos/reels
  const tryFeed = async (cur) => {
    const query = new URLSearchParams({ count: '50' });
    if (cur) query.set('max_id', cur);
    const d = await fetchIG(`https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/?${query}`);
    const items = (d.items || [])
      .filter(item => item.media_type === 2 || item.product_type === 'clips' || item.video_versions?.length > 0)
      .map(parseReelItem)
      .filter(i => i.videoUrl);
    return {
      items,
      hasMore: !!d.more_available && !!(d.next_max_id),
      cursor: d.next_max_id || ''
    };
  };

  // Try clips first, fall back to feed
  let clipsResult = null;
  let clipsError = null;
  try {
    clipsResult = await tryClips(cursor);
  } catch (e) {
    clipsError = e;
    console.warn('[getUserReels] clips/user failed:', e.message);
  }

  // If clips returned items, use that
  if (clipsResult && clipsResult.items.length > 0) {
    return clipsResult;
  }

  // Fall back to user feed
  try {
    const feedResult = await tryFeed(cursor);
    if (feedResult.items.length > 0) return feedResult;
    // If feed also empty but clips had a response with pagination, keep that cursor
    if (clipsResult) return clipsResult;
    return feedResult;
  } catch (feedErr) {
    console.warn('[getUserReels] feed/user also failed:', feedErr.message);
    if (clipsResult) return clipsResult; // return empty clips result rather than throwing
    throw clipsError || feedErr;
  }
}

// ─── Instagram: Get Discover/Explore Reels ────────────
function findReelsConnection(root) {
  const seen = new WeakSet();
  let best = null;

  function visit(value, depth) {
    if (!value || typeof value !== 'object' || depth > 12 || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value.edges)) {
      const media = value.edges
        .map(edge => edge?.node?.media || edge?.node || edge?.media || edge)
        .filter(item => item?.video_versions?.length || item?.media?.video_versions?.length)
        .map(item => item.media || item);
      if (!best || media.length > best.media.length) best = { connection: value, media };
    }

    for (const child of Object.values(value)) visit(child, depth + 1);
  }

  visit(root, 0);
  return best;
}

async function getTrendingReels(cursor = '') {
  const variables = {
    after: cursor || null,
    before: null,
    data: { container_module: 'clips_tab_desktop_page', seen_reels: '[]' },
    first: 12,
    last: null,
    __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
    __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false
  };
  const body = new URLSearchParams({
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'PolarisClipsTabDesktopPaginationQuery',
    variables: JSON.stringify(variables),
    doc_id: '36825039943776829'
  });
  const graphData = await fetchIG('https://www.instagram.com/graphql/query', 'POST', body.toString());
  const graphResult = findReelsConnection(graphData);

  if (!graphResult || graphResult.media.length === 0) {
    throw new Error('Instagram не вернул трендовые Reels. Попробуйте обновить ленту позже.');
  }

  const graphPageInfo = graphResult.connection.page_info || {};
  const graphItems = await enrichReelMetrics(graphResult.media.map(parseReelItem));
  return {
    items: graphItems,
    hasMore: !!graphPageInfo.has_next_page,
    cursor: graphPageInfo.end_cursor || ''
  };

  const endpoints = [
    { url: 'https://i.instagram.com/api/v1/clips/reels_tab/', method: 'POST', type: 'clips' },
    { url: 'https://i.instagram.com/api/v1/discover/web/explore_grid/?is_prefetch=false&omit_cover_media=false&module=explore_popular&use_sectional_payload=true', method: 'GET', type: 'explore' },
    { url: 'https://www.instagram.com/api/v1/feed/reels_tray/', method: 'GET', type: 'tray' }
  ];

  let lastError = null;

  for (const ep of endpoints) {
    try {
      let d;
      if (ep.method === 'POST') {
        const params = new URLSearchParams({ page_size: '30', include_feed_video: 'true' });
        if (cursor && ep.type === 'clips') params.append('max_id', cursor);
        d = await fetchIG(ep.url, 'POST', params.toString());
      } else {
        let url = ep.url;
        if (cursor) url += `?max_id=${encodeURIComponent(cursor)}`;
        d = await fetchIG(url, 'GET');
      }

      let items = [];
      if (ep.type === 'clips') {
        items = (d.items || []).map(parseReelItem);
      } else if (ep.type === 'tray') {
        // reels_tray format: d.tray is array of user objects with media items
        const tray = d.tray || [];
        for (const trayItem of tray) {
          const media = trayItem.media || trayItem;
          if (media.media_type === 2 || media.video_versions?.length > 0) {
            items.push(parseReelItem({ media }));
          }
        }
      } else {
        // Explore grid
        const rawItems = d.sectional_items || d.items || d.media_items || [];
        const mediaList = [];
        for (const section of rawItems) {
          const layoutContent = section.layout_content || {};
          const medias = layoutContent.medias || layoutContent.fill_items || section.media || [];
          for (const m of medias) {
            const media = m.media || m;
            if (media.media_type === 2 || media.video_versions?.length > 0) {
              mediaList.push({ media });
            }
          }
        }
        items = mediaList.map(parseReelItem);
      }

      if (items.length > 0) {
        return {
          items,
          hasMore: !!(d.paging_info?.more_available || d.more_available),
          cursor: d.paging_info?.max_id || d.next_max_id || ''
        };
      }
      console.warn(`[Discover] ${ep.url} returned 0 items`);
    } catch (e) {
      lastError = e;
      console.warn(`[Discover] ${ep.url} failed:`, e.message);
    }
  }

  // Instagram frequently disables its web Explore endpoints while profile
  // reels remain available. Build a useful feed from saved public accounts.
  if (!cursor) {
    const accounts = getSetting('savedAccounts', []).filter(account => account.userId && !account.hidden);
    const mixed = [];

    for (const account of accounts.slice(0, 8)) {
      try {
        const data = await getUserReels(account.userId, '');
        mixed.push(...(data.items || []));
      } catch (error) {
        console.warn(`[Discover] Saved account @${account.username} failed:`, error.message);
      }
    }

    const unique = [...new Map(mixed.map(item => [String(item.id), item])).values()];
    if (unique.length > 0) {
      unique.sort(() => Math.random() - 0.5);
      return { items: unique.slice(0, 50), hasMore: false, cursor: '' };
    }
  }

  throw lastError || new Error('Не удалось загрузить ленту. Попробуйте позже.');
}

// ─── Proxy Avatar ─────────────────────────────────────
async function proxyAvatar(avatarUrl) {
  if (!avatarUrl) return '';
  try {
    const cookie = await getIGCookies();
    const response = await net.fetch(avatarUrl, {
      headers: {
        'User-Agent': UA,
        'Cookie': cookie,
        'Referer': 'https://www.instagram.com/'
      },
      credentials: 'include'
    });
    if (!response.ok) return '';
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const base64 = Buffer.from(buffer).toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch (e) {
    console.error('[Proxy Avatar] Failed:', e.message);
    return '';
  }
}

// ─── Download Video File ──────────────────────────────
function downloadFile(videoUrl, destPath, reelId) {
  return new Promise((resolve, reject) => {
    const follow = (dlUrl) => {
      const u = new URL(dlUrl);
      const proto = u.protocol === 'https:' ? https : http;
      proto.get(dlUrl, { headers: { 'User-Agent': UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const total = parseInt(res.headers['content-length'], 10) || 0;
        let downloaded = 0;
        const ws = fs.createWriteStream(destPath);
        res.on('data', chunk => {
          downloaded += chunk.length;
          ws.write(chunk);
          if (total > 0 && mainWindow) {
            mainWindow.webContents.send('download-progress', { reelId, progress: downloaded / total });
          }
        });
        res.on('end', () => { ws.end(); resolve(destPath); });
        res.on('error', e => { ws.end(); reject(e); });
      }).on('error', reject);
    };
    follow(videoUrl);
  });
}

// ─── Monitoring ───────────────────────────────────────
function startMonitoring() {
  const accounts = getSetting('savedAccounts', []);
  accounts.forEach(acc => {
    if (monitorTimers[acc.username]) return;
    monitorTimers[acc.username] = setInterval(async () => {
      try {
        const reelsData = await getUserReels(acc.userId, '');
        if (reelsData.items.length > 0) {
          const latest = reelsData.items[0];
          const lastSeen = getSetting(`lastReel_${acc.username}`, '');
          if (lastSeen && latest.id.toString() !== lastSeen) {
            setSetting(`lastReel_${acc.username}`, latest.id.toString());
            new Notification({
              title: 'Новый Reels!',
              body: `@${acc.username} опубликовал новый Reels`,
              icon: path.join(__dirname, 'src', 'icon.png')
            }).show();
            if (mainWindow) mainWindow.webContents.send('new-reel-detected', { username: acc.username });
          } else if (!lastSeen && latest.id) {
            setSetting(`lastReel_${acc.username}`, latest.id.toString());
          }
        }
      } catch (e) { /* silently continue */ }
    }, 5 * 60 * 1000); // check every 5 minutes
  });
}

function stopAllMonitoring() {
  Object.values(monitorTimers).forEach(clearInterval);
  monitorTimers = {};
}

// ─── Create Main Window ──────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    x: 80, y: 80,
    show: true,
    skipTaskbar: false,
    backgroundColor: '#0a0a12',
    title: 'ssibalss_reels',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // needed for loading IG thumbnails
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
  });
  mainWindow.show();
  mainWindow.focus();
  // Open external links (telegram etc) in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; stopAllMonitoring(); });
}

// ─── IPC Handlers ────────────────────────────────────
ipcMain.handle('check-login', () => checkLoggedIn());
ipcMain.handle('login', () => openLoginWindow());
ipcMain.handle('logout', async () => {
  await session.defaultSession.clearStorageData({ storages: ['cookies'] });
  return true;
});

ipcMain.handle('get-user-info', async (_e, username) => {
  return getUserInfo(username);
});

ipcMain.handle('get-user-reels', async (_e, userId, cursor) => {
  return getUserReels(userId, cursor);
});

ipcMain.handle('get-trending-reels', (_e, cursor) => getTrendingReels(cursor));

ipcMain.handle('get-similar-reels', async (_e, userIds) => {
  if (!userIds || userIds.length === 0) return { items: [] };
  // Pick up to 2 random saved accounts to base recommendations on
  const sampleIds = userIds.sort(() => 0.5 - Math.random()).slice(0, 2);
  let allSimilarIds = [];
  
  for (const uid of sampleIds) {
    try {
      const d = await fetchIG(`https://www.instagram.com/api/v1/discover/chaining/?target_id=${uid}`, 'GET');
      const sim = (d.users || []).map(u => u.pk || u.pk_id).filter(Boolean);
      allSimilarIds.push(...sim);
    } catch (e) {
      console.warn('Discover chaining failed for', uid, e.message);
    }
  }
  
  allSimilarIds = [...new Set(allSimilarIds)].sort(() => 0.5 - Math.random()).slice(0, 3);
  let mixedReels = [];
  
  for (const simId of allSimilarIds) {
    try {
      const reelsData = await getUserReels(simId, '');
      mixedReels.push(...(reelsData.items || []));
    } catch (e) {
      console.warn('Failed to fetch reels for similar user', simId, e.message);
    }
  }
  
  return { items: mixedReels.sort(() => 0.5 - Math.random()) };
});

ipcMain.handle('proxy-avatar', async (_e, url) => {
  return proxyAvatar(url);
});

ipcMain.handle('download-reel', async (_e, videoUrl, filename) => {
  const saveDir = getSetting('downloadFolder', app.getPath('downloads'));
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  const dest = path.join(saveDir, filename);
  await downloadFile(videoUrl, dest, filename);
  return dest;
});

ipcMain.handle('select-folder', async () => {
  const currentFolder = getSetting('downloadFolder', app.getPath('downloads'));
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: currentFolder
  });
  if (!result.canceled && result.filePaths[0]) {
    setSetting('downloadFolder', result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('open-download-folder', async () => {
  const folder = getSetting('downloadFolder', app.getPath('downloads'));
  if (fs.existsSync(folder)) {
    shell.openPath(folder);
    return true;
  }
  return false;
});

ipcMain.handle('get-download-folder', () => getSetting('downloadFolder', app.getPath('downloads')));

ipcMain.handle('get-saved-accounts', () => getSetting('savedAccounts', []));

ipcMain.handle('save-account', (_e, account) => {
  const list = getSetting('savedAccounts', []);
  if (!list.find(a => a.username === account.username)) {
    list.push({ ...account, lastUpdated: Date.now() });
    setSetting('savedAccounts', list);
  }
  return list;
});

ipcMain.handle('remove-account', (_e, username) => {
  let list = getSetting('savedAccounts', []);
  list = list.filter(a => a.username !== username);
  setSetting('savedAccounts', list);
  if (monitorTimers[username]) { clearInterval(monitorTimers[username]); delete monitorTimers[username]; }
  return list;
});

ipcMain.handle('toggle-account-hidden', (_e, username) => {
  const list = getSetting('savedAccounts', []);
  const acc = list.find(a => a.username === username);
  if (acc) { acc.hidden = !acc.hidden; setSetting('savedAccounts', list); }
  return list;
});

// ─── App Lifecycle ────────────────────────────────────

// Compatibility aliases for the current SEEBAL UI. Instagram logic above stays identical to the working Desktop build.
ipcMain.handle('auth:status', () => checkLoggedIn());
ipcMain.handle('auth:login', () => openLoginWindow());
ipcMain.handle('feed:recommendations', (_e, cursor) => getTrendingReels(cursor));
ipcMain.handle('profile:user-info', (_e, username) => getUserInfo(username));
ipcMain.handle('profile:user-reels', (_e, userId, cursor) => getUserReels(userId, cursor));
ipcMain.handle('downloads:get-folder', () => getSetting('downloadFolder', app.getPath('downloads')));
ipcMain.handle('downloads:select-folder', async () => {
  const currentFolder = getSetting('downloadFolder', app.getPath('downloads'));
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], defaultPath: currentFolder });
  if (!result.canceled && result.filePaths[0]) setSetting('downloadFolder', result.filePaths[0]);
  return getSetting('downloadFolder', app.getPath('downloads'));
});
ipcMain.handle('downloads:reel', async (_e, reel) => {
  if (!reel?.videoUrl) throw new Error('This Reels has no video URL');
  const saveDir = getSetting('downloadFolder', app.getPath('downloads'));
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  const safeUser = String(reel.author?.username || 'instagram').replace(/[^w.-]+/g, '_');
  const safeId = String(reel.code || reel.id || Date.now()).replace(/[^w.-]+/g, '_');
  const dest = path.join(saveDir, safeUser + '_' + safeId + '.mp4');
  await downloadFile(reel.videoUrl, dest, safeId);
  return dest;
});
ipcMain.handle('debug:open-log', async () => {
  const logPath = path.join(app.getPath('userData'), 'logs', 'main.log');
  shell.openPath(logPath).catch(() => {});
  return true;
});

app.whenReady().then(() => {
  createMainWindow();
});

app.on('window-all-closed', () => { stopAllMonitoring(); app.quit(); });
app.on('activate', () => { if (!mainWindow) createMainWindow(); });
