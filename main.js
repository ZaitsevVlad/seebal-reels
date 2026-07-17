const { app, BrowserWindow, ipcMain, dialog, Notification, session, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// в”Ђв”Ђв”Ђ Constants в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const IG_APP_ID = '936619743392459';
const UA = process.platform === 'darwin'
  ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STORE_FILE = path.join(app.getPath('userData'), 'app-store.json');
const BUNDLED_VIDIQ_EXTENSION_PATH = path.join(__dirname, 'src', 'vendor', 'vidiq-extension');
const VIDIQ_EXTENSION_PATH = BUNDLED_VIDIQ_EXTENSION_PATH;
const EXTENSION_LOG_FILE = path.join(__dirname, 'seebal-extension.log');

let mainWindow = null;
let monitorTimers = {};
let instagramAgentWindow = null;
let instagramAgentCloseTimer = null;
const igCooldowns = new Map();

const IG_RATE_LIMIT_MS = 2 * 60 * 1000;
const USER_CACHE_MS = 15 * 60 * 1000;
const userInfoCache = new Map();
const reelMetricsCache = new Map();
const avatarCache = new Map();

// в”Ђв”Ђв”Ђ Simple JSON Store в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
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

function normalizeInstagramUsername(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  text = text
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^(www\.)?instagram\.com\//i, '')
    .replace(/^\/+|\/+$/g, '');
  text = text.split(/[/?#]/)[0].replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9._]+$/.test(text) ? text : '';
}

// в”Ђв”Ђв”Ђ Instagram Cookie Helpers в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
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

// в”Ђв”Ђв”Ђ Instagram Login Window в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function openLoginWindow() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480, height: 780,
      parent: mainWindow, modal: true,
      title: 'Р’С…РѕРґ РІ Instagram',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // Allow the login page to load all scripts (needed for CAPTCHA)
        webSecurity: true
      }
    });
    win.setMenuBarVisibility(false);
    // Use the same desktop Chrome UA as API requests вЂ” session is tied to UA
    win.webContents.setUserAgent(UA);
    win.loadURL('https://www.instagram.com/accounts/login/');

    let closed = false;
    let pollTimer = null;

    // Robust cookie polling вЂ“ works regardless of what URL Instagram redirects to
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
        // Navigation landed somewhere that isn't a login page вЂ” likely home
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

// в”Ђв”Ђв”Ђ Instagram API Fetch в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function waitForLoad(win, timeout = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    win.webContents.once('did-finish-load', finish);
    win.webContents.once('did-stop-loading', finish);
    win.webContents.once('did-fail-load', finish);
  });
}

async function getInstagramAgentWindow(url) {
  if (instagramAgentCloseTimer) {
    clearTimeout(instagramAgentCloseTimer);
    instagramAgentCloseTimer = null;
  }
  if (!instagramAgentWindow || instagramAgentWindow.isDestroyed()) {
    instagramAgentWindow = new BrowserWindow({
      width: 420,
      height: 760,
      show: false,
      skipTaskbar: true,
      title: 'Instagram Agent',
      webPreferences: {
        preload: path.join(__dirname, 'src', 'instagram-agent-preload.js'),
        nodeIntegration: false,
        contextIsolation: false,
        sandbox: false
      }
    });
    instagramAgentWindow.setMenuBarVisibility(false);
  }

  const current = instagramAgentWindow.webContents.getURL();
  if (!current || !current.startsWith(url.split('?')[0])) {
    await instagramAgentWindow.loadURL(url);
    await waitForLoad(instagramAgentWindow);
    await sleep(1800);
  }

  return instagramAgentWindow;
}

function closeInstagramAgentWindow() {
  if (instagramAgentCloseTimer) {
    clearTimeout(instagramAgentCloseTimer);
    instagramAgentCloseTimer = null;
  }
  if (instagramAgentWindow && !instagramAgentWindow.isDestroyed()) {
    instagramAgentWindow.destroy();
  }
  instagramAgentWindow = null;
}

function scheduleInstagramAgentClose() {
  if (instagramAgentCloseTimer) clearTimeout(instagramAgentCloseTimer);
  instagramAgentCloseTimer = setTimeout(closeInstagramAgentWindow, 60 * 1000);
}

async function collectInstagramPageReels(url, scrolls = 3) {
  if (!(await checkLoggedIn())) throw new Error('Instagram С‚СЂРµР±СѓРµС‚ Р°РІС‚РѕСЂРёР·Р°С†РёСЋ. РќР°Р¶РјРёС‚Рµ В«Р’РѕР№С‚Рё РІ InstagramВ».');
  const win = await getInstagramAgentWindow(url);
  const pageUrl = win.webContents.getURL();
  if (pageUrl.includes('/accounts/login')) throw new Error('Instagram С‚СЂРµР±СѓРµС‚ Р°РІС‚РѕСЂРёР·Р°С†РёСЋ. РќР°Р¶РјРёС‚Рµ В«Р’РѕР№С‚Рё РІ InstagramВ».');

  const collected = new Map();
  for (let i = 0; i < scrolls; i++) {
    const items = await win.webContents.executeJavaScript(
      'window.__SEEBAL_IG_AGENT__ ? window.__SEEBAL_IG_AGENT__.collectReels() : []',
      true
    ).catch(() => []);
    for (const item of items || []) {
      if (!item?.id) continue;
      collected.set(String(item.id), item);
    }
    await win.webContents.executeJavaScript(
      'window.__SEEBAL_IG_AGENT__ && window.__SEEBAL_IG_AGENT__.scrollMore()',
      true
    ).catch(() => null);
    await sleep(900);
  }

  const items = [...collected.values()].filter(item => item.thumbnailUrl || item.videoUrl);
  scheduleInstagramAgentClose();
  return { items, hasMore: true, cursor: `dom:${Date.now()}` };
}

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
    throw igError(`Instagram РІСЂРµРјРµРЅРЅРѕ РѕРіСЂР°РЅРёС‡РёР» Р·Р°РїСЂРѕСЃС‹. РџРѕРґРѕР¶РґРёС‚Рµ ${seconds} СЃРµРє.`, 'IG_COOLDOWN', 429);
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
      if (mainWindow) mainWindow.webContents.send('loading-status', `РџРѕРІС‚РѕСЂ ${attempt}/${retries}...`);
      await sleep(delay);
    }

    let response, text;
    try {
      response = await net.fetch(url, fetchOpts);
      text = await response.text();
    } catch (netErr) {
      console.error(`[IG API] Network error on ${url}:`, netErr.message);
      if (attempt < retries) continue;
      throw new Error('РћС€РёР±РєР° СЃРµС‚Рё. РџСЂРѕРІРµСЂСЊС‚Рµ РїРѕРґРєР»СЋС‡РµРЅРёРµ Рє РёРЅС‚РµСЂРЅРµС‚Сѓ.');
    }

    console.log(`[IG API] ${method} ${url.split('?')[0]} в†’ ${response.status} (${text.length}b)`);
    if (text.length < 1000) {
      console.log(`[IG API] Body: ${text}`);
    } else {
      console.log(`[IG API] Body preview: ${text.substring(0, 300)}...`);
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '', 10);
      igCooldowns.set(cooldownKey, Date.now() + (Number.isFinite(retryAfter) ? retryAfter * 1000 : IG_RATE_LIMIT_MS));
      throw igError('Instagram РѕРіСЂР°РЅРёС‡РёР» Р·Р°РїСЂРѕСЃС‹. РџРѕРґРѕР¶РґРёС‚Рµ 2 РјРёРЅСѓС‚С‹.', 'IG_RATE_LIMITED', 429);
    }

    if (response.status === 401 || response.status === 403) {
      console.error(`[IG API] Auth error ${response.status}`);
      throw igError('РЎРµСЃСЃРёСЏ РёСЃС‚РµРєР»Р°. РќР°Р¶РјРёС‚Рµ В«Р’РѕР№С‚Рё РІ InstagramВ» Рё Р°РІС‚РѕСЂРёР·СѓР№С‚РµСЃСЊ Р·Р°РЅРѕРІРѕ.', 'IG_AUTH', response.status);
    }

    if (!response.ok) {
      console.error(`[IG API] HTTP ${response.status}`);
      throw igError(`РћС€РёР±РєР° Instagram (${response.status}). РџРѕРїСЂРѕР±СѓР№С‚Рµ РїРѕР·Р¶Рµ.`, 'IG_HTTP', response.status);
    }

    // Parse JSON response
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error(`[IG API] Non-JSON response:`, text.substring(0, 300));
      if (text.includes('login') || text.includes('LoginAndSignupPage')) {
        throw new Error('Instagram С‚СЂРµР±СѓРµС‚ Р°РІС‚РѕСЂРёР·Р°С†РёСЋ. РќР°Р¶РјРёС‚Рµ В«Р’РѕР№С‚Рё РІ InstagramВ».');
      }
      if (attempt < retries) continue;
      throw new Error('Instagram РІРµСЂРЅСѓР» РЅРµРѕР¶РёРґР°РЅРЅС‹Р№ РѕС‚РІРµС‚. РџРѕРїСЂРѕР±СѓР№С‚Рµ РїРѕР·Р¶Рµ.');
    }

    if (data?.status === 'fail' || data?.message === 'login_required') {
      console.error('[IG API] login_required/fail:', JSON.stringify(data).substring(0, 300));
      throw new Error('Instagram С‚СЂРµР±СѓРµС‚ Р°РІС‚РѕСЂРёР·Р°С†РёСЋ. РќР°Р¶РјРёС‚Рµ В«Р’РѕР№С‚Рё РІ InstagramВ».');
    }

    return data;
  }
}

