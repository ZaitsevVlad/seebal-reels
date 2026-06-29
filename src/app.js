const grid = document.getElementById('grid');
const sentinel = document.getElementById('sentinel');
const loginBtn = document.getElementById('loginBtn');
const backBtn = document.getElementById('backBtn');
const refreshBtn = document.getElementById('refreshBtn');
const folderBtn = document.getElementById('folderBtn');
const logBtn = document.getElementById('logBtn');
const tabButtons = [...document.querySelectorAll('.tab')];
const statusEl = document.getElementById('status');
const counterEl = document.getElementById('counter');
const profileLabel = document.getElementById('profileLabel');
const folderLabel = document.getElementById('folderLabel');
const messageEl = document.getElementById('message');

const state = {
  mode: 'feed',
  cursor: '',
  hasMore: true,
  loading: false,
  runId: 0,
  seen: new Set(),
  count: 0,
  profile: null,
  feedCache: null,
  profileCache: new Map(),
  supportAccounts: JSON.parse(localStorage.getItem('supportAccounts') || '[]'),
  supportRequests: JSON.parse(localStorage.getItem('supportRequests') || '[]'),
  myLikes: JSON.parse(localStorage.getItem('myLikes') || '[]'),
  siteLikes: JSON.parse(localStorage.getItem('siteLikes') || '[]'),
  blockedAuthors: new Set(JSON.parse(localStorage.getItem('blockedAuthors') || '[]')),
  profileReturn: 'feed',
  reelHost: grid,
  authOk: false,
  role: localStorage.getItem('role') || 'dev'
};

function formatNumber(value) {
  const n = Number(value || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n || 0);
}

function setMessage(text, error = false) {
  messageEl.textContent = text || '';
  messageEl.className = error ? 'error' : '';
}

function setActiveTab(tab) {
  tabButtons.forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
}

function setReelHost(host = grid) {
  state.reelHost = host;
}

function saveLocalLists() {
  localStorage.setItem('myLikes', JSON.stringify(state.myLikes));
  localStorage.setItem('siteLikes', JSON.stringify(state.siteLikes));
  localStorage.setItem('supportAccounts', JSON.stringify(state.supportAccounts));
  localStorage.setItem('supportRequests', JSON.stringify(state.supportRequests));
}

function blockAuthor(username) {
  if (!username) return;
  const key = username.toLowerCase();
  state.blockedAuthors.add(key);
  localStorage.setItem('blockedAuthors', JSON.stringify([...state.blockedAuthors]));
  // Animate-out and remove ALL visible cards from this author
  document.querySelectorAll(`.reel[data-author="${key}"]`).forEach(card => {
    card.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.9)';
    setTimeout(() => card.remove(), 260);
  });
  // Invalidate feed cache so blocked author won't appear on restore
  state.feedCache = null;
}

function isLiked(reel) {
  return state.myLikes.some(item => item.id === reel.id);
}

function likeReel(reel) {
  if (!reel?.id) return;
  if (!state.myLikes.some(item => item.id === reel.id)) state.myLikes.unshift(reel);
  if (!state.siteLikes.some(item => item.id === reel.id)) state.siteLikes.unshift(reel);
  saveLocalLists();
}

function removeSiteLike(reelId) {
  state.siteLikes = state.siteLikes.filter(item => item.id !== reelId);
  saveLocalLists();
}

function snapshotFeed() {
  if (state.mode !== 'feed') return;
  state.feedCache = {
    cursor: state.cursor,
    hasMore: state.hasMore,
    count: state.count,
    seen: new Set(state.seen),
    nodes: [...grid.children],
    scrollY: window.scrollY
  };
}

function restoreFeed() {
  const cache = state.feedCache;
  if (!cache) return false;
  state.mode = 'feed';
  state.profile = null;
  state.cursor = cache.cursor;
  state.hasMore = cache.hasMore;
  state.count = cache.count;
  state.seen = new Set(cache.seen);
  setReelHost(grid);
  grid.classList.remove('support-feed');
  grid.replaceChildren(...cache.nodes);
  counterEl.textContent = `${state.count} reels`;
  sentinel.textContent = state.hasMore ? 'scroll for more' : 'end';
  backBtn.hidden = true;
  profileLabel.textContent = '';
  setActiveTab('feed');
  setMessage('');
  setTimeout(() => window.scrollTo(0, cache.scrollY || 0), 0);
  return true;
}

