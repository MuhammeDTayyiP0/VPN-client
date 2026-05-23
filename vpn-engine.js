const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class VpnEngine {
    constructor() {
        this.process = null;
        this.connected = false;
        this.currentLink = null;
        this.socksPort = 10808;
        this.httpPort = 10809;
        this.configPath = path.join(this.getDataDir(), 'client-config.json');
    }

    getDataDir() {
        try {
            return path.join(app.getPath('userData'), 'vpn-data');
        } catch (e) {
            return path.join(process.env.APPDATA || process.env.HOME || '.', 'vpn-client-data');
        }
    }

    getBinDir() {
        return path.join(this.getDataDir(), 'bin');
    }

    getBinPath() {
        const binName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
        return path.join(this.getBinDir(), binName);
    }

    /**
     * Get the path to the bundled sing-box binary inside app resources.
     * In production: process.resourcesPath/singbox/sing-box[.exe]
     * In dev: falls back to build/singbox/<platform>/sing-box[.exe]
     */
    getBundledBinPath() {
        const binName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
        const platform = process.platform === 'win32' ? 'win' : 'linux';

        // Production (packaged app)
        if (process.resourcesPath) {
            const resourcePath = path.join(process.resourcesPath, 'singbox', binName);
            if (fs.existsSync(resourcePath)) {
                return resourcePath;
            }
        }

        // Dev mode fallback — look in build/singbox/<platform>/
        const devPath = path.join(__dirname, 'build', 'singbox', platform, binName);
        if (fs.existsSync(devPath)) {
            return devPath;
        }

        return null;
    }

    getSocksPort() {
        return this.socksPort;
    }

    getStatus() {
        return {
            connected: this.connected,
            currentLink: this.currentLink,
        };
    }

    // ─── BINARY MANAGEMENT ────────────────────────────────────────

    async ensureBinary() {
        const binPath = this.getBinPath();

        // Already copied to user data dir
        if (fs.existsSync(binPath)) {
            return { exists: true, path: binPath };
        }

        // Copy from bundled resources
        const bundledPath = this.getBundledBinPath();
        if (!bundledPath) {
            return {
                exists: false,
                error: 'sing-box binary bulunamadı. Uygulama düzgün yüklenmemiş olabilir — lütfen yeniden yükleyin.'
            };
        }

        try {
            const binDir = this.getBinDir();
            fs.mkdirSync(binDir, { recursive: true });
            fs.copyFileSync(bundledPath, binPath);

            // Set execute permission on Linux
            if (process.platform !== 'win32') {
                fs.chmodSync(binPath, '755');
            }

            console.log(`[VPN Engine] Bundled binary copied: ${bundledPath} → ${binPath}`);
            return { exists: true, path: binPath };
        } catch (err) {
            console.error('[VPN Engine] Failed to copy bundled binary:', err);
            return {
                exists: false,
                error: 'sing-box kopyalanamadı: ' + err.message
            };
        }
    }

    // ─── CONNECTION ───────────────────────────────────────────────

    async connect(protocolLink) {
        if (this.connected) {
            await this.disconnect();
        }

        // Ensure binary exists
        const binCheck = await this.ensureBinary();
        if (!binCheck.exists) {
            return { error: 'sing-box binary not found' };
        }

        // Parse the link and generate config
        const config = this.generateClientConfig(protocolLink);
        if (!config) {
            return { error: 'Invalid protocol link' };
        }

        // Save config
        const dataDir = this.getDataDir();
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));

        // Start sing-box
        return new Promise((resolve) => {
            const binPath = this.getBinPath();
            const args = ['run', '-c', this.configPath];

            console.log(`[VPN Engine] Starting: ${binPath} ${args.join(' ')}`);

            this.process = spawn(binPath, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });

            let startupOutput = '';

            this.process.stdout.on('data', (data) => {
                startupOutput += data.toString();
                console.log('[sing-box stdout]', data.toString().trim());
            });

            this.process.stderr.on('data', (data) => {
                startupOutput += data.toString();
                console.log('[sing-box stderr]', data.toString().trim());
            });

            this.process.on('error', (err) => {
                console.error('[VPN Engine] Process error:', err.message);
                this.connected = false;
                this.process = null;
                resolve({ error: 'Failed to start: ' + err.message });
            });

            this.process.on('close', (code) => {
                console.log(`[VPN Engine] sing-box exited with code ${code}`);
                this.connected = false;
                this.process = null;
            });

            // Wait a bit and check if process is still running
            setTimeout(() => {
                if (this.process && !this.process.killed) {
                    this.connected = true;
                    this.currentLink = protocolLink;
                    resolve({ success: true });
                } else {
                    resolve({ error: 'Process exited early. ' + startupOutput.substring(0, 200) });
                }
            }, 2000);
        });
    }

    async disconnect() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        this.connected = false;
        this.currentLink = null;
    }

    async findFastest(links) {
        if (!links || links.length === 0) return null;
        
        const net = require('net');
        
        const tests = links.map(linkObj => {
            return new Promise((resolve, reject) => {
                const config = this.generateClientConfig(linkObj.link);
                if (!config || !config.outbounds || !config.outbounds[0]) return reject(new Error('Invalid link'));
                
                const outbound = config.outbounds[0];
                if (!outbound.server || !outbound.server_port) return reject(new Error('No server info'));
                
                const socket = new net.Socket();
                let isResolved = false;
                
                socket.setTimeout(3000); // 3 seconds timeout
                
                socket.on('connect', () => {
                    if (!isResolved) {
                        isResolved = true;
                        socket.destroy();
                        resolve(linkObj);
                    }
                });
                
                socket.on('error', (err) => {
                    if (!isResolved) {
                        isResolved = true;
                        socket.destroy();
                        reject(err);
                    }
                });
                
                socket.on('timeout', () => {
                    if (!isResolved) {
                        isResolved = true;
                        socket.destroy();
                        reject(new Error('Timeout'));
                    }
                });
                
                socket.connect(outbound.server_port, outbound.server);
            });
        });
        
        try {
            return await Promise.any(tests);
        } catch (e) {
            console.error('[VPN Engine] All latency tests failed.');
            return null;
        }
    }

    // ─── CONFIG GENERATION ────────────────────────────────────────

    generateClientConfig(link) {
        if (!link) return null;

        let outbound = null;

        if (link.startsWith('vless://')) {
            outbound = this.parseVlessLink(link);
        } else if (link.startsWith('vmess://')) {
            outbound = this.parseVmessLink(link);
        } else if (link.startsWith('trojan://')) {
            outbound = this.parseTrojanLink(link);
        } else if (link.startsWith('ss://')) {
            outbound = this.parseShadowsocksLink(link);
        }

        if (!outbound) return null;

        return {
            log: {
                level: "info",
                timestamp: true
            },
            dns: {
                servers: [
                    {
                        tag: "remote-dns",
                        address: "https://1.1.1.1/dns-query",
                        address_resolver: "local-dns",
                        detour: "proxy"
                    },
                    {
                        tag: "local-dns",
                        address: "https://1.1.1.1/dns-query",
                        detour: "direct"
                    }
                ],
                rules: [
                    {
                        outbound: ["any"],
                        server: "local-dns"
                    }
                ],
                strategy: "prefer_ipv4"
            },
            inbounds: [
                {
                    type: "mixed",
                    tag: "mixed-in",
                    listen: "127.0.0.1",
                    listen_port: this.httpPort
                },
                {
                    type: "socks",
                    tag: "socks-in",
                    listen: "127.0.0.1",
                    listen_port: this.socksPort
                }
            ],
            outbounds: [
                outbound,
                { type: "direct", tag: "direct" },
                { type: "block", tag: "block" },
                { type: "dns", tag: "dns-out" }
            ],
            route: {
                rules: [
                    {
                        protocol: "dns",
                        outbound: "dns-out"
                    },
                    {
                        ip_is_private: true,
                        outbound: "direct"
                    }
                ],
                final: "proxy",
                auto_detect_interface: true
            }
        };
    }

    parseVlessLink(link) {
        try {
            // vless://uuid@host:port?params#label
            const url = new URL(link);
            const uuid = url.username;
            const host = url.hostname;
            const port = parseInt(url.port) || 443;
            const params = Object.fromEntries(url.searchParams);

            const outbound = {
                type: "vless",
                tag: "proxy",
                server: host,
                server_port: port,
                uuid: uuid,
            };

            if (params.security === 'tls') {
                outbound.tls = {
                    enabled: true,
                    server_name: params.sni || host,
                    insecure: true,
                };
            }

            if (params.type === 'ws') {
                outbound.transport = {
                    type: "ws",
                    path: decodeURIComponent(params.path || '/'),
                    headers: { Host: params.host || host }
                };
            } else if (params.type === 'grpc') {
                outbound.transport = {
                    type: "grpc",
                    service_name: params.serviceName || ''
                };
            } else if (params.type === 'httpupgrade') {
                outbound.transport = {
                    type: "httpupgrade",
                    path: decodeURIComponent(params.path || '/'),
                    host: params.host || host
                };
            }

            return outbound;
        } catch (e) {
            console.error('[VPN Engine] Failed to parse VLESS link:', e.message);
            return null;
        }
    }

    parseVmessLink(link) {
        try {
            const b64 = link.replace('vmess://', '');
            const json = JSON.parse(Buffer.from(b64, 'base64').toString());

            const outbound = {
                type: "vmess",
                tag: "proxy",
                server: json.add,
                server_port: parseInt(json.port) || 443,
                uuid: json.id,
                security: json.scy || 'auto',
                alter_id: parseInt(json.aid) || 0,
            };

            if (json.tls === 'tls') {
                outbound.tls = {
                    enabled: true,
                    server_name: json.sni || json.add,
                    insecure: true,
                };
            }

            if (json.net === 'ws') {
                outbound.transport = {
                    type: "ws",
                    path: json.path || '/',
                    headers: { Host: json.host || json.add }
                };
            } else if (json.net === 'grpc') {
                outbound.transport = {
                    type: "grpc",
                    service_name: json.path || ''
                };
            }

            return outbound;
        } catch (e) {
            console.error('[VPN Engine] Failed to parse VMess link:', e.message);
            return null;
        }
    }

    parseTrojanLink(link) {
        try {
            const url = new URL(link);
            const password = decodeURIComponent(url.username);
            const host = url.hostname;
            const port = parseInt(url.port) || 443;
            const params = Object.fromEntries(url.searchParams);

            const outbound = {
                type: "trojan",
                tag: "proxy",
                server: host,
                server_port: port,
                password: password,
            };

            if (params.security === 'tls' || !params.security) {
                outbound.tls = {
                    enabled: true,
                    server_name: params.sni || host,
                    insecure: true,
                };
            }

            if (params.type === 'ws') {
                outbound.transport = {
                    type: "ws",
                    path: decodeURIComponent(params.path || '/'),
                    headers: { Host: params.host || host }
                };
            } else if (params.type === 'grpc') {
                outbound.transport = {
                    type: "grpc",
                    service_name: params.serviceName || ''
                };
            }

            return outbound;
        } catch (e) {
            console.error('[VPN Engine] Failed to parse Trojan link:', e.message);
            return null;
        }
    }

    parseShadowsocksLink(link) {
        try {
            // ss://base64(method:password)@host:port?params#label
            const url = new URL(link);
            const host = url.hostname;
            const port = parseInt(url.port) || 443;
            const userInfo = Buffer.from(url.username, 'base64').toString();
            const [method, ...passwordParts] = userInfo.split(':');
            const password = passwordParts.join(':');
            const params = Object.fromEntries(url.searchParams);

            const outbound = {
                type: "shadowsocks",
                tag: "proxy",
                server: host,
                server_port: port,
                method: method,
                password: password,
            };

            // If it's a plugin link (like v2ray-plugin for WebSocket), use multiplexing
            if (params.plugin && params.plugin.includes('v2ray-plugin')) {
                outbound.multiplex = {
                    enabled: true,
                    padding: true
                };
            }

            return outbound;
        } catch (e) {
            console.error('[VPN Engine] Failed to parse Shadowsocks link:', e.message);
            return null;
        }
    }
}

module.exports = VpnEngine;
