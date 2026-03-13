const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
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
        if (fs.existsSync(binPath)) {
            return { exists: true, path: binPath };
        }

        // Download sing-box
        return await this.downloadBinary();
    }

    async downloadBinary() {
        const binDir = this.getBinDir();
        fs.mkdirSync(binDir, { recursive: true });

        const version = '1.11.0';
        const platform = process.platform === 'win32' ? 'windows' : 'linux';
        const arch = process.arch === 'x64' ? 'amd64' : process.arch;
        const ext = process.platform === 'win32' ? '.zip' : '.tar.gz';
        const fileName = `sing-box-${version}-${platform}-${arch}`;
        const url = `https://github.com/SagerNet/sing-box/releases/download/v${version}/${fileName}${ext}`;

        const downloadPath = path.join(binDir, `sing-box${ext}`);

        return new Promise((resolve, reject) => {
            console.log(`[VPN Engine] Downloading sing-box from ${url}`);

            const download = (downloadUrl, redirectCount = 0) => {
                if (redirectCount > 5) return reject(new Error('Too many redirects'));

                const client = downloadUrl.startsWith('https') ? https : http;
                client.get(downloadUrl, (response) => {
                    if (response.statusCode === 302 || response.statusCode === 301) {
                        return download(response.headers.location, redirectCount + 1);
                    }

                    if (response.statusCode !== 200) {
                        return reject(new Error(`Download failed: ${response.statusCode}`));
                    }

                    const file = fs.createWriteStream(downloadPath);
                    response.pipe(file);

                    file.on('finish', () => {
                        file.close();
                        try {
                            this.extractBinary(downloadPath, binDir, fileName);
                            // Clean up archive
                            try { fs.unlinkSync(downloadPath); } catch (e) { /* ignore */ }
                            console.log('[VPN Engine] sing-box downloaded and extracted.');
                            resolve({ exists: true, path: this.getBinPath() });
                        } catch (e) {
                            reject(new Error('Extract failed: ' + e.message));
                        }
                    });
                }).on('error', reject);
            };

            download(url);
        });
    }

    extractBinary(archivePath, targetDir, innerDir) {
        const isWin = process.platform === 'win32';
        const finalBinPath = path.join(targetDir, isWin ? 'sing-box.exe' : 'sing-box');

        if (isWin) {
            // Use PowerShell to extract zip on Windows
            const { execSync } = require('child_process');
            const tempExtract = path.join(targetDir, '_extract');
            fs.mkdirSync(tempExtract, { recursive: true });

            console.log('[VPN Engine] Extracting zip via PowerShell...');
            execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tempExtract}' -Force"`, {
                windowsHide: true
            });

            // Find and move the binary
            const extractedBin = path.join(tempExtract, innerDir, 'sing-box.exe');
            if (fs.existsSync(extractedBin)) {
                fs.copyFileSync(extractedBin, finalBinPath);
            } else {
                throw new Error(`Extraction failed: ${extractedBin} not found in archive.`);
            }

            // Clean up
            fs.rmSync(tempExtract, { recursive: true, force: true });
        } else {
            // Use tar on Linux
            const { execSync } = require('child_process');
            execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, { stdio: 'pipe' });

            const extractedBin = path.join(targetDir, innerDir, 'sing-box');
            if (fs.existsSync(extractedBin)) {
                fs.copyFileSync(extractedBin, finalBinPath);
                fs.chmodSync(finalBinPath, '755');
            } else {
                throw new Error(`Extraction failed: ${extractedBin} not found in archive.`);
            }

            // Clean inner dir
            const innerPath = path.join(targetDir, innerDir);
            if (fs.existsSync(innerPath)) {
                fs.rmSync(innerPath, { recursive: true, force: true });
            }
        }
        
        // Final sanity check
        if (!fs.existsSync(finalBinPath)) {
            throw new Error(`Critical error: target binary not found at ${finalBinPath} after extraction.`);
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
                        detour: "proxy"
                    },
                    {
                        tag: "local-dns",
                        address: "local"
                    }
                ],
                rules: [
                    {
                        outbound: ["any"],
                        server: "local-dns"
                    }
                ]
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
                    insecure: false,
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
                    insecure: false,
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
                    insecure: false,
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

            const outbound = {
                type: "shadowsocks",
                tag: "proxy",
                server: host,
                server_port: port,
                method: method,
                password: password,
            };

            return outbound;
        } catch (e) {
            console.error('[VPN Engine] Failed to parse Shadowsocks link:', e.message);
            return null;
        }
    }
}

module.exports = VpnEngine;