function cacheCurrentProfile() {
  if (state.mode !== 'profile' || !state.profile?.username) return;
  state.profileCache.set(state.profile.username.toLowerCase(), {
    profile: state.profile,
    cursor: state.cursor,
    hasMore: state.hasMore,
    count: state.count,
    seen: new Set(state.seen),
    nodes: [...(state.reelHost || grid).children],
    label: profileLabel.textContent
  });
}

function restoreProfile(username) {
  const cache = state.profileCache.get(String(username || '').toLowerCase());
  if (!cache) return false;
  state.mode = 'profile';
  state.profile = cache.profile;
  state.cursor = cache.cursor;
  state.hasMore = cache.hasMore;
  state.count = cache.count;
  state.seen = new Set(cache.seen);
  (state.reelHost || grid).replaceChildren(...cache.nodes);
  counterEl.textContent = `${state.count} reels`;
  profileLabel.textContent = cache.label || `@${cache.profile.username}`;
  sentinel.textContent = state.hasMore ? 'scroll for more' : 'end';
  backBtn.hidden = false;
  setActiveTab(state.profileReturn === 'support' ? 'support' : 'profiles');
  setMessage('');
  window.scrollTo(0, 0);
  return true;
}

function renderReel(reel) {
  const card = document.createElement('article');
  card.className = 'reel';
  const statsText = Number(reel.viewCount || 0) > 0
    ? `${formatNumber(reel.viewCount)} views`
    : `${formatNumber(reel.likeCount)} likes · ${formatNumber(reel.commentCount)} comments`;
  const authorKey = (reel.author?.username || '').toLowerCase();
  card.dataset.author = authorKey;
  const showNotInterested = state.mode === 'feed';
  card.innerHTML = `
    <div class="media">
      <img src="${reel.thumbnailUrl || ''}" loading="lazy" alt="" />
      <button class="play" aria-label="Play"></button>
      <button class="save-profile" aria-label="Save profile">+</button>
      <button class="like ${isLiked(reel) ? 'liked' : ''}" aria-label="Like">♥</button>
      ${state.mode === 'siteLikes' && state.role === 'dev' ? '<button class="delete-reel" aria-label="Delete">×</button>' : ''}
      ${showNotInterested ? '<button class="not-interested" aria-label="Not interested" title="Не интересно — скрыть автора">✕</button>' : ''}
      <button class="download">Download</button>
    </div>
    <div class="meta">
      <strong>@${reel.author?.username || 'instagram'}</strong>
      <span>${statsText}</span>
    </div>
  `;
  const media = card.querySelector('.media');
  const img = card.querySelector('img');
  const playBtn = card.querySelector('.play');
  const saveProfileBtn = card.querySelector('.save-profile');
  const likeBtn = card.querySelector('.like');
  const deleteReelBtn = card.querySelector('.delete-reel');
  const notInterestedBtn = card.querySelector('.not-interested');
  const downloadBtn = card.querySelector('.download');
  const authorEl = card.querySelector('.meta strong');
  let video = null;

  const startPlayback = () => {
    if (!reel.videoUrl) return;
    if (video) {
      video.controls = true;
      media.classList.add('playing');
      video.play().catch(() => {});
      return;
    }
    video = document.createElement('video');
    video.src = reel.videoUrl;
    video.controls = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    video.className = 'video';
    media.appendChild(video);
    media.classList.add('playing');
    img.style.opacity = '0';
    video.addEventListener('play', () => {
      video.controls = true;
      media.classList.add('playing');
    });
    video.addEventListener('pause', () => {
      video.controls = false;
      media.classList.remove('playing');
    });
    video.addEventListener('ended', () => {
      video.controls = false;
      media.classList.remove('playing');
    });
    video.play().catch(() => {});
  };

  playBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    startPlayback();
  });
  media.addEventListener('click', (event) => {
    if (event.target === downloadBtn || event.target === likeBtn || event.target === saveProfileBtn ||
        event.target === deleteReelBtn || event.target === notInterestedBtn || event.target === video ||
        downloadBtn.contains(event.target) || likeBtn.contains(event.target) ||
        saveProfileBtn.contains(event.target) || deleteReelBtn?.contains(event.target) ||
        notInterestedBtn?.contains(event.target)) return;
    startPlayback();
  });
  saveProfileBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const username = reel.author?.username;
    if (!username) return;
    try {
      saveProfileBtn.textContent = '...';
      const info = await window.api.getUserInfo(username);
      const avatar = info.avatar ? await window.api.proxyAvatar(info.avatar) : '';
      await window.api.removeAccount(info.username);
      await window.api.saveAccount({ ...info, avatar: avatar || info.avatar, userId: info.id });
      saveProfileBtn.textContent = '✓';
    } catch (error) {
      saveProfileBtn.textContent = '+';
      setMessage(error.message || String(error), true);
    }
  });
  likeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    likeReel(reel);
    likeBtn.classList.add('liked');
  });
  if (deleteReelBtn) deleteReelBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    removeSiteLike(reel.id);
    card.remove();
    counterEl.textContent = `${state.siteLikes.length} reels`;
  });
  if (notInterestedBtn) notInterestedBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const username = reel.author?.username;
    if (!username) { card.remove(); return; }
    notInterestedBtn.textContent = '✓';
    notInterestedBtn.style.opacity = '1';
    blockAuthor(username);
    setMessage(`Автор @${username} скрыт. Обновите ленту чтобы загрузить новые.`);
  });
  downloadBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      downloadBtn.textContent = '...';
      const file = await window.api.downloadReel(reel);
      setMessage(`Скачано: ${file}`);
    } catch (error) {
      setMessage(error.message || String(error), true);
    } finally {
      downloadBtn.textContent = 'Download';
    }
  });
  authorEl.addEventListener('click', () => {
    const username = reel.author?.username;
    if (username) openProfile(username);
  });
  (state.reelHost || grid).appendChild(card);
}