// в”Ђв”Ђв”Ђ Instagram: Get User Info в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
async function getUserInfo(username) {
  const normalized = normalizeInstagramUsername(username);
  if (!normalized) throw new Error('Instagram user not found');
  const cached = userInfoCache.get(normalized);
  if (cached && Date.now() - cached.ts < USER_CACHE_MS) return cached.user;

  let user = null;
  try {
    const d = await fetchIG(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(normalized)}`);
    user = d?.data?.user;
  } catch (e) {
    if (e.code === 'IG_AUTH') throw e;
    console.warn(`[IG API] web_profile_info failed for ${normalized}; trying topsearch fallback:`, e.message);
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
  if (!user?.id) throw new Error('Instagram user not found');
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
  if (info.username) userInfoCache.set(String(info.username).toLowerCase(), { ts: Date.now(), user: info });

  // Auto-update saved account data when we successfully fetch user info
  const savedAccounts = getSetting('savedAccounts', []);
  const savedIdx = savedAccounts.findIndex(a => String(a.username || '').toLowerCase() === String(info.username || '').toLowerCase());
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

// в”Ђв”Ђв”Ђ Instagram: Get Reels в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
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

async function getUserReels(target, cursor = '') {
  let userId = target;
  let username = '';
  if (target && typeof target === 'object') {
    userId = target.userId || target.id || '';
    username = normalizeInstagramUsername(target.username || '');
  }
  if (!userId && username) {
    const info = await getUserInfo(username);
    userId = info.id;
    username = info.username || username;
  }
  if (!userId) throw new Error('Profile user id is missing');

  function resolveUsernameByUserId() {
    if (username) return username;
    for (const cached of userInfoCache.values()) {
      if (String(cached?.user?.id) === String(userId)) return cached.user.username;
    }
    const saved = getSetting('savedAccounts', []).find(account =>
      String(account.userId || account.id) === String(userId)
    );
    return saved?.username || '';
  }

  // Strategy 1: clips/user POST вЂ“ returns only Reels (most accurate)
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

  // Strategy 2: feed/user GET вЂ“ returns all media, we filter for videos/reels
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
    const username = resolveUsernameByUserId();
    if (username) {
      try {
        const domResult = await collectInstagramPageReels(`https://www.instagram.com/${encodeURIComponent(username)}/reels/`, cursor ? 2 : 4);
        if (domResult.items.length > 0) return domResult;
      } catch (domErr) {
        console.warn('[getUserReels] page agent failed:', domErr.message);
      }
    }
    if (clipsResult) return clipsResult; // return empty clips result rather than throwing
    throw clipsError || feedErr;
  }
}

// в”Ђв”Ђв”Ђ Instagram: Get Discover/Explore Reels в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
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
    first: 40,
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
  try {
    const graphData = await fetchIG('https://www.instagram.com/graphql/query', 'POST', body.toString());
    const graphResult = findReelsConnection(graphData);

    if (graphResult && graphResult.media.length > 0) {
      const graphPageInfo = graphResult.connection.page_info || {};
      const graphItems = graphResult.media.map(parseReelItem);
      return {
        items: graphItems,
        hasMore: !!graphPageInfo.has_next_page,
        cursor: graphPageInfo.end_cursor || ''
      };
    }
  } catch (error) {
    console.warn('[Trending] GraphQL failed, trying fallback endpoints:', error.message);
  }

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
        if (cursor) url += `${url.includes('?') ? '&' : '?'}max_id=${encodeURIComponent(cursor)}`;
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

  try {
    const domResult = await collectInstagramPageReels('https://www.instagram.com/reels/', cursor ? 1 : 2);
    if (domResult.items.length > 0) return domResult;
  } catch (error) {
    lastError = lastError || error;
    console.warn('[Trending] Instagram page agent fallback failed:', error.message);
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

  throw lastError || new Error('РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ Р»РµРЅС‚Сѓ. РџРѕРїСЂРѕР±СѓР№С‚Рµ РїРѕР·Р¶Рµ.');
}

// в”Ђв”Ђв”Ђ Proxy Avatar в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
async function proxyAvatar(avatarUrl) {
  if (!avatarUrl) return '';
  const cached = avatarCache.get(avatarUrl);
  if (cached && Date.now() - cached.ts < USER_CACHE_MS) return cached.value;
  try {
    const cookie = await getIGCookies();
    const response = await net.fetch(avatarUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Cookie': cookie,
        'Referer': 'https://www.instagram.com/',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site'
      },
      credentials: 'include'
    });
    if (!response.ok) {
      avatarCache.set(avatarUrl, { ts: Date.now(), value: '' });
      return '';
    }
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const base64 = Buffer.from(buffer).toString('base64');
    const value = `data:${contentType};base64,${base64}`;
    avatarCache.set(avatarUrl, { ts: Date.now(), value });
    if (avatarCache.size > 200) avatarCache.delete(avatarCache.keys().next().value);
    return value;
  } catch (e) {
    console.error('[Proxy Avatar] Failed:', e.message);
    return '';
  }
}

// в”Ђв”Ђв”Ђ Download Video File в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function pushUniqueUrl(list, url) {
  if (url && typeof url === 'string' && /^https?:\/\//i.test(url) && !list.includes(url)) {
    list.push(url);
  }
}

