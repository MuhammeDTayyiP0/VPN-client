const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Window controls
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    getPlatform: () => ipcRenderer.invoke('app:platform'),
    getVersion: () => ipcRenderer.invoke('app:version'),

    // Auth
    loginWithGoogle: () => ipcRenderer.invoke('auth:login-google'),
    getSession: () => ipcRenderer.invoke('auth:get-session'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    getServerUrl: () => ipcRenderer.invoke('auth:get-server-url'),
    setServerUrl: (url) => ipcRenderer.invoke('auth:set-server-url', url),

    // VPN
    vpnConnect: (protocolLink) => ipcRenderer.invoke('vpn:connect', protocolLink),
    vpnDisconnect: () => ipcRenderer.invoke('vpn:disconnect'),
    vpnStatus: () => ipcRenderer.invoke('vpn:status'),
    vpnEnsureBinary: () => ipcRenderer.invoke('vpn:ensure-binary'),
    onTraySelectProtocol: (callback) => ipcRenderer.on('tray:select-protocol', (_event, link) => callback(link)),

    // Usage
    getUsage: () => ipcRenderer.invoke('usage:get'),

    // Shell
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
});
