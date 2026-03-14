const http = require('http');
const https = require('https');
const { shell, app } = require('electron');
const fs = require('fs');
const path = require('path');

// Simple JSON file store (CommonJS compatible)
class SimpleStore {
    constructor(name) {
        this.name = name;
        this.data = {};
        this._load();
    }

    _getPath() {
        try {
            return path.join(app.getPath('userData'), `${this.name}.json`);
        } catch (e) {
            return path.join(process.env.APPDATA || process.env.HOME || '.', `${this.name}.json`);
        }
    }

    _load() {
        try {
            const raw = fs.readFileSync(this._getPath(), 'utf8');
            this.data = JSON.parse(raw);
        } catch (e) {
            this.data = {};
        }
    }

    _save() {
        try {
            const dir = path.dirname(this._getPath());
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this._getPath(), JSON.stringify(this.data, null, 2));
        } catch (e) { /* ignore */ }
    }

    get(key, defaultVal = null) {
        return this.data[key] !== undefined ? this.data[key] : defaultVal;
    }

    set(key, value) {
        this.data[key] = value;
        this._save();
    }

    delete(key) {
        delete this.data[key];
        this._save();
    }
}

const store = new SimpleStore('vpn-client-auth');

const DEFAULT_SERVER_URL = 'https://vpn2.geldesat.com';

class Auth {
    constructor() {
        this.callbackServer = null;
    }

    getServerUrl() {
        return DEFAULT_SERVER_URL;
    }

    setServerUrl(url) {
        // Ignored, server URL is fixed
    }

    getToken() {
        return store.get('jwt_token', null);
    }

    setToken(token) {
        store.set('jwt_token', token);
    }

    getUserData() {
        return store.get('user_data', null);
    }

    setUserData(data) {
        store.set('user_data', data);
    }

    getVpnLinks() {
        return store.get('vpn_links', []);
    }

    setVpnLinks(links) {
        store.set('vpn_links', links);
    }

    // ─── GOOGLE OAUTH ─────────────────────────────────────────────

    async loginWithGoogle() {
        return new Promise((resolve, reject) => {
            let redirectUri = '';

            // Create a local callback server
            const server = http.createServer(async (req, res) => {
                const url = new URL(req.url, `http://127.0.0.1`);

                if (url.pathname === '/callback') {
                    const code = url.searchParams.get('code');
                    const error = url.searchParams.get('error');

                    if (error) {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0e1a;color:#fff"><h2>❌ Giriş İptal Edildi</h2><p>Bu pencereyi kapatabilirsiniz.</p></body></html>');
                        cleanup();
                        reject(new Error('Login cancelled'));
                        return;
                    }

                    if (code) {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0e1a;color:#fff"><h2>✅ Giriş Başarılı!</h2><p>Bu pencereyi kapatabilirsiniz.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>');

                        try {
                            const result = await this.exchangeCodeWithServer(code, redirectUri);
                            cleanup();
                            resolve(result);
                        } catch (e) {
                            cleanup();
                            reject(e);
                        }
                        return;
                    }
                }

                res.writeHead(404);
                res.end('Not Found');
            });

            const cleanup = () => {
                if (this.callbackServer) {
                    try {
                        this.callbackServer.close();
                        this.callbackServer = null;
                    } catch (e) { /* ignore */ }
                }
            };

            // Explicitly bind to 127.0.0.1 (to avoid IPv6 ::1 issues on Windows)
            server.listen(0, '127.0.0.1', async () => {
                const port = server.address().port;
                this.callbackServer = server;

                redirectUri = `http://127.0.0.1:${port}/callback`;
                let googleClientId = await this.getGoogleClientId();

                const loginUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                    `client_id=${googleClientId}&` +
                    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
                    `response_type=code&` +
                    `scope=email%20profile&` +
                    `access_type=offline&` +
                    `prompt=consent`;

                console.log(`[Auth] Opening Google OAuth at port ${port}`);
                shell.openExternal(loginUrl);

                setTimeout(() => {
                    cleanup();
                    reject(new Error('Login timeout: 5 minutes passed without completion.'));
                }, 300000);
            });

            server.on('error', (err) => {
                reject(new Error('Could not start callback server: ' + err.message));
            });
        });
    }