async function getAvatarCandidates(account) {
  const candidates = [];
  pushUniqueUrl(candidates, account.avatar);

  let info = null;
  if (account.username) {
    try {
      info = await getUserInfo(account.username);
      pushUniqueUrl(candidates, info.avatar);
    } catch (error) {
      console.warn(`[Profiles] web_profile_info avatar lookup failed for @${account.username}:`, error.message);
    }
  }

  const userId = account.userId || account.id || info?.id;
  if (userId) {
    try {
      const data = await fetchIG(`https://i.instagram.com/api/v1/users/${encodeURIComponent(userId)}/info/`, 'GET', null, 0, { ignoreCooldown: true });
      const user = data?.user || {};
      pushUniqueUrl(candidates, user.hd_profile_pic_url_info?.url);
      pushUniqueUrl(candidates, user.profile_pic_url);
    } catch (error) {
      console.warn(`[Profiles] users/info avatar lookup failed for @${account.username || userId}:`, error.message);
    }
  }

  if (account.username) {
    try {
      const data = await fetchIG(`https://www.instagram.com/web/search/topsearch/?query=${encodeURIComponent(account.username)}`, 'GET', null, 0, { ignoreCooldown: true });
      const found = (data?.users || [])
        .map(item => item.user || item)
        .find(item => item?.username?.toLowerCase() === String(account.username).toLowerCase());
      pushUniqueUrl(candidates, found?.profile_pic_url);
    } catch (error) {
      console.warn(`[Profiles] topsearch avatar lookup failed for @${account.username}:`, error.message);
    }
  }

  return candidates;
}

async function getSavedAccountsForUi() {
  const accounts = getSetting('savedAccounts', []);
  const output = new Array(accounts.length);
  let index = 0;

  async function buildAccount(account) {
    let avatar = account.avatar || '';
    let proxied = /^data:/i.test(avatar) ? avatar : '';
    if (!proxied && /^https?:\/\//i.test(avatar)) {
      proxied = await proxyAvatar(avatar);
    }
    if (!proxied && account.username) {
      try {
        const candidates = await getAvatarCandidates(account);
        for (const candidate of candidates) {
          proxied = await proxyAvatar(candidate);
          if (proxied) break;
        }
        const info = userInfoCache.get(String(account.username).toLowerCase())?.user;
        return {
          ...account,
          fullName: info?.fullName || account.fullName || '',
          userId: info?.id || account.userId,
          followers: info?.followers ?? account.followers,
          following: info?.following ?? account.following,
          posts: info?.posts ?? account.posts,
          avatar: proxied || ''
        };
      } catch (error) {
        console.warn(`[Profiles] Avatar refresh failed for @${account.username}:`, error.message);
      }
    }
    return { ...account, avatar: proxied || '' };
  }

  async function worker() {
    while (index < accounts.length) {
      const current = index++;
      output[current] = await buildAccount(accounts[current]);
    }
  }

  const workers = Array.from({ length: Math.min(4, accounts.length) }, worker);
  await Promise.all(workers);
  return output;
}

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

// в”Ђв”Ђв”Ђ Monitoring в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
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
              title: 'РќРѕРІС‹Р№ Reels!',
              body: `@${acc.username} РѕРїСѓР±Р»РёРєРѕРІР°Р» РЅРѕРІС‹Р№ Reels`,
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

// в”Ђв”Ђв”Ђ Create Main Window в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
async function injectInstagramAnalyzer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  const base = path.join(__dirname, 'src', 'local-instagram-reels-analyzer');
  const css = fs.readFileSync(path.join(base, 'content.css'), 'utf8');
  const content = fs.readFileSync(path.join(base, 'content.js'), 'utf8');
  await wc.insertCSS(css + `
    html.seebal-analyzer-mode body > *:not(#local-reels-analyzer-root):not(#local-reels-analyzer-button){visibility:hidden!important;pointer-events:none!important}
    html.seebal-analyzer-mode #local-reels-analyzer-root,
    html.seebal-analyzer-mode #local-reels-analyzer-root *,
    html.seebal-analyzer-mode #local-reels-analyzer-button{visibility:visible!important;pointer-events:auto!important}
    html.seebal-analyzer-mode #local-reels-analyzer-button{display:none!important}
    html.seebal-analyzer-mode body{background:#050505!important;overflow:hidden!important}
    .seebal-download-btn{border:1px solid rgba(255,255,255,.22);background:#fff;color:#050505;border-radius:10px;padding:10px 12px;font-weight:800;cursor:pointer}
    .seebal-folder-btn{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;border-radius:10px;padding:10px 12px;font-weight:700;cursor:pointer}
  `);
  const boot = `
    (() => {
      window.chrome = window.chrome || {};
      chrome.storage = chrome.storage || {};
      chrome.storage.local = chrome.storage.local || {
        async get(key) {
          const out = {};
          if (typeof key === 'string') out[key] = JSON.parse(localStorage.getItem(key) || 'null');
          return out;
        },
        async set(obj) {
          for (const [key, value] of Object.entries(obj || {})) localStorage.setItem(key, JSON.stringify(value));
        }
      };
      ${content}
      function analyzerMode() {
        if (location.pathname.includes('/accounts/login')) {
          document.documentElement.classList.remove('seebal-analyzer-mode');
          return;
        }
        document.documentElement.classList.add('seebal-analyzer-mode');
        if (!document.querySelector('.lra-overlay')) document.getElementById('local-reels-analyzer-button')?.click();
      }
      function addDownloadControls() {
        const actions = document.querySelector('.lra-modal-actions');
        if (!actions || actions.querySelector('.seebal-download-btn')) return;
        const video = document.querySelector('.lra-modal video');
        const title = document.querySelector('.lra-modal-info h2')?.textContent || 'instagram';
        const link = document.querySelector('.lra-modal-actions a[href*="/reel/"]')?.href || '';
        const code = (link.match(/\\/reel\\/([^/?#]+)/) || [])[1] || '';
        if (!video?.src) return;
        const download = document.createElement('button');
        download.className = 'seebal-download-btn';
        download.textContent = 'Download video';
        download.onclick = () => window.postMessage({ type: 'SEEBAL_DOWNLOAD_VIDEO', url: video.src, code, username: title.replace(/^@/, '') }, '*');
        const folder = document.createElement('button');
        folder.className = 'seebal-folder-btn';
        folder.textContent = 'Choose folder';
        folder.onclick = () => window.postMessage({ type: 'SEEBAL_SELECT_FOLDER' }, '*');
        actions.append(download, folder);
      }
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'SEEBAL_DOWNLOAD_DONE') alert('Downloaded: ' + event.data.file);
        if (event.data?.type === 'SEEBAL_ERROR') alert(event.data.message);
      });
      new MutationObserver(analyzerMode).observe(document.documentElement, { childList: true, subtree: true });
      new MutationObserver(addDownloadControls).observe(document.documentElement, { childList: true, subtree: true });
      setInterval(analyzerMode, 700);
      setInterval(addDownloadControls, 1000);
      analyzerMode();
    })();
  `;
  await wc.executeJavaScript(boot, true);
}