async function updateAuth() {
  const ok = await window.api.authStatus();
  state.authOk = ok;
  statusEl.textContent = '';
  statusEl.hidden = true;
  loginBtn.textContent = ok ? 'Sign out' : 'Instagram';
  loginBtn.classList.toggle('connected', ok);
  return ok;
}

async function loadMore(reset = false) {
  if (state.loading || (!state.hasMore && !reset)) return;
  const runId = state.runId;
  state.loading = true;

  // Update both global sentinel and (if in profile split-panel) the inner sentinel
  const setSentinel = (text) => {
    sentinel.textContent = text;
    if (state.profileSentinel) state.profileSentinel.textContent = text;
  };

  setSentinel('loading');
  setMessage('');
  if (reset) {
    state.cursor = '';
    state.hasMore = true;
    state.seen.clear();
    state.count = 0;
    (state.reelHost || grid).innerHTML = '';
  }
  try {
    if (!(await updateAuth())) {
      // Session expired silently — auto re-login without bothering the user
      setSentinel('');
      const ok = await window.api.login();
      await updateAuth();
      if (!ok) {
        setMessage('Нужно войти в Instagram', true);
        setSentinel('error');
        return;
      }
    }
    const data = state.mode === 'profile'
      ? await window.api.getUserReels(state.profile.id, state.cursor)
      : await window.api.getRecommendations(state.cursor);
    if (runId !== state.runId) return;
    for (const reel of data.items || []) {
      if (!reel.id || state.seen.has(reel.id)) continue;
      // Skip blocked authors in feed mode
      if (state.mode === 'feed' && reel.author?.username &&
          state.blockedAuthors.has(reel.author.username.toLowerCase())) continue;
      state.seen.add(reel.id);
      state.count += 1;
      renderReel(reel);
    }
    state.cursor = data.cursor || '';
    state.hasMore = !!data.hasMore || !!state.cursor;
    counterEl.textContent = `${state.count} reels`;
    cacheCurrentProfile();
    setSentinel(state.hasMore ? 'scroll for more' : 'end');
    // If not in split-panel, also auto-load if content doesn't fill screen
    if (!state.profileScrollContainer && state.hasMore && document.documentElement.scrollHeight <= window.innerHeight + 300) {
      setTimeout(() => loadMore(false), 150);
    }
  } catch (error) {
    // If session expired during the request — auto re-login
    if (error?.code === 'IG_AUTH' || error?.message?.includes('авторизацию') || error?.message?.includes('login')) {
      setSentinel('');
      setMessage('Сессия истекла, вход в Instagram...');
      try {
        const ok = await window.api.login();
        await updateAuth();
        if (ok && runId === state.runId) {
          setMessage('');
          loadMore(reset); // retry
        } else {
          setMessage('Нужно войти в Instagram', true);
          setSentinel('error');
        }
      } catch (_) {
        setMessage('Нужно войти в Instagram', true);
        setSentinel('error');
      }
      return;
    }
    setMessage(error.message || String(error), true);
    setSentinel('error');
  } finally {
    if (runId === state.runId) state.loading = false;
    if (!state.profileScrollContainer && state.hasMore && sentinel.getBoundingClientRect().top < window.innerHeight + 1200) {
      setTimeout(() => loadMore(false), 150);
    }
  }
}

