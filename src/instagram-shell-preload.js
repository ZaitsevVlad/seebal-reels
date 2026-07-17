const { ipcRenderer } = require('electron');

window.addEventListener('message', async (event) => {
  const data = event.data || {};
  if (!data.type || !data.type.startsWith('SEEBAL_')) return;
  const requestId = data.requestId;
  try {
    let result;

    if (data.type === 'SEEBAL_DOWNLOAD_VIDEO' && data.url) {
      result = await ipcRenderer.invoke('seebal:download-url', {
        url: data.url, code: data.code || '', username: data.username || 'instagram'
      });
      window.postMessage({ type: 'SEEBAL_DOWNLOAD_DONE', requestId, result, code: data.code }, '*');
      return;
    }

    if (data.type === 'SEEBAL_SELECT_FOLDER') {
      result = await ipcRenderer.invoke('seebal:select-folder');
      window.postMessage({ type: 'SEEBAL_SELECT_FOLDER_RESPONSE', requestId, result }, '*');
      return;
    }

    if (data.type === 'SEEBAL_AUTH_STATUS') {
      result = await ipcRenderer.invoke('auth:status');
      window.postMessage({ type: 'SEEBAL_AUTH_STATUS_RESPONSE', requestId, result }, '*');
      return;
    }

    if (data.type === 'SEEBAL_AUTH_LOGIN') {
      result = await ipcRenderer.invoke('auth:login');
      window.postMessage({ type: 'SEEBAL_AUTH_LOGIN_RESPONSE', requestId, result }, '*');
      return;
    }

    if (data.type === 'SEEBAL_AUTH_LOGOUT') {
      result = await ipcRenderer.invoke('logout');
      window.postMessage({ type: 'SEEBAL_AUTH_LOGOUT_RESPONSE', requestId, result }, '*');
      return;
    }

    if (data.type === 'SEEBAL_FEED_REQUEST') {
      if (data.userId || data.username) {
        // Load profile reels
        result = await ipcRenderer.invoke('profile:user-reels', {
          userId: data.userId || '',
          username: data.username || ''
        }, data.cursor || '');
      } else {
        result = await ipcRenderer.invoke('feed:recommendations', data.cursor || '');
      }
      window.postMessage({ type: 'SEEBAL_FEED_REQUEST_RESPONSE', requestId, result }, '*');
      return;
    }

    if (data.type === 'SEEBAL_GET_USER_INFO') {
      result = await ipcRenderer.invoke('profile:user-info', data.username || '');
      window.postMessage({ type: 'SEEBAL_GET_USER_INFO_RESPONSE', requestId, result }, '*');
      return;
    }

    if (data.type === 'SEEBAL_GET_SAVED_ACCOUNTS') {
      result = await ipcRenderer.invoke('get-saved-accounts');
      window.postMessage({ type: 'SEEBAL_GET_SAVED_ACCOUNTS_RESPONSE', requestId, result }, '*');
      return;
    }

    if (data.type === 'SEEBAL_SAVE_ACCOUNT') {
      result = await ipcRenderer.invoke('save-account', data.account || {});
      window.postMessage({ type: 'SEEBAL_SAVE_ACCOUNT_RESPONSE', requestId, result }, '*');
      return;
    }

    if (data.type === 'SEEBAL_REMOVE_ACCOUNT') {
      result = await ipcRenderer.invoke('remove-account', data.username || '');
      window.postMessage({ type: 'SEEBAL_REMOVE_ACCOUNT_RESPONSE', requestId, result }, '*');
      return;
    }

  } catch (error) {
    window.postMessage({
      type: data.type + '_RESPONSE',
      requestId,
      error: error.message || String(error)
    }, '*');
  }
});
