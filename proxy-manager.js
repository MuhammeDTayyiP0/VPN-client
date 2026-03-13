const { execSync } = require('child_process');

class ProxyManager {
    constructor() {
        this.originalProxy = null;
        this.enabled = false;
    }

    async enable(socksPort = 10808) {
        const httpPort = socksPort + 1; // 10809

        if (process.platform === 'win32') {
            await this.enableWindows(httpPort);
        } else {
            await this.enableLinux(socksPort, httpPort);
        }

        this.enabled = true;
    }

    async disable(force = false) {
        if (!this.enabled && !force) return;

        if (process.platform === 'win32') {
            await this.disableWindows();
        } else {
            await this.disableLinux();
        }

        this.enabled = false;
    }

    // ─── WINDOWS ──────────────────────────────────────────────────

    async enableWindows(httpPort) {
        const proxyServer = `127.0.0.1:${httpPort}`;
        const bypass = 'localhost;127.*;10.*;192.168.*;<local>';

        try {
            // Save current state
            try {
                const current = execSync(
                    'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
                    { encoding: 'utf8', windowsHide: true }
                );
                this.originalProxy = current.includes('0x1') ? 'enabled' : 'disabled';
            } catch (e) {
                this.originalProxy = 'disabled';
            }

            // Enable proxy
            execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`, { windowsHide: true });
            execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "${proxyServer}" /f`, { windowsHide: true });
            execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "${bypass}" /f`, { windowsHide: true });

            // Notify system of change
            try {
                execSync(`powershell -Command "[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy('http://${proxyServer}')"`, { windowsHide: true });
            } catch (e) { /* ignore */ }

            console.log(`[Proxy] Windows proxy enabled: ${proxyServer}`);
        } catch (e) {
            console.error('[Proxy] Windows proxy enable failed:', e.message);
        }
    }

    async disableWindows() {
        try {
            execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`, { windowsHide: true });

            console.log('[Proxy] Windows proxy disabled.');
        } catch (e) {
            console.error('[Proxy] Windows proxy disable failed:', e.message);
        }
    }

    // ─── LINUX ────────────────────────────────────────────────────

    async enableLinux(socksPort, httpPort) {
        try {
            // Check for GNOME (gsettings)
            execSync('which gsettings', { stdio: 'pipe' });

            execSync(`gsettings set org.gnome.system.proxy mode 'manual'`, { stdio: 'pipe' });
            execSync(`gsettings set org.gnome.system.proxy.socks host '127.0.0.1'`, { stdio: 'pipe' });
            execSync(`gsettings set org.gnome.system.proxy.socks port ${socksPort}`, { stdio: 'pipe' });
            execSync(`gsettings set org.gnome.system.proxy.http host '127.0.0.1'`, { stdio: 'pipe' });
            execSync(`gsettings set org.gnome.system.proxy.http port ${httpPort}`, { stdio: 'pipe' });
            execSync(`gsettings set org.gnome.system.proxy.https host '127.0.0.1'`, { stdio: 'pipe' });
            execSync(`gsettings set org.gnome.system.proxy.https port ${httpPort}`, { stdio: 'pipe' });

            console.log(`[Proxy] Linux (GNOME) proxy enabled.`);
        } catch (e) {
            // Try KDE
            try {
                execSync('which kwriteconfig5', { stdio: 'pipe' });
                execSync(`kwriteconfig5 --file kioslaverc --group "Proxy Settings" --key ProxyType 1`, { stdio: 'pipe' });
                execSync(`kwriteconfig5 --file kioslaverc --group "Proxy Settings" --key socksProxy "socks://127.0.0.1:${socksPort}"`, { stdio: 'pipe' });
                execSync(`kwriteconfig5 --file kioslaverc --group "Proxy Settings" --key httpProxy "http://127.0.0.1:${httpPort}"`, { stdio: 'pipe' });
                execSync(`kwriteconfig5 --file kioslaverc --group "Proxy Settings" --key httpsProxy "http://127.0.0.1:${httpPort}"`, { stdio: 'pipe' });

                console.log(`[Proxy] Linux (KDE) proxy enabled.`);
            } catch (e2) {
                console.log('[Proxy] Linux: Could not detect desktop environment for proxy. Using env vars only.');
            }
        }
    }

    async disableLinux() {
        try {
            execSync('which gsettings', { stdio: 'pipe' });
            execSync(`gsettings set org.gnome.system.proxy mode 'none'`, { stdio: 'pipe' });
            console.log('[Proxy] Linux (GNOME) proxy disabled.');
        } catch (e) {
            try {
                execSync('which kwriteconfig5', { stdio: 'pipe' });
                execSync(`kwriteconfig5 --file kioslaverc --group "Proxy Settings" --key ProxyType 0`, { stdio: 'pipe' });
                console.log('[Proxy] Linux (KDE) proxy disabled.');
            } catch (e2) {
                console.log('[Proxy] Linux: Could not disable proxy.');
            }
        }
    }
}

module.exports = ProxyManager;