function maybeLoadNearBottom(distance = 2200) {
  if (!['feed', 'profile'].includes(state.mode)) return;

  // In split-panel (profiles tab), the scroll happens inside .profile-reels container
  const container = state.profileScrollContainer;
  if (container) {
    const left = container.scrollHeight - container.clientHeight - container.scrollTop;
    if (left < distance) loadMore(false);
    return;
  }

  // Otherwise global scroll (feed mode)
  const left = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
  if (left < distance) loadMore(false);
}

function resetPanel(mode, title, message = '') {
  state.runId += 1;
  state.loading = false;
  snapshotFeed();          // save feed before any tab switch
  cacheCurrentProfile();   // save current profile before any tab switch
  state.mode = mode;
  state.cursor = '';
  state.hasMore = false;
  state.profile = null;
  state.seen.clear();
  state.count = 0;
  state.profileScrollContainer = null;
  state.profileSentinel = null;
  grid.innerHTML = '';
  grid.classList.remove('support-feed');
  setReelHost(grid);
  counterEl.textContent = '0 reels';
  profileLabel.textContent = title;
  backBtn.hidden = false;
  setActiveTab(mode);
  setMessage(message);
  sentinel.textContent = '';
  window.scrollTo(0, 0);
}

function normalizeUsername(input) {
  return String(input || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^@/, '')
    .split(/[/?#]/)[0]
    .trim();
}

function renderAccountCard(account, options = {}) {
  const card = document.createElement('article');
  card.className = 'account-card';
  card.innerHTML = `
    <img src="${account.avatar || ''}" alt="" />
    <div>
      <strong>@${account.username}</strong>
      <span>${account.fullName || ''}</span>
      <small>${formatNumber(account.followers)} followers · ${formatNumber(account.posts)} posts</small>
    </div>
    ${options.removable ? '<button class="remove-account" aria-label="Remove">×</button>' : ''}
  `;
  const avatarImg = card.querySelector('img');
  if (account.avatar && /^https?:/i.test(account.avatar)) {
    window.api.proxyAvatar(account.avatar).then(src => {
      if (src) avatarImg.src = src;
    }).catch(() => {});
  }
  card.addEventListener('click', () => openProfile(account.username, options.kind || 'profiles'));
  card.querySelector('strong').addEventListener('click', () => openProfile(account.username, options.kind || 'profiles'));
  const remove = card.querySelector('.remove-account');
  if (remove) remove.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (options.kind === 'support') {
      state.supportAccounts = state.supportAccounts.filter(item => item.username !== account.username);
      localStorage.setItem('supportAccounts', JSON.stringify(state.supportAccounts));
      renderSupportPanel();
    } else {
      await window.api.removeAccount(account.username);
      renderProfilesPanel();
    }
  });
  return card;
}

