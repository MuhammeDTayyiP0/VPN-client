// ─── VPN Client — Renderer App ────────────────────────────────────

// Prevent default right-click context menu (native app feel)
document.addEventListener('contextmenu', e => e.preventDefault());

// Prevent Zooming (Ctrl+Scroll, Ctrl++, Ctrl+-, Ctrl+0)
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['=', '-', '0', '+'].includes(e.key)) {
        e.preventDefault();
    }
});

window.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
    }
}, { passive: false });

const api = window.electronAPI;

let currentUser = null;
let vpnLinks = [];
let selectedProtocol = null;
let pollTimer = null;
let isConnecting = false;

// ─── INIT ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    setupTitleBar();
    setupEventListeners();
    await init();
});

async function init() {
    showScreen('loading');

    try {
        // Load version
        const version = await api.getVersion();
        document.getElementById('settings-version').textContent = `v${version}`;

        // Check session
        const session = await api.getSession();
        if (session && session.user) {
            currentUser = session.user;
            vpnLinks = session.vpn_links || [];
            showMainScreen();
        } else {
            showScreen('login');
        }
    } catch (error) {
        document.querySelector('.loading-spinner').style.display = 'none';
        document.querySelector('.loading-text').innerHTML = 
            `Başlatma hatası:<br><span style="color:var(--danger);font-size:12px">${error.message}</span><br>Lütfen uygulamayı yeniden başlatın.`;
        console.error("Init Error:", error);
    }
}

// ─── TITLE BAR ────────────────────────────────────────────────────

function setupTitleBar() {
    document.getElementById('btn-minimize').addEventListener('click', () => api.minimize());
    document.getElementById('btn-close').addEventListener('click', () => api.close());
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────

function setupEventListeners() {
    // Login
    document.getElementById('btn-google-login').addEventListener('click', handleGoogleLogin);

    // Connect
    document.getElementById('btn-connect').addEventListener('click', handleConnectToggle);

    // Settings
    document.getElementById('btn-settings').addEventListener('click', openSettings);
    document.getElementById('btn-settings-back').addEventListener('click', closeSettings);
    document.getElementById('btn-logout').addEventListener('click', handleLogout);

    // System Tray Protocol Selection
    if (api.onTraySelectProtocol) {
        api.onTraySelectProtocol(async (linkObj) => {
            if (isConnecting) return;
            
            const index = vpnLinks.findIndex(l => l.link === linkObj.link);
            if (index !== -1) {
                selectedProtocol = vpnLinks[index];
                
                // Update dropdown Text visually
                const optionsList = document.getElementById('dropdown-options');
                if (optionsList) {
                    optionsList.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('active'));
                    const targetItem = optionsList.querySelector(`.dropdown-item[data-index="${index}"]`);
                    if (targetItem) {
                        targetItem.classList.add('active');
                        document.getElementById('dropdown-selected-text').textContent = targetItem.textContent;
                    }
                }
                
                document.querySelector('.custom-dropdown')?.classList.remove('open');

                const status = await api.vpnStatus();
                if (status && status.connected) {
                    setConnectState('disconnecting');
                    await api.vpnDisconnect();
                    setConnectState('disconnected');
                    toast('Protokol değiştiriliyor...', 'info');
                    setTimeout(handleConnectToggle, 800);
                } else {
                    handleConnectToggle();
                }
            }
        });
    }
}

// ─── AUTH ──────────────────────────────────────────────────────────