    async exchangeCodeWithServer(code, redirectUri) {
        console.log('[Auth] Delegating code exchange to backend...');
        const postData = JSON.stringify({ code, redirect_uri: redirectUri });

        return new Promise((resolve, reject) => {
            const serverUrl = new URL(this.getServerUrl());
            const client = serverUrl.protocol === 'https:' ? https : http;

            const req = client.request(new URL('/api/auth/google', serverUrl), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                },
                timeout: 15000 // Match server timeout
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            if (json.token) {
                                this.setToken(json.token);
                                this.setUserData(json.user);
                                this.setVpnLinks(json.vpn_links || []);
                            }
                            resolve(json);
                        } else {
                            reject(new Error(json.error || `Server error: ${res.statusCode}`));
                        }
                    } catch (e) {
                        reject(new Error('Failed to parse server response'));
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Sunucu Yanıt Vermedi (Timeout). Sunucu internete veya Google API\'ye erişemiyor olabilir.'));
            });

            req.on('error', (err) => {
                reject(new Error('Bağlantı hatası: ' + err.message));
            });

            req.write(postData);
            req.end();
        });
    }

    async getGoogleClientId() {
        console.log('[Auth] Fetching public Client ID from server...');
        const serverUrl = new URL(this.getServerUrl());
        const client = serverUrl.protocol === 'https:' ? https : http;
        const url = new URL('/api/auth/google/client-id', serverUrl);

        return new Promise((resolve, reject) => {
            const req = client.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.client_id) {
                            resolve(json.client_id);
                        } else {
                            // Fallback to the known public ID if server doesn't provide it
                            resolve('146687277982-l8bgn63g8cn7k9r2h3jum36m69m8pgaq.apps.googleusercontent.com');
                        }
                    } catch (e) {
                        resolve('146687277982-l8bgn63g8cn7k9r2h3jum36m69m8pgaq.apps.googleusercontent.com');
                    }
                });
            });
            req.on('error', () => {
                resolve('146687277982-l8bgn63g8cn7k9r2h3jum36m69m8pgaq.apps.googleusercontent.com');
            });
            req.end();
        });
    }

    // ─── SESSION ──────────────────────────────────────────────────

    async getSession() {
        const token = this.getToken();
        if (!token) return null;

        const serverUrl = this.getServerUrl();
        const url = new URL('/api/auth/me', serverUrl);

        return new Promise((resolve) => {
            const client = url.protocol === 'https:' ? https : http;

            const req = client.request(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                timeout: 10000,
                rejectUnauthorized: false,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.user) {
                            this.setUserData(json.user);
                            this.setVpnLinks(json.vpn_links || []);
                            resolve({
                                user: json.user,
                                vpn_links: json.vpn_links
                            });
                        } else {
                            // Token invalid
                            this.setToken(null);
                            resolve(null);
                        }
                    } catch (e) {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => {
                // Offline — return cached data
                const user = this.getUserData();
                const links = this.getVpnLinks();
                if (user) {
                    resolve({ user, vpn_links: links });
                } else {
                    resolve(null);
                }
            });

            req.on('timeout', () => {
                req.destroy();
                const user = this.getUserData();
                const links = this.getVpnLinks();
                resolve(user ? { user, vpn_links: links } : null);
            });

            req.end();
        });
    }

    // ─── USAGE ────────────────────────────────────────────────────

    async getUsage() {
        const token = this.getToken();
        if (!token) return null;

        const serverUrl = this.getServerUrl();
        const url = new URL('/api/client/usage', serverUrl);

        return new Promise((resolve) => {
            const client = url.protocol === 'https:' ? https : http;

            const req = client.request(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                timeout: 10000,
                rejectUnauthorized: false,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
        });
    }

    // ─── LOGOUT ───────────────────────────────────────────────────

    async logout() {
        store.delete('jwt_token');
        store.delete('user_data');
        store.delete('vpn_links');
    }
}

module.exports = Auth;