function renderAccountForm(placeholder, onSubmit) {
  const form = document.createElement('form');
  form.className = 'account-form';
  form.innerHTML = `<input placeholder="${placeholder}" /><button type="submit">Add</button>`;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = form.querySelector('input');
    const button = form.querySelector('button');
    const username = normalizeUsername(input.value);
    if (!username) return;
    button.textContent = '...';
    try {
      await onSubmit(username);
      input.value = '';
    } catch (error) {
      setMessage(error.message || String(error), true);
    } finally {
      button.textContent = 'Add';
    }
  });
  return form;
}

function createSplitPanel(kind) {
  const layout = document.createElement('section');
  layout.className = 'split-panel';
  // .profile-reels = scrollable container | .profile-reels-grid = card grid
  layout.innerHTML = '<aside class="account-list"></aside><section class="profile-reels"><div class="profile-reels-grid"></div><div class="profile-sentinel sentinel"></div></section>';
  grid.appendChild(layout);
  const list = layout.querySelector('.account-list');
  const reelsContainer = layout.querySelector('.profile-reels');
  const reelsGrid = layout.querySelector('.profile-reels-grid');
  const profileSentinel = layout.querySelector('.profile-sentinel');

  // Cards are appended to the inner grid
  setReelHost(reelsGrid);
  state.profileReturn = kind;

  // Track the scrollable container
  state.profileScrollContainer = reelsContainer;
  state.profileSentinel = profileSentinel;

  // Remove old scroll listener if any
  if (state._profileScrollHandler && state._prevProfileScrollContainer) {
    state._prevProfileScrollContainer.removeEventListener('scroll', state._profileScrollHandler);
  }
  state._prevProfileScrollContainer = reelsContainer;
  state._profileScrollHandler = () => maybeLoadNearBottom(1800);
  reelsContainer.addEventListener('scroll', state._profileScrollHandler, { passive: true });

  // IntersectionObserver on the inner sentinel
  if (state._profileSentinelObserver) state._profileSentinelObserver.disconnect();
  state._profileSentinelObserver = new IntersectionObserver(
    entries => { if (entries.some(e => e.isIntersecting)) loadMore(false); },
    { root: reelsContainer, threshold: 0.01, rootMargin: '600px 0px' }
  );
  state._profileSentinelObserver.observe(profileSentinel);

  return { list, reels: reelsGrid };
}

async function renderProfilesPanel() {
  resetPanel('profiles', 'Saved profiles');
  const { list, reels } = createSplitPanel('profiles');
  list.appendChild(renderAccountForm('@username or Instagram link', async (username) => {
    const info = await window.api.getUserInfo(username);
    const avatar = info.avatar ? await window.api.proxyAvatar(info.avatar) : '';
    await window.api.removeAccount(info.username);
    await window.api.saveAccount({ ...info, avatar: avatar || info.avatar, userId: info.id });
    await renderProfilesPanel();
  }));
  const accounts = await window.api.getSavedAccounts();
  if (!accounts.length) {
    reels.innerHTML = '<div class="empty-panel">Choose or add a profile to see Reels here.</div>';
    setMessage('Saved profiles will appear here. Add username or open profile from feed.');
    return;
  }
  accounts.forEach(account => list.appendChild(renderAccountCard(account, { removable: true, kind: 'profiles' })));
  reels.innerHTML = '<div class="empty-panel">Hover and click a profile on the left.</div>';
  counterEl.textContent = `${accounts.length} profiles`;
}

