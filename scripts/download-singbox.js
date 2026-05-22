/**
 * Build-time script: Download sing-box binary for bundling into the Electron app.
 * 
 * Usage:
 *   node scripts/download-singbox.js              (auto-detect current platform)
 *   node scripts/download-singbox.js --win        (download Windows binary)
 *   node scripts/download-singbox.js --linux      (download Linux binary)
 *   node scripts/download-singbox.js --all        (download both)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const VERSION = '1.13.12';
const OUTPUT_DIR = path.join(__dirname, '..', 'build', 'singbox');

function getPlatformTargets() {
    const arg = process.argv[2];
    if (arg === '--all') return ['win', 'linux'];
    if (arg === '--win') return ['win'];
    if (arg === '--linux') return ['linux'];
    // Auto-detect
    return [process.platform === 'win32' ? 'win' : 'linux'];
}

function download(url) {
    return new Promise((resolve, reject) => {
        const follow = (downloadUrl, redirectCount = 0) => {
            if (redirectCount > 5) return reject(new Error('Too many redirects'));

            const isHttps = downloadUrl.startsWith('https');
            const client = isHttps ? https : http;

            client.get(downloadUrl, {
                headers: { 'User-Agent': 'vpn-client-build/1.0' },
                rejectUnauthorized: false,
            }, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return follow(res.headers.location, redirectCount + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} for ${downloadUrl}`));
                }
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            }).on('error', reject);
        };
        follow(url);
    });
}

async function downloadForPlatform(platform) {
    const arch = 'amd64';
    const ext = platform === 'win' ? '.zip' : '.tar.gz';
    const binName = platform === 'win' ? 'sing-box.exe' : 'sing-box';
    const githubPlatform = platform === 'win' ? 'windows' : 'linux';
    const fileName = `sing-box-${VERSION}-${githubPlatform}-${arch}`;
    const url = `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${fileName}${ext}`;

    const platformDir = path.join(OUTPUT_DIR, platform);
    const finalBinPath = path.join(platformDir, binName);

    // Skip if already exists
    if (fs.existsSync(finalBinPath)) {
        const stats = fs.statSync(finalBinPath);
        if (stats.size > 1000000) {
            console.log(`  ✓ ${platform}/${binName} already exists (${(stats.size / 1024 / 1024).toFixed(1)} MB), skipping.`);
            return;
        }
    }

    fs.mkdirSync(platformDir, { recursive: true });

    console.log(`  ⬇ Downloading ${url} ...`);
    const data = await download(url);
    console.log(`    Downloaded ${(data.length / 1024 / 1024).toFixed(1)} MB`);

    // Write archive to temp file
    const archivePath = path.join(platformDir, `sing-box${ext}`);
    fs.writeFileSync(archivePath, data);

    // Extract
    const tempDir = path.join(platformDir, '_extract_tmp');
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });

    console.log(`  📦 Extracting...`);
    if (platform === 'win') {
        try {
            execSync(`tar -xf "${archivePath}" -C "${tempDir}"`, { stdio: 'ignore', windowsHide: true });
        } catch {
            execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tempDir}' -Force"`, { stdio: 'ignore', windowsHide: true });
        }
    } else {
        execSync(`tar -xzf "${archivePath}" -C "${tempDir}"`, { stdio: 'ignore' });
    }

    // Find the binary recursively
    const findBin = (dir) => {
        for (const item of fs.readdirSync(dir)) {
            const full = path.join(dir, item);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
                const found = findBin(full);
                if (found) return found;
            } else if (item.toLowerCase() === binName.toLowerCase()) {
                return full;
            }
        }
        return null;
    };

    const found = findBin(tempDir);
    if (!found) {
        throw new Error(`Could not find ${binName} in extracted archive!`);
    }

    fs.copyFileSync(found, finalBinPath);
    if (platform !== 'windows') {
        fs.chmodSync(finalBinPath, '755');
    }

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.unlinkSync(archivePath);

    const finalStats = fs.statSync(finalBinPath);
    console.log(`  ✓ ${platform}/${binName} ready (${(finalStats.size / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
    const targets = getPlatformTargets();
    console.log(`\n🔧 sing-box v${VERSION} — Downloading for: ${targets.join(', ')}\n`);

    for (const platform of targets) {
        try {
            await downloadForPlatform(platform);
        } catch (err) {
            console.error(`  ✗ Failed for ${platform}: ${err.message}`);
            process.exit(1);
        }
    }

    console.log(`\n✅ Done! Binaries are in: ${OUTPUT_DIR}\n`);
}

main();