async function handleGoogleLogin() {
    const btn = document.getElementById('btn-google-login');
    btn.disabled = true;
    btn.textContent = 'Giriş yapılıyor...';

    const result = await api.loginWithGoogle();

    if (result && result.success) {
        currentUser = result.user;
        vpnLinks = result.vpn_links || [];
        toast('Giriş başarılı!', 'success');
        showMainScreen();
    } else {
        toast(result?.error || 'Giriş başarısız', 'error');
        btn.disabled = false;
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg> Google ile Giriş Yap`;
    }
}

async function handleLogout() {
    // Disconnect VPN first
    const status = await api.vpnStatus();
    if (status && status.connected) {
        await api.vpnDisconnect();
    }

    stopPolling();
    await api.logout();
    currentUser = null;
    vpnLinks = [];
    selectedProtocol = null;
    closeSettings();
    showScreen('login');
    toast('Çıkış yapıldı', 'success');
}

// ─── VPN CONNECT/DISCONNECT ───────────────────────────────────────

async function handleConnectToggle() {
    if (isConnecting) return;

    const status = await api.vpnStatus();

    if (status && status.connected) {
        // Disconnect
        setConnectState('disconnecting');
        const result = await api.vpnDisconnect();
        if (result && result.success) {
            setConnectState('disconnected');
            toast('Bağlantı kesildi', 'success');
        } else {
            setConnectState('disconnected');
            toast(result?.error || 'Bağlantı kesme hatası', 'error');
        }
    } else {
        // Connect
        if (!selectedProtocol) {
            toast('Lütfen bir protokol seçin', 'warning');
            return;
        }

        setConnectState('connecting');

        // Ensure binary first
        const binCheck = await api.vpnEnsureBinary();
        if (binCheck && binCheck.error) {
            setConnectState('disconnected');
            toast('sing-box indirilemedi: ' + binCheck.error, 'error');
            return;
        }

        const result = await api.vpnConnect(selectedProtocol.link);
        if (result && result.success) {
            setConnectState('connected');
            toast('Bağlandı!', 'success');
        } else {
            setConnectState('disconnected');
            toast(result?.error || 'Bağlanma hatası', 'error');
        }
    }
}

function setConnectState(state) {
    const ring = document.getElementById('connect-ring');
    const label = document.getElementById('connect-label');
    const icon = document.getElementById('connect-icon');

    ring.classList.remove('connected', 'connecting');
    label.classList.remove('connected');

    isConnecting = false;

    switch (state) {
        case 'connecting':
            isConnecting = true;
            ring.classList.add('connecting');
            label.textContent = 'Bağlanıyor...';
            icon.innerHTML = '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="20 30"/>';
            break;
        case 'connected':
            ring.classList.add('connected');
            label.classList.add('connected');
            label.textContent = 'Bağlandı — Kesmek için dokunun';
            icon.innerHTML = '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>';
            break;
        case 'disconnecting':
            isConnecting = true;
            label.textContent = 'Bağlantı kesiliyor...';
            break;
        default: // disconnected
            label.textContent = 'Bağlanmak için dokunun';
            icon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
            break;
    }
}

// ─── SCREEN MANAGEMENT ────────────────────────────────────────────

function showScreen(name) {
    document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
    const screen = document.getElementById(`screen-${name}`);
    if (screen) screen.classList.remove('hidden');
}

function showMainScreen() {
    showScreen('main');
    updateUserInfo();
    renderProtocols();
    updateStats();
    startPolling();

    // Check current VPN status
    api.vpnStatus().then(status => {
        if (status && status.connected) {
            setConnectState('connected');
        }
    });
}

// ─── USER INFO ────────────────────────────────────────────────────

function updateUserInfo() {
    if (!currentUser) return;

    const email = currentUser.email || 'user@email.com';
    document.getElementById('user-email').textContent = email;
    document.getElementById('user-avatar').textContent = email.charAt(0).toUpperCase();

    const statusEl = document.getElementById('user-status');
    if (currentUser.active) {
        statusEl.textContent = 'Aktif';
        statusEl.style.color = 'var(--success)';
    } else {
        statusEl.textContent = 'Pasif';
        statusEl.style.color = 'var(--danger)';
    }
}

// ─── PROTOCOL RENDERING ──────────────────────────────────────────

function renderProtocols() {
    const dropdown = document.getElementById('custom-protocol-dropdown');
    const header = document.getElementById('dropdown-header');
    const selectedText = document.getElementById('dropdown-selected-text');
    const optionsList = document.getElementById('dropdown-options');

    // Reset list
    optionsList.innerHTML = '';
    
    if (!vpnLinks || vpnLinks.length === 0) {
        selectedText.textContent = 'Protokol bulunamadı';
        header.style.pointerEvents = 'none';
        header.style.opacity = '0.5';
        return;
    }

    header.style.pointerEvents = 'auto';
    header.style.opacity = '1';

    // Populate options
    optionsList.innerHTML = vpnLinks.map((link, index) => {
        const protoLabel = link.protocol || link.type || 'Unknown';
        const isSelected = selectedProtocol && selectedProtocol.link === link.link;
        return `<li class="dropdown-item ${isSelected ? 'active' : ''}" data-index="${index}">${protoLabel}</li>`;
    }).join('');

    // Set initial text
    if (!selectedProtocol && vpnLinks.length > 0) {
        selectedProtocol = vpnLinks[0];
        optionsList.querySelector('.dropdown-item')?.classList.add('active');
    }
    
    if (selectedProtocol) {
        selectedText.textContent = selectedProtocol.protocol || selectedProtocol.type || 'Unknown';
    }

    // Toggle dropdown
    header.onclick = (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('open');
    };

    // Handle selection
    optionsList.querySelectorAll('.dropdown-item').forEach(item => {
        item.onclick = (e) => {
            e.stopPropagation();
            const index = parseInt(item.dataset.index);
            selectedProtocol = vpnLinks[index];
            
            // Update UI
            optionsList.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            selectedText.textContent = item.textContent;
            
            // Close dropdown
            dropdown.classList.remove('open');
        };
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target)) {
            dropdown.classList.remove('open');
        }
    });
}

// ─── STATS ────────────────────────────────────────────────────────

async function updateStats() {
    const usage = await api.getUsage();
    if (!usage) return;

    const period = usage.data_limit_period || 'none';
    const limitGb = usage.data_limit || 0;
    const usageBytes = period !== 'none' ? (usage.period_usage || 0) : (usage.current_usage || 0);
    const limitBytes = limitGb * 1024 * 1024 * 1024;
    
    // Usage stat
    document.getElementById('stat-usage').textContent = formatBytes(usageBytes);
    
    const cardUsage = document.getElementById('card-usage');
    const progUsage = document.getElementById('progress-usage');
    
    if (limitBytes > 0) {
        let percent = (usageBytes / limitBytes) * 100;
        if (percent > 100) percent = 100;
        progUsage.style.setProperty('--progress', `${percent}%`);
        
        if (percent >= 90) cardUsage.classList.add('danger');
        else cardUsage.classList.remove('danger');
    } else {
        progUsage.style.setProperty('--progress', '0%');
        cardUsage.classList.remove('danger');
    }

    // Limit stat
    const containerLimit = document.getElementById('container-limit');
    if (limitGb > 0) {
        const limitText = limitGb + ' GB';
        const periodLabel = period !== 'none' ? ` / ${periodTR(period)}` : '';
        document.getElementById('stat-limit').textContent = limitText + periodLabel;
        containerLimit.classList.remove('hidden');
        document.getElementById('progress-limit').style.setProperty('--progress', '100%');
    } else {
        document.getElementById('stat-limit').textContent = 'Sınırsız';
        containerLimit.classList.add('hidden');
    }

    // Speed stat
    document.getElementById('stat-speed').textContent =
        usage.speed_limit > 0 ? usage.speed_limit + ' Mbps' : 'Sınırsız';

    // Refresh user data for expiry
    const containerExpiry = document.getElementById('container-expiry');
    const statExpiry = document.getElementById('stat-expiry');
    
    if (currentUser && currentUser.expiry_date) {
        const expDate = new Date(currentUser.expiry_date);
        const daysLeft = Math.ceil((expDate - new Date()) / 86400000);
        
        containerExpiry.classList.remove('hidden');
        const progExpiry = document.getElementById('progress-expiry');
        
        if (daysLeft > 0) {
            statExpiry.textContent = daysLeft + ' gün';
            statExpiry.style.color = 'var(--text-primary)';
            // Max 30 days for progress visually
            let pct = (daysLeft / 30) * 100;
            if (pct > 100) pct = 100;
            progExpiry.style.setProperty('--progress', `${pct}%`);
        } else {
            statExpiry.textContent = 'Süresi doldu';
            statExpiry.style.color = 'var(--danger)';
            progExpiry.style.setProperty('--progress', '0%');
        }
    } else {
        statExpiry.textContent = 'Sınırsız';
        statExpiry.style.color = 'var(--text-primary)';
        containerExpiry.classList.add('hidden');
    }
}

// ─── SETTINGS ─────────────────────────────────────────────────────

function openSettings() {
    const panel = document.getElementById('settings-panel');
    panel.classList.remove('hidden');
}

function closeSettings() {
    const panel = document.getElementById('settings-panel');
    panel.classList.add('hidden');
}

// ─── POLLING ──────────────────────────────────────────────────────

function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
        await updateStats();

        // Sync VPN status
        const status = await api.vpnStatus();
        if (status) {
            if (status.connected && !isConnecting) {
                setConnectState('connected');
            } else if (!status.connected && !isConnecting) {
                setConnectState('disconnected');
            }
        }
    }, 10000);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

// ─── UTILITIES ────────────────────────────────────────────────────

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 2 : 0) + ' ' + units[i];
}

function periodTR(period) {
    const map = { daily: 'günlük', weekly: 'haftalık', monthly: 'aylık' };
    return map[period] || period;
}

function toast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}