function renderSupportPanel() {
  resetPanel('support', 'Mutual support');
  setReelHost(grid);
  grid.classList.add('support-feed');
  const submitBox = document.createElement('section');
  submitBox.className = 'support-submit';
  submitBox.innerHTML = '<button class="submit-account">Submit account</button><div class="support-form-slot"></div>';
  grid.appendChild(submitBox);
  const slot = submitBox.querySelector('.support-form-slot');
  submitBox.querySelector('.submit-account').addEventListener('click', () => {
    slot.innerHTML = '';
    slot.appendChild(renderAccountForm('@username or Instagram link', async (username) => {
      if (
        state.supportAccounts.some(account => account.username === username) ||
        state.supportRequests.some(account => account.username === username)
      ) {
        setMessage('This account is already submitted.', true);
        return;
      }
      const info = await window.api.getUserInfo(username);
      const avatar = info.avatar ? await window.api.proxyAvatar(info.avatar) : '';
      state.supportRequests.unshift({ ...info, avatar: avatar || info.avatar, userId: info.id, requestedAt: Date.now() });
      saveLocalLists();
      renderSupportPanel();
    }));
  });

  if (state.role === 'dev' && state.supportRequests.length) {
    const requests = document.createElement('section');
    requests.className = 'request-panel';
    requests.innerHTML = '<strong>Pending requests</strong>';
    state.supportRequests.forEach(account => {
      const row = renderAccountCard(account, { removable: false, kind: 'supportRequest' });
      const approve = document.createElement('button');
      approve.className = 'approve-account';
      approve.textContent = 'Approve';
      approve.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!state.supportAccounts.some(item => item.username === account.username)) state.supportAccounts.unshift(account);
        state.supportRequests = state.supportRequests.filter(item => item.username !== account.username);
        saveLocalLists();
        renderSupportPanel();
      });
      const reject = document.createElement('button');
      reject.className = 'reject-account';
      reject.textContent = 'Reject';
      reject.addEventListener('click', (event) => {
        event.stopPropagation();
        state.supportRequests = state.supportRequests.filter(item => item.username !== account.username);
        saveLocalLists();
        renderSupportPanel();
      });
      row.append(approve, reject);
      requests.appendChild(row);
    });
    grid.appendChild(requests);
  }

  if (!state.supportAccounts.length) {
    setMessage('Submit an account. After dev approval it will appear in mutual support feed.');
    sentinel.textContent = 'end';
    return;
  }

  setMessage('Loading mutual support feed...');
  counterEl.textContent = `${state.supportAccounts.length} approved accounts`;
  loadSupportFeed();
}

async function loadSupportFeed() {
  state.runId += 1;
  const runId = state.runId;
  state.loading = true;
  state.seen.clear();
  state.count = 0;
  const accounts = [...state.supportAccounts].sort(() => Math.random() - 0.5);
  try {
    for (const account of accounts) {
      if (runId !== state.runId) return;
      if (!account.userId && !account.id) continue;
      const data = await window.api.getUserReels(account.userId || account.id, '');
      for (const reel of (data.items || []).slice(0, 8)) {
        if (!reel.id || state.seen.has(reel.id)) continue;
        state.seen.add(reel.id);
        state.count += 1;
        renderReel(reel);
      }
    }
    counterEl.textContent = `${state.count} reels`;
    sentinel.textContent = 'end';
    setMessage('');
  } catch (error) {
    setMessage(error.message || String(error), true);
    sentinel.textContent = 'error';
  } finally {
    state.loading = false;
  }
}

function renderPlaceholderPanel(tab, title) {
  resetPanel(tab, title, 'This section is prepared, data layer will be added next.');
}

function renderLikesPanel(tab, title, items) {
  resetPanel(tab, title);
  if (!items.length) {
    setMessage('No liked reels yet.');
    return;
  }
  items.forEach(reel => renderReel(reel));
  counterEl.textContent = `${items.length} reels`;
  sentinel.textContent = 'end';
}

