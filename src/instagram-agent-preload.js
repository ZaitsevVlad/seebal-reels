(() => {
  function text(node) {
    return (node?.textContent || '').trim();
  }

  function cleanUsername(value) {
    return String(value || '')
      .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
      .replace(/^\/+|\/+$/g, '')
      .split('/')[0]
      .replace(/^@/, '');
  }

  function findAuthor(scope) {
    const links = [...(scope || document).querySelectorAll('a[href^="/"]')];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (
        href.includes('/reel/') ||
        href.includes('/p/') ||
        href.includes('/explore/') ||
        href.includes('/accounts/') ||
        href === '/'
      ) continue;
      const username = cleanUsername(href);
      if (username && /^[A-Za-z0-9._]+$/.test(username)) return username;
    }
    return '';
  }

  function collectReels() {
    const out = [];
    const seen = new Set();
    const anchors = [...document.querySelectorAll('a[href*="/reel/"]')];

    for (const anchor of anchors) {
      const href = anchor.href || anchor.getAttribute('href') || '';
      const match = href.match(/\/reel\/([^/?#]+)/);
      if (!match) continue;
      const code = match[1];
      if (seen.has(code)) continue;
      seen.add(code);

      const scope = anchor.closest('article') || anchor.closest('div[role="button"]') || anchor.parentElement || document;
      const video = scope.querySelector('video');
      const img = scope.querySelector('img');
      const author = findAuthor(scope);
      const label = text(scope);

      out.push({
        id: code,
        code,
        href,
        videoUrl: video?.currentSrc || video?.src || '',
        thumbnailUrl: img?.currentSrc || img?.src || '',
        caption: label.slice(0, 500),
        viewCount: 0,
        likeCount: 0,
        commentCount: 0,
        duration: Number(video?.duration || 0),
        author: { username: author, fullName: '', avatar: '' }
      });
    }

    return out;
  }

  window.__SEEBAL_IG_AGENT__ = {
    collectReels,
    scrollMore() {
      window.scrollBy(0, Math.max(window.innerHeight * 1.4, 900));
      return true;
    },
    location() {
      return location.href;
    }
  };
})();
