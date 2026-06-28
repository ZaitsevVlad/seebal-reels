const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  authStatus: () => ipcRenderer.invoke('auth:status'),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('logout'),
  getRecommendations: (cursor) => ipcRenderer.invoke('feed:recommendations', cursor),
  getUserInfo: (username) => ipcRenderer.invoke('profile:user-info', username),
  getUserReels: (userId, cursor) => ipcRenderer.invoke('profile:user-reels', userId, cursor),
  selectDownloadFolder: () => ipcRenderer.invoke('downloads:select-folder'),
  getDownloadFolder: () => ipcRenderer.invoke('downloads:get-folder'),
  downloadReel: (reel) => ipcRenderer.invoke('downloads:reel', reel),
  openDebugLog: () => ipcRenderer.invoke('debug:open-log'),
  proxyAvatar: (url) => ipcRenderer.invoke('proxy-avatar', url),
  getSavedAccounts: () => ipcRenderer.invoke('get-saved-accounts'),
  saveAccount: (account) => ipcRenderer.invoke('save-account', account),
  removeAccount: (username) => ipcRenderer.invoke('remove-account', username)
});