async function openProfile(username, returnTo = state.mode) {
  snapshotFeed();
  state.profileReturn = ['profiles', 'support'].includes(returnTo) ? returnTo : 'feed';
  if (restoreProfile(username)) return;
  state.runId += 1;
  state.loading = false;
  state.mode = 'profile';
  state.cursor = '';
  state.hasMore = true;
  state.seen.clear();
  state.count = 0;

  if (state.profileReturn === 'profiles' && state.reelHost && state.reelHost !== grid) {
    // We're inside the split-panel — clear the inner grid, keep scroll container
    state.reelHost.innerHTML = '';
    // profileScrollContainer and profileSentinel were set by createSplitPanel, keep them
    // but reset sentinel text
    if (state.profileSentinel) state.profileSentinel.textContent = 'loading profile';
  } else {
    // Full-screen profile (from feed / support)
    state.profileScrollContainer = null;
    state.profileSentinel = null;
    grid.innerHTML = '';
    setReelHost(grid);
  }
  backBtn.hidden = false;
  setActiveTab(state.profileReturn === 'support' ? 'support' : 'profiles');
  profileLabel.textContent = `@${username}`;
  sentinel.textContent = 'loading profile';
  setMessage('');
  try {
    const info = await window.api.getUserInfo(username);
    if (state.mode !== 'profile') return;
    state.profile = info;
    const followersText = Number(info.followers || 0) > 0 ? `${formatNumber(info.followers)} followers` : 'followers unavailable';
    const postsText = Number(info.posts || 0) > 0 ? `${formatNumber(info.posts)} posts` : 'posts unavailable';
    profileLabel.textContent = `@${info.username} · ${followersText} · ${postsText}`;
    await loadMore(true);
  } catch (error) {
    setMessage(error.message || String(error), true);
    sentinel.textContent = 'profile error';
  }
}

function openFeed() {
  state.runId += 1;
  state.loading = false;
  cacheCurrentProfile();
  if (restoreFeed()) return;
  state.mode = 'feed';
  state.profile = null;
  setReelHost(grid);
  grid.classList.remove('support-feed');
  grid.innerHTML = '';
  backBtn.hidden = true;
  profileLabel.textContent = '';
  setActiveTab('feed');
  loadMore(true);
}

function goBack() {
  if (state.mode === 'profile') {
    if (state.profileReturn === 'profiles') return renderProfilesPanel();
    if (state.profileReturn === 'support') return renderSupportPanel();
  }
  return openFeed();
}

loginBtn.addEventListener('click', async () => {
  if (state.authOk) {
    await window.api.logout();
    await updateAuth();
    return;
  }
  await window.api.login();
  await updateAuth();
  await loadMore(true);
});
backBtn.addEventListener('click', goBack);
refreshBtn.addEventListener('click', () => {
  // Clear the appropriate cache so this is a real fresh reload
  if (state.mode === 'profile' && state.profile?.username) {
    state.profileCache.delete(state.profile.username.toLowerCase());
  } else {
    state.feedCache = null;
  }
  loadMore(true);
});
folderBtn.addEventListener('click', async () => {
  const folder = await window.api.selectDownloadFolder();
  if (folder) folderLabel.textContent = folder;
});
logBtn.addEventListener('click', () => window.api.openDebugLog());
tabButtons.forEach(button => {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab;
    if (tab === 'feed') return openFeed();
    if (tab === 'profiles') return renderProfilesPanel();
    if (tab === 'support') return renderSupportPanel();
    if (tab === 'myLikes') return renderLikesPanel('myLikes', 'My likes', state.myLikes);
    if (tab === 'siteLikes') return renderLikesPanel('siteLikes', 'Liked by users', state.siteLikes);
    return renderPlaceholderPanel(tab, button.textContent);
    state.runId += 1;
    state.loading = false;
    state.mode = tab;
    setActiveTab(tab);
    backBtn.hidden = false;
    grid.innerHTML = '';
    counterEl.textContent = '0 reels';
    profileLabel.textContent = button.textContent;
    sentinel.textContent = 'coming soon';
    setMessage('Раздел подготовлен, наполнение добавим следующим шагом.');
  });
});

new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting)) loadMore(false);
}, { root: null, threshold: 0.01, rootMargin: '1200px 0px' }).observe(sentinel);

window.addEventListener('scroll', () => maybeLoadNearBottom(2400), { passive: true });
window.addEventListener('wheel', () => maybeLoadNearBottom(2600), { passive: true });
window.addEventListener('touchmove', () => maybeLoadNearBottom(2600), { passive: true });
window.addEventListener('keydown', (event) => {
  if (['PageDown', 'End', 'ArrowDown', ' '].includes(event.key)) setTimeout(() => maybeLoadNearBottom(2800), 0);
});

sentinel.addEventListener('mouseenter', () => loadMore(false));
sentinel.addEventListener('click', () => loadMore(false));

(async () => {
  folderLabel.textContent = await window.api.getDownloadFolder();
  await updateAuth();
  await loadMore(true);
})();