// в”Ђв”Ђв”Ђ Shell CSS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const SHELL_CSS = `
  html.sb-html-on, html.sb-html-on body{width:100vw!important;height:100vh!important;max-width:100vw!important;overflow:hidden!important;margin:0!important}
  #seebal-shell{position:fixed;left:0;top:0;width:100vw;height:100vh;max-width:100vw;max-height:100vh;z-index:2147483600;background:#070707;color:#f0f0f0;font-family:Inter,system-ui,sans-serif;display:flex;flex-direction:column;overflow:hidden}
  #seebal-shell *{box-sizing:border-box}
  #seebal-topbar{height:58px;min-height:58px;display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid #1e1e1e;background:#050505;flex-shrink:0}
  #seebal-brand{font-weight:900;font-size:17px;letter-spacing:.06em;color:#fff;margin-right:4px}
  #seebal-brand span{color:#5b9bff}
  .sb-btn{border:1px solid #2a2a2a;background:#131313;color:#e0e0e0;border-radius:8px;padding:7px 13px;font-size:13px;font-weight:700;cursor:pointer;transition:background .12s,border-color .12s}
  .sb-btn:hover{background:#202020;border-color:#444}
  .sb-btn.primary{background:#2878ff;border-color:#2878ff;color:#fff}
  .sb-btn.primary:hover{background:#1a6aee}
  .sb-field{height:36px;border:1px solid #262626;background:#111;color:#ddd;border-radius:9px;padding:0 12px;font-size:13px;outline:none}
  .sb-search{min-width:260px}
  .sb-segments{display:flex;border:1px solid #262626;border-radius:9px;overflow:hidden;background:#101010}
  .sb-segments button{height:34px;min-width:42px;border:0;border-right:1px solid #262626;background:transparent;color:#888;font-weight:800;cursor:pointer}
  .sb-segments button:last-child{border-right:0}.sb-segments button.active{background:#2878ff;color:#fff}
  #seebal-count{margin-left:auto;color:#888;font-size:12px;white-space:nowrap}
  #seebal-body{flex:1;display:flex;min-height:0;width:100%;max-width:100%;overflow:hidden}
  #seebal-rail{width:64px;flex-shrink:0;background:#0b0b0b;border-right:1px solid #1a1a1a;display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px 8px}
  .sb-rail-btn{width:42px;height:42px;border:1px solid #242424;border-radius:12px;background:#151515;color:#aaa;font-size:17px;cursor:pointer;display:grid;place-items:center;line-height:1}
  .sb-rail-btn:hover,.sb-rail-btn.active{background:#202020;color:#fff;border-color:#3a3a3a}
  #seebal-sidebar{width:0;overflow:hidden;border-right:1px solid #1a1a1a;background:#080808;transition:width .2s;flex-shrink:0;display:flex;flex-direction:column}
  #seebal-sidebar.open{width:280px}
  #seebal-sidebar-inner{width:280px;padding:14px;overflow-y:auto;flex:1}
  #seebal-sidebar h3{margin:0 0 10px;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:.08em}
  .sb-profile-item{display:grid;grid-template-columns:36px 1fr auto;gap:8px;align-items:center;padding:9px 10px;border:1px solid #1d1d1d;border-radius:8px;margin-bottom:7px;background:#0f0f0f;cursor:pointer;transition:border-color .12s,background .12s}
  .sb-profile-item:hover{border-color:#333;background:#151515}
  .sb-profile-item img{width:36px;height:36px;border-radius:50%;object-fit:cover;background:#1a1a1a}
  .sb-profile-avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:#1a1a1a;color:#777;font-size:13px;font-weight:900;overflow:hidden;text-transform:uppercase}
  .sb-profile-avatar img{width:100%;height:100%;display:block}
  .sb-profile-item strong{display:block;font-size:13px;color:#e8e8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sb-profile-item small{display:block;font-size:11px;color:#666;margin-top:1px}
  .sb-profile-del{border:0;background:transparent;color:#555;font-size:16px;cursor:pointer;padding:2px 6px;border-radius:4px}
  .sb-profile-del:hover{color:#ff6b6b}
  .sb-add-form{display:flex;gap:6px;margin-bottom:12px}
  .sb-add-form input{flex:1;background:#111;border:1px solid #2a2a2a;border-radius:7px;padding:8px 10px;color:#e0e0e0;font-size:13px}
  .sb-add-form input::placeholder{color:#444}
  #seebal-grid-wrap{flex:1;min-width:0;width:100%;max-width:100%;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none}
  #seebal-grid-wrap::-webkit-scrollbar{width:0;height:0;display:none}
  #seebal-grid{width:100%;max-width:100%;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px;padding:18px;align-content:start;overflow:hidden}
  .sb-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;overflow:hidden;position:relative;cursor:pointer;transition:transform .13s,border-color .13s}
  .sb-card:hover{transform:translateY(-2px);border-color:#3a3a3a}
  .sb-card video,.sb-card img{width:100%;aspect-ratio:9/16;object-fit:cover;display:block;background:#0a0a0a}
  .sb-card.playing .sb-play{display:none}
  .sb-card-meta{padding:10px 12px;font-size:12px}
  .sb-card-user{color:#e0e0e0;font-weight:800;display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
  .sb-caption{color:#cfcfcf;line-height:1.25;height:32px;overflow:hidden;margin:5px 0}
  .sb-card-stats{color:#aaa;display:grid;grid-template-columns:1fr 1fr;gap:5px 10px;font-weight:700}
  .sb-card-tools{position:absolute;left:50%;bottom:124px;transform:translateX(-50%);display:flex;justify-content:center;gap:8px;opacity:0;transition:.13s;padding:6px;pointer-events:none;z-index:4}
  .sb-card:hover .sb-card-tools{opacity:1}
  .sb-card:hover .sb-card-tools{pointer-events:auto}
  .sb-tool{width:38px;height:38px;border:0;background:rgba(255,255,255,.92);color:#111;border-radius:999px;font-size:17px;font-weight:900;cursor:pointer;display:grid;place-items:center;box-shadow:0 8px 24px rgba(0,0,0,.35)}
  .sb-hide{position:absolute;right:9px;top:9px;width:30px;height:30px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.55);color:#fff;border-radius:999px;opacity:0;cursor:pointer;font-weight:900}
  .sb-card:hover .sb-hide{opacity:1}
  .sb-viral{position:absolute;right:9px;top:9px;background:#d21462;color:#fff;border-radius:7px;padding:6px 8px;font-size:12px;font-weight:900}
  .sb-card:hover .sb-viral{right:45px}
  .sb-play{position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);width:50px;height:50px;border-radius:50%;border:0;background:rgba(255,255,255,.85);color:#111;font-size:20px;opacity:0;transition:.13s;cursor:pointer}
  .sb-card:hover .sb-play{opacity:1}
  .sb-duration{position:absolute;right:9px;bottom:124px;background:rgba(0,0,0,.72);border-radius:7px;padding:4px 6px;font-weight:900;font-size:12px;z-index:3}
  .sb-add-btn{border:0;background:#1e1e1e;color:#bbb;border-radius:50%;width:22px;height:22px;font-size:14px;cursor:pointer;line-height:1;flex-shrink:0}
  .sb-profile-link{border:0;background:transparent;color:#e0e0e0;font:inherit;font-weight:800;padding:0;cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sb-profile-link:hover{color:#8bb6ff}
  #seebal-status{padding:40px;text-align:center;color:#555;font-size:14px;grid-column:1/-1}
  body.sb-on > *:not(#seebal-shell){visibility:hidden!important;pointer-events:none!important}
`;

// в”Ђв”Ђв”Ђ Shell JS (injected into instagram page) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function buildShellJS() {
  return `(() => {
    if (window.__SEEBAL_SHELL__) return;
    window.__SEEBAL_SHELL__ = true;
    document.documentElement.classList.add('sb-html-on');
    document.body.classList.add('sb-on');
    window.scrollTo(0, 0);
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;

    const shell = document.createElement('div');
    shell.id = 'seebal-shell';
    shell.innerHTML = \`
      <div id="seebal-topbar">
        <div id="seebal-brand">SEEBAL<span>REELS</span></div>
        <button class="sb-btn primary" data-act="feed">Feed</button>
        <button class="sb-btn" data-act="refresh">Refresh</button>
        <select class="sb-field" id="sb-sort">
          <option value="feed">Sort: Feed</option>
          <option value="views">Sort: Views</option>
          <option value="likes">Sort: Likes</option>
          <option value="comments">Sort: Comments</option>
          <option value="newest">Sort: Newest</option>
          <option value="viral">Sort: Viral</option>
        </select>
        <input class="sb-field sb-search" id="sb-search" placeholder="Search caption or username">
        <div class="sb-segments" id="sb-limit">
          <button data-limit="10">10</button><button data-limit="20" class="active">20</button><button data-limit="30">30</button><button data-limit="40">40</button>
        </div>
        <button class="sb-btn" data-act="load-more">Load more</button>
        <button class="sb-btn" data-act="folder">Folder</button>
        <button class="sb-btn" data-act="auth" id="sb-auth">Instagram</button>
        <div id="seebal-count">-</div>
      </div>
      <div id="seebal-body">
        <div id="seebal-rail">
          <button class="sb-rail-btn active" data-act="feed" title="Feed">⌂</button>
          <button class="sb-rail-btn" data-act="profiles" title="Profiles">♡</button>
          <button class="sb-rail-btn" data-sort-short="views" title="Views">↗</button>
          <button class="sb-rail-btn" data-sort-short="viral" title="Viral">✦</button>
          <button class="sb-rail-btn" data-act="refresh" title="Refresh">↻</button>
        </div>
        <div id="seebal-sidebar">
          <div id="seebal-sidebar-inner">
            <h3>Profiles</h3>
            <div class="sb-add-form">
              <input id="sb-add-input" placeholder="@username or link" />
              <button class="sb-btn" data-act="add-profile">+</button>
            </div>
            <div id="sb-profile-list"></div>
          </div>
        </div>
        <div id="seebal-grid-wrap">
          <div id="seebal-grid"><div id="seebal-status">Loading...</div><div id="seebal-sentinel"></div></div>
        </div>
      </div>
    \`;
    document.documentElement.appendChild(shell);

    const grid = document.getElementById('seebal-grid');
    const count = document.getElementById('seebal-count');
    const sidebar = document.getElementById('seebal-sidebar');
    const profileList = document.getElementById('sb-profile-list');
    const addInput = document.getElementById('sb-add-input');
    const gridWrap = document.getElementById('seebal-grid-wrap');
    const searchInput = document.getElementById('sb-search');
    const sortSelect = document.getElementById('sb-sort');
    const limitBox = document.getElementById('sb-limit');
    const authBtn = document.getElementById('sb-auth');

    const st = {
      items: [], cursor: '', loading: false,
      loadSeq: 0,
      profiles: [],
      hidden: new Set(JSON.parse(localStorage.getItem('sb_hidden') || '[]')),
      hiddenAuthors: new Set(JSON.parse(localStorage.getItem('sb_hidden_authors') || '[]')),
      activeProfile: null,  // { userId, username } or null
      search: '',
      sort: 'feed',
      limit: 20,
      visibleLimit: 20,
      loggedIn: false
    };

    function esc(v){ return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function fmt(n){ n=Number(n||0); return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1000?Math.round(n/1000)+'K':n?String(n):''; }
    function age(ts){
      ts=Number(ts||0); if(!ts) return '';
      const d=Math.max(1, Math.floor((Date.now()/1000-ts)/86400));
      if(d<2) return 'a day ago';
      if(d<31) return d+' days ago';
      const m=Math.floor(d/30); return m+' mo ago';
    }
    function dur(sec){
      sec=Math.round(Number(sec||0)); if(!sec) return '';
      return Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0');
    }
    function viral(it){
      const views=Number(it.viewCount||0), likes=Number(it.likeCount||0), followers=Number(it.followerCount||it.author?.followerCount||0);
      const base = followers || Math.max(likes*18, 1000);
      return base ? views/base : 0;
    }
    function metric(it,key){
      if(key==='views') return Number(it.viewCount||0);
      if(key==='likes') return Number(it.likeCount||0);
      if(key==='comments') return Number(it.commentCount||0);
      if(key==='newest') return Number(it.takenAt||0);
      if(key==='viral') return viral(it);
      return 0;
    }
    function itemAuthor(it) {
      return String(it.author?.username || '').toLowerCase();
    }
    function isHiddenItem(it) {
      if (st.hidden.has(it.code)) return true;
      return !st.activeProfile && st.hiddenAuthors.has(itemAuthor(it));
    }
    function filteredItemsRaw(){
      const q=st.search.trim().toLowerCase();
      let arr=st.items.filter(it => !isHiddenItem(it));
      if(q) arr=arr.filter(it => ((it.caption||'')+' '+(it.author?.username||'')).toLowerCase().includes(q));
      if(st.sort !== 'feed') arr=[...arr].sort((a,b)=>metric(b,st.sort)-metric(a,st.sort));
      return arr;
    }
    function filteredItems(){
      return filteredItemsRaw().slice(0, st.visibleLimit);
    }

    function cacheKey() {
      return st.activeProfile?.username ? 'sb_cache_profile_' + st.activeProfile.username : 'sb_cache_feed';
    }
    function saveCache() {
      try { localStorage.setItem(cacheKey(), JSON.stringify({ items: st.items, cursor: st.cursor, ts: Date.now() })); } catch {}
    }
    function restoreCache() {
      if (!st.loggedIn) return;
      try {
        const data = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
        if (data?.items?.length) {
          st.items = data.items;
          st.cursor = data.cursor || '';
          render();
        }
      } catch {}
    }
    async function refreshAuth() {
      try {
        st.loggedIn = !!(await request('SEEBAL_AUTH_STATUS'));
        authBtn.textContent = st.loggedIn ? 'Sign out IG' : 'Login IG';
        authBtn.classList.toggle('primary', st.loggedIn);
      } catch {}
    }
    async function requireAuth() {
      await refreshAuth();
      if (st.loggedIn) return true;
      st.items = [];
      st.cursor = '';
      grid.innerHTML = '<div id="seebal-status"><div style="font-size:18px;font-weight:900;margin-bottom:10px">Instagram login required</div><div style="color:#888;margin-bottom:16px">Sign in to Instagram before loading reels.</div><button class="sb-btn primary" data-act="auth">Login IG</button></div><div id="seebal-sentinel"></div>';
      count.textContent = 'Login required';
      return false;
    }

    function request(type, payload) {
      return new Promise((res, rej) => {
        const id = type+'-'+Date.now()+'-'+Math.random().toString(36).slice(2);
        const responseType = type + '_RESPONSE';
        const timer = setTimeout(() => { window.removeEventListener('message',h); rej(new Error(type+' timeout')); }, 45000);
        function h(e) {
          const d = e.data||{};
          // Must match BOTH requestId AND response type to avoid catching own outgoing message
          if (d.requestId !== id || d.type !== responseType) return;
          clearTimeout(timer); window.removeEventListener('message',h);
          d.error ? rej(new Error(d.error)) : res(d.result);
        }
        window.addEventListener('message', h);
        window.postMessage({ type, requestId: id, ...(payload||{}) }, '*');
      });
    }

    function cookie(name) {
      return (document.cookie.split('; ').find(x => x.startsWith(name + '=')) || '').split('=').slice(1).join('=');
    }
    function best(list) {
      return Array.isArray(list) ? [...list].sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0))[0] : null;
    }
    function parseIgMedia(raw) {
      const media = raw?.media || raw?.media_or_ad || raw?.item || raw?.clips_media || raw;
      if (!media || !media.code) return null;
      const video = best(media.video_versions);
      const thumb = best(media.image_versions2?.candidates);
      const user = media.user || media.owner || {};
      return {
        id: media.pk || media.id || '',
        code: media.code,
        videoUrl: video?.url || '',
        thumbnailUrl: thumb?.url || '',
        duration: media.video_duration || 0,
        viewCount: media.ig_play_count || media.play_count || media.fb_play_count || media.view_count || media.video_view_count || 0,
        likeCount: media.like_count || 0,
        commentCount: media.comment_count || 0,
        shareCount: media.reshare_count || media.share_count || 0,
        saveCount: media.save_count || 0,
        caption: media.caption?.text || '',
        takenAt: media.taken_at || 0,
        author: {
          id: user.pk || user.pk_id || user.id || '',
          username: user.username || '',
          fullName: user.full_name || '',
          avatar: user.profile_pic_url || '',
          followerCount: user.follower_count || 0
        }
      };
    }
    function findConnection(root) {
      const seen = new WeakSet();
      let bestFound = null;
      function visit(v, depth) {
        if (!v || typeof v !== 'object' || depth > 12 || seen.has(v)) return;
        seen.add(v);
        if (Array.isArray(v.edges)) {
          const items = v.edges.map(e => parseIgMedia(e?.node)).filter(x => x && x.code && x.videoUrl);
          if (items.length && (!bestFound || items.length > bestFound.items.length)) bestFound = { connection: v, items };
        }
        Object.values(v).forEach(child => visit(child, depth + 1));
      }
      visit(root, 0);
      return bestFound;
    }
    async function fastFeed(cursor) {
      const body = new URLSearchParams({
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: 'PolarisClipsTabDesktopPaginationQuery',
        variables: JSON.stringify({
          after: cursor || null,
          before: null,
          data: { container_module: 'clips_tab_desktop_page', seen_reels: '[]' },
          first: 40,
          last: null,
          __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
          __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false
        }),
        doc_id: '36825039943776829'
      });
      const res = await fetch('/graphql/query', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-IG-App-ID': '936619743392459',
          'X-CSRFToken': cookie('csrftoken'),
          'X-Requested-With': 'XMLHttpRequest'
        },
        body
      });
      if (!res.ok) throw new Error('fast feed ' + res.status);
      const found = findConnection(await res.json());
      if (!found?.items?.length) throw new Error('fast feed empty');
      return { items: found.items, cursor: found.connection?.page_info?.end_cursor || '', hasMore: !!found.connection?.page_info?.has_next_page };
    }

    async function loadProfiles() {
      try { st.profiles = await request('SEEBAL_GET_SAVED_ACCOUNTS') || []; } catch {}
      renderProfiles();
    }

    function renderProfiles() {
      profileList.innerHTML = st.profiles.map(p => \`
        <div class="sb-profile-item" data-username="\${esc(p.username)}">
          <div class="sb-profile-avatar">\${p.avatar ? \`<img src="\${esc(p.avatar)}" onerror="this.remove()">\` : esc((p.username||'?').slice(0,1))}</div>
          <div><strong>@\${esc(p.username)}</strong><small>\${esc(p.fullName||'')}</small></div>
          <button class="sb-profile-del" data-del="\${esc(p.username)}">x</button>
        </div>
      \`).join('') || '<div style="color:#555;font-size:13px">No saved profiles</div>';
    }

    async function loadFeed(reset) {
      if (st.loading && !reset) return;
      const seq = ++st.loadSeq;
      if (!reset) {
        const localTotal = filteredItemsRaw().length;
        if (localTotal > st.visibleLimit) {
          st.visibleLimit = Math.min(localTotal, st.visibleLimit + st.limit);
          render();
          if (!st.cursor || filteredItemsRaw().length > st.visibleLimit) return;
        }
      }
      if (!reset && !st.cursor) return;
      if (!(await requireAuth())) return;
      if (seq !== st.loadSeq) return;
      st.loading = true;
      count.textContent = 'Loading...';
      if (reset) {
        st.items=[]; st.cursor='';
        st.visibleLimit = st.limit;
        if (videoObserver) { videoObserver.disconnect(); videoObserver = null; }
        grid.innerHTML='<div id="seebal-status">Loading...</div><div id="seebal-sentinel"></div>';
        restoreCache();
      }
      try {
        let data;
        if (!st.activeProfile?.userId && !st.activeProfile?.username) {
          try { data = await fastFeed(st.cursor); } catch { data = null; }
        }
        if (!data) data = await request('SEEBAL_FEED_REQUEST', { cursor: st.cursor, userId: st.activeProfile?.userId||'', username: st.activeProfile?.username||'' });
        if (seq !== st.loadSeq) return;
        const newItems = (data.items||[]).filter(it => it && it.code && !isHiddenItem(it));
        const existing = new Set((reset ? [] : st.items).map(it => it.code));
        const uniqueNew = newItems.filter(it => !existing.has(it.code));
        if (!reset && uniqueNew.length) st.visibleLimit += st.limit;
        st.items = reset ? uniqueNew : [...st.items, ...uniqueNew];
        st.cursor = data.cursor||'';
        saveCache();
        if (!reset && st.sort === 'feed' && !st.search && uniqueNew.length) {
          const sentinel = document.getElementById('seebal-sentinel');
          const html = uniqueNew.slice(0, Math.max(0, st.visibleLimit - grid.querySelectorAll('.sb-card').length)).map(cardHtml).join('');
          if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
          else grid.insertAdjacentHTML('beforeend', html + '<div id="seebal-sentinel"></div>');
          count.textContent = filteredItems().length + ' of ' + filteredItemsRaw().length + ' reels';
          bindCardVideoEvents();
          observeSentinel();
        } else {
          render();
        }
      } catch(e) {
        if (seq !== st.loadSeq) return;
        const status = grid.querySelector('#seebal-status') || Object.assign(document.createElement('div'), {id:'seebal-status'});
        status.textContent = 'Error: ' + (e.message||e);
        if (!status.parentNode) grid.appendChild(status);
        count.textContent = st.items.length + ' reels';
      } finally {
        if (seq === st.loadSeq) st.loading = false;
      }
    }

    function render() {
      const items = filteredItems();
      count.textContent = items.length + ' of ' + filteredItemsRaw().length + ' reels';
      if (videoObserver) { videoObserver.disconnect(); videoObserver = null; }
      grid.innerHTML = items.length
        ? items.map(cardHtml).join('') + '<div id="seebal-sentinel"></div>'
        : '<div id="seebal-status">No reels</div><div id="seebal-sentinel"></div>';
      bindCardVideoEvents();
      observeSentinel();
    }

    function cardHtml(it) {
        const user = it.author?.username || 'instagram';
        const v = viral(it);
        const caption = it.caption || '';
        return \`<div class="sb-card" data-code="\${esc(it.code)}">
          \${it.videoUrl ? \`<video src="\${esc(it.videoUrl)}" poster="\${esc(it.thumbnailUrl||'')}" preload="none" playsinline loop></video>\` : \`<img src="\${esc(it.thumbnailUrl||'')}" loading="lazy">\`}
          <span class="sb-viral">\${v ? esc(v.toFixed(1)+'x') : '1x'}</span>
          <button class="sb-hide" data-hide="\${esc(it.code)}" title="Not interesting">×</button>
          <button class="sb-play" data-play="\${esc(it.code)}">▶</button>
          <div class="sb-card-tools">
            <button class="sb-tool" data-dl="\${esc(it.code)}" title="Download">↓</button>
          </div>
          <div class="sb-card-meta">
            <div class="sb-caption">\${esc(caption)}</div>
            <div class="sb-card-user">
              <button class="sb-profile-link" data-open-profile="\${esc(user)}">@\${esc(user)}</button>
              <button class="sb-add-btn" data-save="\${esc(user)}" data-uid="\${esc(it.author?.id||'')}">+</button>
            </div>
            <div class="sb-card-stats">
              <span>♡ \${esc(fmt(it.likeCount))}</span><span>☰ \${esc(fmt(it.commentCount))}</span>
              <span>↗ \${esc(fmt(it.shareCount || it.saveCount))}</span><span>👤 \${esc(fmt(it.followerCount || it.author?.followerCount))}</span>
              <span>◷ \${esc(age(it.takenAt))}</span><span>▷ \${esc(fmt(it.viewCount))}</span>
            </div>
            \${dur(it.duration) ? \`<div class="sb-duration">\${esc(dur(it.duration))}</div>\` : ''}
          </div>
        </div>\`;
    }

    let videoObserver = null;
    function bindCardVideoEvents(root = grid) {
      if (!videoObserver) {
        videoObserver = new IntersectionObserver(entries => {
          for (const entry of entries) {
            const video = entry.target;
            if (!entry.isIntersecting && !video.paused) video.pause();
          }
        }, { root: gridWrap, threshold: 0.15 });
      }
      grid.querySelectorAll('.sb-card video').forEach(video => {
        const card = video.closest('.sb-card');
        if (video.dataset.sbBound) return;
        video.dataset.sbBound = '1';
        video.addEventListener('play', () => card?.classList.add('playing'));
        video.addEventListener('pause', () => card?.classList.remove('playing'));
        video.addEventListener('ended', () => card?.classList.remove('playing'));
        videoObserver.observe(video);
      });
    }

    let sentinelObserver = null;
    function observeSentinel() {
      const sentinel = document.getElementById('seebal-sentinel');
      if (!sentinel) return;
      if (sentinelObserver) sentinelObserver.disconnect();
      sentinelObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting) && !st.loading) loadFeed(false);
      }, { root: gridWrap, rootMargin: '500px 0px 500px 0px' });
      sentinelObserver.observe(sentinel);
    }

    shell.addEventListener('click', async e => {
      const act = e.target.dataset.act;
      const openProfileNow = e.target.closest('[data-open-profile]')?.dataset.openProfile;
      if (openProfileNow) {
        e.stopPropagation();
        const p = st.profiles.find(x => x.username === openProfileNow);
        st.activeProfile = { userId: p?.userId || '', username: openProfileNow };
        loadFeed(true);
        return;
      }
      if (act === 'feed') { st.activeProfile = null; loadFeed(true); }
      if (act === 'refresh') loadFeed(true);
      if (act === 'load-more') loadFeed(false);
      if (act === 'profiles') { sidebar.classList.toggle('open'); if(sidebar.classList.contains('open')) loadProfiles(); }
      if (act === 'folder') window.postMessage({ type:'SEEBAL_SELECT_FOLDER' },'*');
      if (act === 'auth') {
        if (st.loggedIn) {
          await request('SEEBAL_AUTH_LOGOUT');
          st.loggedIn = false;
          st.items = [];
          st.cursor = '';
          localStorage.removeItem('sb_cache_feed');
          grid.innerHTML = '<div id="seebal-status">Logged out. Login IG to load reels.</div><div id="seebal-sentinel"></div>';
          count.textContent = 'Login required';
        } else {
          await request('SEEBAL_AUTH_LOGIN');
          await refreshAuth();
          if (st.loggedIn) loadFeed(true);
          return;
        }
        refreshAuth();
      }
      const sortShort = e.target.dataset.sortShort;
      if (sortShort) { st.sort = sortShort; sortSelect.value = sortShort; st.visibleLimit = st.limit; render(); }
      const lim = e.target.dataset.limit;
      if (lim) {
        st.limit = Number(lim);
        st.visibleLimit = st.limit;
        limitBox.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.limit === lim));
        render();
      }
      if (act === 'add-profile') {
        const v = addInput.value.trim(); if(!v) return;
        addInput.disabled = true;
        try {
          const info = await request('SEEBAL_GET_USER_INFO', { username: v });
          await request('SEEBAL_SAVE_ACCOUNT', { account: { username: info.username, fullName: info.fullName||'', userId: info.id, avatar: info.avatar||'' } });
          addInput.value = ''; loadProfiles();
        } catch(err) { alert(err.message||err); }
        addInput.disabled = false;
      }

      const del = e.target.dataset.del;
      if (del) { await request('SEEBAL_REMOVE_ACCOUNT', { username: del }); loadProfiles(); }

      const profileUser = e.target.closest('[data-username]')?.dataset.username;
      if (profileUser && !e.target.dataset.del) {
        const p = st.profiles.find(x => x.username === profileUser);
        st.activeProfile = { userId: p?.userId || '', username: profileUser };
        loadFeed(true);
      }

      const openProfile = e.target.dataset.openProfile;
      if (openProfile) {
        const p = st.profiles.find(x => x.username === openProfile);
        st.activeProfile = { userId: p?.userId || '', username: openProfile };
        loadFeed(true);
      }

      const save = e.target.dataset.save;
      if (save) {
        e.target.textContent = '...';
        try {
          const info = await request('SEEBAL_GET_USER_INFO', { username: save });
          await request('SEEBAL_SAVE_ACCOUNT', { account: { username: info.username, fullName: info.fullName||'', userId: info.id, avatar: info.avatar||'' } });
          e.target.textContent = 'ok';
          setTimeout(()=>{ e.target.textContent='+'; }, 1500);
          loadProfiles();
        } catch { e.target.textContent='+'; }
      }

      const play = e.target.dataset.play;
      if (play) {
        const card = e.target.closest('.sb-card');
        const video = card?.querySelector('video');
        if (video) {
          if (video.paused) { video.play(); card.classList.add('playing'); }
          else { video.pause(); card.classList.remove('playing'); }
        }
      }

      const dl = e.target.dataset.dl;
      if (dl) {
        const it = st.items.find(x => x.code===dl);
        if (it?.videoUrl) {
          e.target.textContent = '…';
          window.postMessage({ type:'SEEBAL_DOWNLOAD_VIDEO', url:it.videoUrl, code:it.code, username:it.author?.username||'instagram' },'*');
          setTimeout(()=>{ e.target.textContent='↓'; }, 2000);
        }
      }

      const hide = e.target.dataset.hide;
      if (hide) {
        const hiddenItem = st.items.find(x => x.code === hide);
        st.hidden.add(hide);
        localStorage.setItem('sb_hidden', JSON.stringify([...st.hidden]));
        if (!st.activeProfile) {
          const author = itemAuthor(hiddenItem);
          if (author) {
            st.hiddenAuthors.add(author);
            localStorage.setItem('sb_hidden_authors', JSON.stringify([...st.hiddenAuthors]));
          }
        }
        render();
      }

      const card = e.target.closest('.sb-card');
      if (card && !e.target.closest('button') && !e.target.closest('[data-open-profile]')) {
        const video = card.querySelector('video');
        if (video) {
          if (video.paused) { video.play(); card.classList.add('playing'); }
          else { video.pause(); card.classList.remove('playing'); }
        }
      }
    });

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { st.search = searchInput.value; st.visibleLimit = st.limit; render(); }, 120);
    });
    sortSelect.addEventListener('change', () => { st.sort = sortSelect.value; st.visibleLimit = st.limit; render(); });

    // Infinite scroll
    let scrollQueued = false;
    gridWrap.addEventListener('scroll', () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        if (!st.loading && gridWrap.scrollTop + gridWrap.clientHeight > gridWrap.scrollHeight - 900) loadFeed(false);
      });
    });

    window.addEventListener('message', e => {
      if (e.data?.type === 'SEEBAL_DOWNLOAD_DONE') {
        const code = e.data.code;
        const btn = grid.querySelector(\`[data-dl="\${code}"]\`);
        if (btn) { btn.textContent = '✓'; setTimeout(()=>btn.textContent='↓', 2000); }
      }
    });

    setTimeout(async () => {
      if (await requireAuth()) loadFeed(true);
    }, 400);
  })();`;
}

// в”Ђв”Ђв”Ђ Inject Shell into Instagram page в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
async function injectShell(wc) {
  try {
    await wc.insertCSS(SHELL_CSS);
    await wc.executeJavaScript(buildShellJS(), true);
  } catch (e) {
    console.error('[Shell] inject failed:', e.message);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 960, minHeight: 600,
    show: false,
    backgroundColor: '#070707',
    title: 'SEEBAL REELS',
    webPreferences: {
      preload: path.join(__dirname, 'src', 'instagram-shell-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      webSecurity: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setUserAgent(UA);
  mainWindow.loadURL('https://www.instagram.com/reels/');

  // Inject Shell as soon as the page finishes loading (reliable, no fixed timeout)
  mainWindow.webContents.on('did-finish-load', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const url = mainWindow.webContents.getURL();
    // Skip auth pages вЂ” don't inject Shell there
    if (!url.includes('instagram.com') || url.includes('/accounts/login') || url.includes('/challenge')) return;
    await injectShell(mainWindow.webContents);
  });

  mainWindow.once('ready-to-show', () => { mainWindow?.show(); mainWindow?.focus(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://www.instagram.com/')) return { action: 'allow' };
    shell.openExternal(url); return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (_e, url) => {
    // Allow instagram navigation (login, reels, etc.)
    if (url.startsWith('https://www.instagram.com/') || url.startsWith('https://i.instagram.com/')) return;
    _e.preventDefault(); shell.openExternal(url);
  });
  mainWindow.on('closed', () => { mainWindow = null; stopAllMonitoring(); closeInstagramAgentWindow(); });
}


// в”Ђв”Ђв”Ђ IPC Handlers в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
ipcMain.handle('logout', async () => {
  closeInstagramAgentWindow();
  userInfoCache.clear();
  reelMetricsCache.clear();
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

ipcMain.handle('get-saved-accounts', () => getSavedAccountsForUi());

ipcMain.handle('save-account', (_e, account) => {
  const username = normalizeInstagramUsername(account.username || '');
  if (!username) throw new Error('Instagram user not found');
  const list = getSetting('savedAccounts', []);
  const idx = list.findIndex(a => String(a.username || '').toLowerCase() === username);
  const next = { ...account, username, lastUpdated: Date.now() };
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...next };
  } else {
    list.push(next);
  }
  setSetting('savedAccounts', list);
  return list;
});

ipcMain.handle('remove-account', (_e, username) => {
  const normalized = normalizeInstagramUsername(username) || String(username || '').toLowerCase();
  let list = getSetting('savedAccounts', []);
  list = list.filter(a => String(a.username || '').toLowerCase() !== normalized);
  setSetting('savedAccounts', list);
  if (monitorTimers[normalized]) { clearInterval(monitorTimers[normalized]); delete monitorTimers[normalized]; }
  return list;
});

ipcMain.handle('toggle-account-hidden', (_e, username) => {
  const list = getSetting('savedAccounts', []);
  const acc = list.find(a => a.username === username);
  if (acc) { acc.hidden = !acc.hidden; setSetting('savedAccounts', list); }
  return list;
});

// в”Ђв”Ђв”Ђ App Lifecycle в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

// Compatibility aliases for the current SEEBAL UI. Instagram logic above stays identical to the working Desktop build.
ipcMain.handle('auth:status', () => checkLoggedIn());
ipcMain.handle('auth:login', () => openLoginWindow());
ipcMain.handle('feed:recommendations', (_e, cursor) => getTrendingReels(cursor));
ipcMain.handle('profile:user-info', (_e, username) => getUserInfo(username));
ipcMain.handle('profile:user-reels', (_e, userId, cursor, username) => getUserReels(
  userId && typeof userId === 'object' ? userId : { userId, username },
  cursor
));
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
  const safeUser = String(reel.author?.username || 'instagram').replace(/[^\w.-]+/g, '_');
  const safeId = String(reel.code || reel.id || Date.now()).replace(/[^\w.-]+/g, '_');
  const dest = path.join(saveDir, safeUser + '_' + safeId + '.mp4');
  await downloadFile(reel.videoUrl, dest, safeId);
  return dest;
});
ipcMain.handle('debug:open-log', async () => {
  const logPath = path.join(app.getPath('userData'), 'logs', 'main.log');
  shell.openPath(logPath).catch(() => {});
  return true;
});

ipcMain.handle('seebal:select-folder', async () => {
  const currentFolder = getSetting('downloadFolder', app.getPath('downloads'));
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: currentFolder
  });
  if (!result.canceled && result.filePaths[0]) setSetting('downloadFolder', result.filePaths[0]);
  return getSetting('downloadFolder', app.getPath('downloads'));
});

ipcMain.handle('seebal:download-url', async (_event, payload) => {
  if (!payload?.url) throw new Error('No video URL');
  const saveDir = getSetting('downloadFolder', app.getPath('downloads'));
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  const safeUser = String(payload.username || 'instagram').replace(/[^\w.-]+/g, '_');
  const safeCode = String(payload.code || Date.now()).replace(/[^\w.-]+/g, '_');
  const dest = path.join(saveDir, `${safeUser}_${safeCode}.mp4`);
  await downloadFile(payload.url, dest, safeCode);
  return dest;
});

// в”Ђв”Ђв”Ђ Session Keepalive в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// Ping Instagram every 15 min while logged in to refresh session cookies
// and prevent them from expiring during inactivity
let keepaliveTimer = null;

async function sessionKeepalive() {
  try {
    const loggedIn = await checkLoggedIn();
    if (!loggedIn) return; // not logged in вЂ” nothing to keep alive
    const cookie = await getIGCookies();
    const csrf = await getCSRFToken();
    const response = await net.fetch(
      'https://www.instagram.com/api/v1/accounts/current_user/?edit=true',
      {
        headers: {
          'User-Agent': UA,
          'Cookie': cookie,
          'X-IG-App-ID': IG_APP_ID,
          'X-CSRFToken': csrf,
          'Accept': '*/*',
          'Referer': 'https://www.instagram.com/'
        }
      }
    );
    console.log(`[Keepalive] Instagram session ping в†’ ${response.status}`);
  } catch (e) {
    console.warn('[Keepalive] Ping failed (will retry in 15m):', e.message);
  }
}

app.whenReady().then(async () => {
  if (fs.existsSync(VIDIQ_EXTENSION_PATH)) {
    try {
      await session.defaultSession.loadExtension(VIDIQ_EXTENSION_PATH, { allowFileAccess: true });
      fs.appendFileSync(EXTENSION_LOG_FILE, `[${new Date().toISOString()}] loaded ${VIDIQ_EXTENSION_PATH}\n`);
      console.log('[SEEBAL] vidIQ Instagram extension loaded:', VIDIQ_EXTENSION_PATH);
    } catch (error) {
      fs.appendFileSync(EXTENSION_LOG_FILE, `[${new Date().toISOString()}] load failed ${error.stack || error.message || error}\n`);
      console.error('[SEEBAL] failed to load vidIQ extension:', error);
    }
  } else {
    console.log('[SEEBAL] vidIQ extension path not found, skipping:', VIDIQ_EXTENSION_PATH);
  }
  createMainWindow();

  // в”Ђв”Ђв”Ђ Session Guard в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  // Intercept all Instagram responses and block any attempt to clear sessionid.
  // Instagram sometimes sends Set-Cookie: sessionid=; Max-Age=0 to force logout вЂ”
  // we strip that header so the local cookie stays alive.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['*://*.instagram.com/*', '*://instagram.com/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      const cookieKey = Object.keys(headers).find(k => k.toLowerCase() === 'set-cookie');
      if (cookieKey && Array.isArray(headers[cookieKey])) {
        const before = headers[cookieKey].length;
        headers[cookieKey] = headers[cookieKey].filter(cookie => {
          const lower = cookie.toLowerCase();
          // Block only cookies that CLEAR sessionid (empty value or Max-Age=0)
          const clearsSession =
            lower.startsWith('sessionid=;') ||
            lower.startsWith('sessionid= ;') ||
            (lower.startsWith('sessionid=') && lower.includes('max-age=0'));
          if (clearsSession) {
            console.log('[Session Guard] Blocked Instagram from clearing sessionid');
            return false;
          }
          return true;
        });
        if (headers[cookieKey].length === 0) delete headers[cookieKey];
      }
      callback({ responseHeaders: headers });
    }
  );

  // Start keepalive 30s after launch, then every 15 minutes
  setTimeout(() => {
    sessionKeepalive();
    keepaliveTimer = setInterval(sessionKeepalive, 15 * 60 * 1000);
  }, 30 * 1000);
});

app.on('window-all-closed', () => {
  stopAllMonitoring();
  closeInstagramAgentWindow();
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  app.quit();
});
app.on('activate', () => { if (!mainWindow) createMainWindow(); });

