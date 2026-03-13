const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const VpnEngine = require('./vpn-engine');
const Auth = require('./auth');
const ProxyManager = require('./proxy-manager');

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
}

// Disable Chromium caches that cause EPERM / Access Denied issues in dev mode
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

let mainWindow = null;
let tray = null;
const vpnEngine = new VpnEngine();
const auth = new Auth();
const proxyManager = new ProxyManager();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 420,
        height: 680,
        minWidth: 420,
        maxWidth: 420,
        minHeight: 680,
        maxHeight: 680,
        frame: false,
        transparent: false,
        backgroundColor: '#0a0e1a',
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
        show: false,
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });
}

function updateTrayMenu() {
    if (!tray) return;

    const isConnected = vpnEngine && vpnEngine.connected;
    const currentStatusText = isConnected ? 'Durum: Bağlı 🟢' : 'Durum: Bağlı Değil 🔴';

    const vpnLinks = (auth && auth.getVpnLinks()) || [];
    const protocolItems = vpnLinks.map(link => {
        const isSelected = isConnected && vpnEngine.currentLink === link.link;
        return {
            label: `${isSelected ? '✓ ' : ''}${link.protocol || link.type || 'Bilinmeyen'}`,
            type: 'normal',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                    mainWindow.webContents.send('tray:select-protocol', link);
                }
            }
        };
    });

    const protocolsSubmenu = protocolItems.length > 0 ? {
        label: 'Protokoller',
        submenu: protocolItems
    } : {
        label: 'Protokoller (Yok)',
        enabled: false
    };

    const contextMenu = Menu.buildFromTemplate([
        { label: currentStatusText, enabled: false },
        { type: 'separator' },
        protocolsSubmenu,
        { type: 'separator' },
        {
            label: isConnected ? 'Bağlantıyı Kes' : 'Bağlan',
            click: async () => {
                if (isConnected) {
                    await proxyManager.disable();
                    await vpnEngine.disconnect();
                    mainWindow?.webContents.send('vpn-state-changed', 'disconnected');
                } else {
                    // Start last selected protocol logic or show window
                    mainWindow?.show();
                    mainWindow?.focus();
                    // Optional: You can implement a default connect mechanism here later
                }
                updateTrayMenu();
            }
        },
        { type: 'separator' },
        {
            label: 'Göster',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        },
        {
            label: 'Çıkış',
            click: async () => {
                app.isQuitting = true;
                await performCleanup();
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);
}

function createTray() {
    const iconPath = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
    let trayIcon;
    try {
        trayIcon = nativeImage.createFromPath(iconPath);
        trayIcon = trayIcon.resize({ width: 16, height: 16 });
    } catch (e) {
        trayIcon = nativeImage.createEmpty();
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('VPN Client');
    
    updateTrayMenu();

    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// ─── IPC: WINDOW CONTROLS ──────────────────────────────────────────

ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
});

ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow?.maximize();
    }
});

ipcMain.handle('window:close', () => {
    mainWindow?.hide();
});

ipcMain.handle('app:platform', () => {
    return process.platform;
});

ipcMain.handle('app:version', () => {
    return app.getVersion();
});

// ─── IPC: AUTH ─────────────────────────────────────────────────────

ipcMain.handle('auth:login-google', async () => {
    try {
        const result = await auth.loginWithGoogle();
        return result;
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('auth:get-session', async () => {
    try {
        return await auth.getSession();
    } catch (e) {
        return null;
    }
});

ipcMain.handle('auth:logout', async () => {
    await auth.logout();
    return { success: true };
});

ipcMain.handle('auth:get-server-url', () => {
    return auth.getServerUrl();
});

ipcMain.handle('auth:set-server-url', (event, url) => {
    auth.setServerUrl(url);
    return { success: true };
});

// ─── IPC: VPN ──────────────────────────────────────────────────────

ipcMain.handle('vpn:connect', async (event, protocolLink) => {
    try {
        const token = auth.getToken();
        if (!token) return { error: 'Giriş yapılmamış' };

        const result = await vpnEngine.connect(protocolLink);
        if (result.success) {
            await proxyManager.enable(vpnEngine.getSocksPort());
            updateTrayMenu();
        }
        return result;
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('vpn:disconnect', async () => {
    try {
        await proxyManager.disable();
        await vpnEngine.disconnect();
        updateTrayMenu();
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('vpn:status', () => {
    return vpnEngine.getStatus();
});

ipcMain.handle('vpn:ensure-binary', async () => {
    try {
        return await vpnEngine.ensureBinary();
    } catch (e) {
        return { error: e.message };
    }
});

// ─── IPC: USAGE ────────────────────────────────────────────────────

ipcMain.handle('usage:get', async () => {
    try {
        return await auth.getUsage();
    } catch (e) {
        return null;
    }
});

// ─── IPC: OPEN EXTERNAL ────────────────────────────────────────────

ipcMain.handle('shell:open-external', (event, url) => {
    shell.openExternal(url);
});

// ─── APP LIFECYCLE ─────────────────────────────────────────────────

app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
});

app.whenReady().then(async () => {
    // Disable default application menu to prevent browser shortcuts (Ctrl+R, F5, etc.)
    Menu.setApplicationMenu(null);

    console.log('[App] Starting up, performing safety cleanup...');
    try {
        // Clear any stuck proxy from a previous crash
        await proxyManager.disable(true);
        await vpnEngine.disconnect();
    } catch (e) {
        console.error('[App] Cleanup on startup failed:', e);
    }
    
    createWindow();
    createTray();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        // Don't quit, stay in tray
    }
});

const performCleanup = async () => {
    console.log('[App] Performing shutdown cleanup...');
    try {
        await proxyManager.disable();
        await vpnEngine.disconnect();
    } catch (e) {
        console.error('[App] Shutdown cleanup failed:', e);
    }
};

app.on('before-quit', async (event) => {
    if (!app.isQuitting) {
        app.isQuitting = true;
        event.preventDefault();
        await performCleanup();
        app.quit();
    }
});

// Handle unexpected crashes
process.on('uncaughtException', async (error) => {
    console.error('[App] Uncaught Exception:', error);
    await performCleanup();
    process.exit(1);
});

process.on('SIGINT', async () => {
    await performCleanup();
    app.quit();
});

process.on('SIGTERM', async () => {
    await performCleanup();
    app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    } else {
        mainWindow.show();
    }
});
