const APP_VERSION = '0.1.0';

function getPlatform() {
    const ua = navigator.userAgent;
    if (/Windows|Win64|Win32/.test(ua)) return 'windows';
    if (/Android/.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
    return 'web';
}

const PLATFORM = getPlatform();
const IS_MOBILE = PLATFORM === 'android' || PLATFORM === 'ios';

// API base URL — resolved synchronously, then updated via Tauri if needed
let API_URL = (() => {
    const stored = localStorage.getItem('api_url');
    if (stored) return stored;
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:8000';
    return `http://${hostname}:8000`;
})();

const IS_TAURI = typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__);
if (IS_TAURI) {
    window.__TAURI_INTERNALS__.invoke('get_api_url').then(url => {
        API_URL = url;
        localStorage.setItem('api_url', url);
        refreshConnectionStatus();
        checkVersion();
    }).catch(() => {});
}

async function logClientError(message, page) {
    try {
        await fetch(`${API_URL}/api/log-error`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, page, version: APP_VERSION, platform: PLATFORM }),
        });
    } catch { /* ignore */ }
}

const NETWORK_MSG = 'Parece que hay un problema de conexión. Revisa tu red e intenta de nuevo.';
const TIMEOUT_MSG = 'La operación tardó demasiado. ¿Estás conectado a internet?';

const BTN_ORIG = new WeakMap();

function setLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
        BTN_ORIG.set(btn, btn.innerHTML);
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
    } else {
        btn.disabled = false;
        btn.innerHTML = BTN_ORIG.get(btn) || btn.innerHTML;
    }
}

function friendlyError(err, page) {
    const msg = typeof err === 'string' ? err : ((err && err.message) || '');
    logClientError(msg || 'Unknown error', page || window.location.pathname);
    if (!msg || msg === 'Failed to Fetch' || msg === 'Failed to fetch' || msg === 'NetworkError' || msg === 'Load failed' || msg === 'Network request failed') {
        return NETWORK_MSG;
    }
    if (msg === 'The operation was aborted' || msg === 'AbortError' || msg === 'Timeout') {
        return TIMEOUT_MSG;
    }
    return msg;
}

function updateConnectionStatus(connected) {
    const el = document.getElementById('connection-status');
    if (!el) return;
    el.className = connected ? 'connected' : 'disconnected';
    el.title = connected ? `Conectado a ${API_URL}` : 'Desconectado';
    if (connected) el.innerHTML = '<span class="dot"></span> Conectado';
    else el.innerHTML = '<span class="dot"></span> Desconectado';
}

async function testConnection(url) {
    try {
        const resp = await fetch(`${url}/api/lessons`, { signal: AbortSignal.timeout(3000) });
        return resp.ok;
    } catch {
        return false;
    }
}

// ---- App Info & Share ----
const shareBtn = document.getElementById('share-btn');
const appVersionDisplay = document.querySelector('.app-version-display');
const appPlatformDisplay = document.querySelector('.app-platform-display');
const appInfoUrl = document.getElementById('app-info-url');

function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

async function loadAppInfo() {
    try {
        const resp = await fetchWithTimeout(`${API_URL}/api/app-info?platform=${PLATFORM}`, 4000);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (appVersionDisplay) appVersionDisplay.textContent = data.active_version;
        if (appInfoUrl) {
            appInfoUrl.href = data.app_url;
            appInfoUrl.textContent = data.app_url.replace(/^https?:\/\//, '');
        }
        if (appPlatformDisplay) appPlatformDisplay.textContent = PLATFORM;
        return data;
    } catch {
        if (appInfoUrl) appInfoUrl.textContent = 'no disponible';
        return null;
    }
}

const SHARE_FALLBACK_URL = 'https://piano-virtual.com/download';

if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
        shareBtn.disabled = true;
        shareBtn.innerHTML = '<span style="display:inline-block;width:14px;height:14px;border:2px solid #888;border-top-color:transparent;border-radius:50%;animation:spin 0.6s linear infinite"></span>';

        const data = await loadAppInfo().catch(() => null);
        shareBtn.disabled = false;
        shareBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/></svg>';

        const url = (data && data.app_url) || SHARE_FALLBACK_URL;
        const desc = (data && data.app_description) || 'Aprende a tocar el piano con lecciones interactivas. Descarga Piano Virtual.';

        // Native share via Tauri plugin (Android, iOS, macOS, Windows)
        try {
            await window.__TAURI_INTERNALS__.invoke('plugin:sharesheet|share_text', {
                text: `${desc}\n\n${url}`,
                mimeType: 'text/plain'
            });
            return;
        } catch {
            // fallback: clipboard
        }

        try {
            await navigator.clipboard.writeText(`${desc}\n\n${url}`);
            await Swal.fire('Enlace copiado', 'El enlace se ha copiado al portapapeles.', 'success');
        } catch {
            await Swal.fire('Info', `Descarga Piano Virtual aquí: ${url}`, 'info');
        }
    });
}

async function checkVersion() {
    const data = await loadAppInfo();
    if (!data) return;
    if (compareVersions(data.active_version, APP_VERSION) > 0) {
        const { isConfirmed } = await Swal.fire({
            title: '¡Nueva versión disponible!',
            html: `Hay una nueva versión (<strong>${data.active_version}</strong>) disponible. <br/><br/> ${data.app_description}`,
            icon: 'info',
            confirmButtonText: 'Descargar ahora',
            allowOutsideClick: false,
            allowEscapeKey: false,
            showCloseButton: false,
        });
        if (isConfirmed) {
            window.open(data.app_url, '_blank');
        }
    }
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0, nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

// Hide camera scan button on non-mobile platforms
if (!IS_MOBILE) {
    const scanBtn = document.getElementById('scan-start-btn');
    if (scanBtn) scanBtn.style.display = 'none';


    const hintFriends = document.getElementById('hint-friends');
    if (hintFriends) hintFriends.style.display = 'none';

    document.getElementById("scan-title").textContent = "Agregar"
    document.getElementById("friends-change").textContent = "Ingresa manualmente el ID:"
}

// ---- Orientation Management ----
const rotateOverlay = document.getElementById('rotate-overlay');
let orientationMediaQuery = null;

function tryLockLandscape() {
    if (!IS_MOBILE) return;
    if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
    }
}

function tryUnlockOrientation() {
    if (!IS_MOBILE) return;
    if (screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock();
    }
}

function checkOrientation() {
    if (!IS_MOBILE || !rotateOverlay) return;
    const isLandscape = window.innerWidth > window.innerHeight;
    rotateOverlay.classList.toggle('active', !isLandscape);
}

function handlePianoOrientation() {
    if (!IS_MOBILE) return;
    tryLockLandscape();
    if (rotateOverlay) {
        orientationMediaQuery = window.matchMedia('(orientation: portrait)');
        orientationMediaQuery.addEventListener('change', checkOrientation);
    }
    checkOrientation();
}

function leavePianoOrientation() {
    if (!IS_MOBILE) return;
    tryUnlockOrientation();
    if (orientationMediaQuery) {
        orientationMediaQuery.removeEventListener('change', checkOrientation);
        orientationMediaQuery = null;
    }
    if (rotateOverlay) rotateOverlay.classList.remove('active');
}

document.getElementById('rotate-back-btn')?.addEventListener('click', () => {
    pianoSection.style.display = 'none';
    leavePianoOrientation();
    lessonsSection.style.display = 'block';
    loadLessons();
});

// ---- Heartbeat ----
let heartbeatInterval = null;

function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        if (token) {
            adminFetch('/api/ping').catch(() => {});
        }
    }, 60000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// ---- Android Back Button (popstate) ----
window.addEventListener('popstate', () => {
    console.log('popstate fired');
    if (qrOverlay?.classList.contains('active')) {
        console.log('popstate: QR active, calling cancel');
        cancelQrScanner();
        hideQROverlay();
        friendsModal.style.display = 'none';
        const btn = document.getElementById('scan-start-btn');
        if (btn) setLoading(btn, false);
        return;
    }
    if (pianoSection && pianoSection.style.display !== 'none' && pianoSection.style.display !== '') {
        console.log('popstate: piano active, closing');
        stopGameLoop();
        pianoSection.style.display = 'none';
        leavePianoOrientation();
        lessonsSection.style.display = 'block';
        loadLessons();
        return;
    }
    if (friendsModal && friendsModal.style.display === 'flex') {
        console.log('popstate: friends modal open, closing');
        friendsModal.style.display = 'none';
        return;
    }
    if (settingsModal && settingsModal.style.display === 'flex') {
        console.log('popstate: settings modal open, closing');
        settingsModal.style.display = 'none';
        return;
    }
    console.log('popstate: nothing open, letting default happen');
});

// ---- Key Mappings ----
let userKeyMappings = null;
let editingKeyMapping = null;
let userPreferences = null;

const ALL_NOTES = [];
(function buildAllNotes() {
    const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    for (let o = 2; o <= 7; o++) {
        for (const n of NOTES) {
            ALL_NOTES.push(n + o);
        }
    }
})();

async function loadKeyMappings() {
    if (!token) return;
    try {
        const resp = await adminFetch('/api/key-mappings');
        if (resp.ok) {
            const data = await resp.json();
            userKeyMappings = data.mappings && Object.keys(data.mappings).length > 0 ? data.mappings : null;
            if (data.preferences && typeof data.preferences === 'object') {
                userPreferences = data.preferences;
                if (typeof userPreferences.autoOctave === 'boolean') {
                    autoOctaveEnabled = userPreferences.autoOctave;
                    const toggle = document.getElementById('auto-octave-toggle');
                    if (toggle) toggle.checked = autoOctaveEnabled;
                }
            }
        }
    } catch (err) { logClientError(err?.message || 'loadKeyMappings error', 'key-mappings'); }
    applyKeyMappings();
    renderKeyMappings();
}

function applyKeyMappings() {
    if (userKeyMappings) {
        window.__KEY_MAP = {};
        for (const key of Object.keys(KEY_MAP)) {
            if (userKeyMappings[key]) {
                const val = userKeyMappings[key];
                if (Array.isArray(val) && val.length === 2) {
                    window.__KEY_MAP[key] = val;
                }
            }
        }
        for (const key of Object.keys(KEY_MAP)) {
            if (!window.__KEY_MAP[key]) {
                window.__KEY_MAP[key] = KEY_MAP[key];
            }
        }
    } else {
        window.__KEY_MAP = KEY_MAP;
    }
}

function toDisplayNote(val) {
    if (!Array.isArray(val) || val.length !== 2) return '';
    const [noteName, relOct] = val;
    const base = NOTE_NAMES[noteName.replace('#', '')] || noteName.replace('#', '♯');
    return base + (noteName.includes('#') ? '♯' : '') + (relOct + 1);
}

function toAbsoluteNote(val) {
    if (!Array.isArray(val) || val.length !== 2) return '';
    return val[0] + (BASE_OCTAVE + val[1]);
}

function renderKeyMappings() {
    const grid = document.getElementById('key-mappings-grid');
    if (!grid) return;
    const map = userKeyMappings || {};
    grid.innerHTML = MAPPABLE_KEYS.map(key => {
        const val = (key in map && Array.isArray(map[key]) && map[key].length === 2) ? map[key] : KEY_MAP[key];
        const display = toDisplayNote(val);
        const absNote = toAbsoluteNote(val);
        return `<div class="key-mapping-item" data-key="${key}" onclick="startEditKeyMapping('${key}')">
            <span class="key-mapping-key">${key === "'" ? "&apos;" : key === ";" ? ";" : key}</span>
            <span class="key-mapping-note" id="km-note-${key.replace("'", "apos")}" data-note="${absNote}">${display}</span>
        </div>`;
    }).join('');
    document.getElementById('key-mappings-save').style.display = 'inline-block';
    document.getElementById('key-mappings-cancel').style.display = 'none';
    document.getElementById('key-mappings-msg').style.display = 'none';
    const resetBtn = document.getElementById('key-mappings-reset');
    if (resetBtn) resetBtn.style.display = userKeyMappings ? 'inline-block' : 'none';
}

function startEditKeyMapping(key) {
    if (editingKeyMapping === key) return;
    if (editingKeyMapping) cancelEditKeyMapping();
    editingKeyMapping = key;
    const item = document.querySelector(`.key-mapping-item[data-key="${key}"]`);
    if (!item) return;
    item.classList.add('editing');
    const noteSpan = item.querySelector('.key-mapping-note');
    const currentNote = noteSpan.dataset.note || noteSpan.textContent;
    const select = document.createElement('select');
    select.id = 'km-select';
    select.innerHTML = ALL_NOTES.map(n =>
        `<option value="${n}" ${n === currentNote ? 'selected' : ''}>${n}</option>`
    ).join('');
    select.addEventListener('change', () => {
        const newNote = select.value;
        const match = newNote.match(/^([A-Z]#?)(\d)$/);
        if (match) {
            const noteName = match[1];
            const octave = parseInt(match[2]);
            const relOct = octave - BASE_OCTAVE;
            if (!userKeyMappings) userKeyMappings = {};
            userKeyMappings[key] = [noteName, relOct];
            applyKeyMappings();
        }
        finishEditKeyMapping();
    });
    noteSpan.replaceWith(select);
    document.getElementById('key-mappings-save').style.display = 'none';
    document.getElementById('key-mappings-cancel').style.display = 'inline-block';
}

function cancelEditKeyMapping() {
    if (!editingKeyMapping) return;
    const item = document.querySelector(`.key-mapping-item[data-key="${editingKeyMapping}"]`);
    if (item) {
        item.classList.remove('editing');
        const select = item.querySelector('select');
        if (select) {
            const span = document.createElement('span');
            span.className = 'key-mapping-note';
            span.id = `km-note-${editingKeyMapping.replace("'", "apos")}`;
            const customVal = userKeyMappings?.[editingKeyMapping];
            const val = (Array.isArray(customVal) && customVal.length === 2) ? customVal : KEY_MAP[editingKeyMapping];
            span.dataset.note = toAbsoluteNote(val);
            span.textContent = toDisplayNote(val);
            select.replaceWith(span);
        }
    }
    editingKeyMapping = null;
    document.getElementById('key-mappings-save').style.display = 'inline-block';
    document.getElementById('key-mappings-cancel').style.display = 'none';
}

function finishEditKeyMapping() {
    editingKeyMapping = null;
    renderKeyMappings();
}

document.getElementById('key-mappings-save')?.addEventListener('click', async () => {
    const msg = document.getElementById('key-mappings-msg');
    try {
        const resp = await adminFetch('/api/key-mappings', {
            method: 'PUT',
            body: JSON.stringify({ mappings: userKeyMappings || {}, preferences: userPreferences || {} }),
        });
        if (!resp.ok) throw new Error();
        msg.textContent = 'Mapeo guardado correctamente';
        msg.style.display = 'block';
        msg.style.color = '#4ade80';
        setTimeout(() => { msg.style.display = 'none'; }, 3000);
    } catch {
        msg.textContent = 'Error al guardar';
        msg.style.display = 'block';
        msg.style.color = '#ff6b6b';
    }
});

document.getElementById('key-mappings-cancel')?.addEventListener('click', cancelEditKeyMapping);

document.getElementById('key-mappings-reset')?.addEventListener('click', async () => {
    userKeyMappings = null;
    applyKeyMappings();
    renderKeyMappings();
    const msg = document.getElementById('key-mappings-msg');
    try {
        await adminFetch('/api/key-mappings', {
            method: 'PUT',
            body: JSON.stringify({ mappings: {}, preferences: userPreferences || {} }),
        });
        msg.textContent = 'Valores restaurados correctamente';
        msg.style.display = 'block';
        msg.style.color = '#4ade80';
        setTimeout(() => { msg.style.display = 'none'; }, 3000);
    } catch {
        msg.textContent = 'Error al guardar';
        msg.style.display = 'block';
        msg.style.color = '#ff6b6b';
    }
});

document.getElementById('auto-octave-toggle')?.addEventListener('change', (e) => {
    autoOctaveEnabled = e.target.checked;
    if (!userPreferences) userPreferences = {};
    userPreferences.autoOctave = autoOctaveEnabled;
    adminFetch('/api/key-mappings', {
        method: 'PUT',
        body: JSON.stringify({ mappings: userKeyMappings || {}, preferences: userPreferences }),
    }).catch(() => {});
});

// ---- Friends (QR-based) ----
const friendsModal = document.getElementById('friends-modal');
const friendsBtn = document.getElementById('friends-btn');
const friendsClose = document.getElementById('friends-modal-close');
const friendsTabs = document.querySelectorAll('.friends-tab');
const friendsPanels = {
    mycode: document.getElementById('panel-mycode'),
    scan: document.getElementById('panel-scan'),
    requests: document.getElementById('panel-requests'),
    list: document.getElementById('panel-list'),
    streaks: document.getElementById('panel-streaks'),
};
const requestsBadge = document.getElementById('requests-badge');
const requestsList = document.getElementById('requests-list');
const requestsEmpty = document.getElementById('requests-empty');
const friendsList = document.getElementById('friends-list');
const friendsEmpty = document.getElementById('friends-empty');
const qrResultDiv = document.getElementById('qr-result');

let qrCodeInstance = null;

friendsBtn?.addEventListener('click', () => {
    friendsModal.style.display = 'flex';
    history.pushState({ friendsModal: true }, '');
    generateMyQR();
    updateDeepLinkDisplay();
    loadFriendsRequests();
    loadFriendsList();
});

friendsClose?.addEventListener('click', () => {
    friendsModal.style.display = 'none';
});

friendsModal?.addEventListener('click', (e) => {
    if (e.target === friendsModal) {
        friendsModal.style.display = 'none';
    }
});

// Tab switching
friendsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        friendsTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        Object.keys(friendsPanels).forEach(k => friendsPanels[k].classList.remove('active'));
        const panel = friendsPanels[tab.dataset.tab];
        if (panel) panel.classList.add('active');

        if (tab.dataset.tab === 'requests') loadFriendsRequests();
        if (tab.dataset.tab === 'list') loadFriendsList();
        if (tab.dataset.tab === 'streaks') loadUserStreaks();
    });
});

function inviteUrl(userId) {
    return `${API_URL}/invite/${userId}`;
}

function generateMyQR() {
    const container = document.getElementById('qrcode');
    if (!container || !currentUser) return;
    container.innerHTML = '';
    try {
        const qrText = inviteUrl(currentUser.id);
        qrCodeInstance = new QRCode(container, {
            text: qrText,
            width: 180,
            height: 180,
            colorDark: '#ffffff',
            colorLight: '#16213e',
            correctLevel: QRCode.CorrectLevel.H,
        });
    } catch { /* QRCode lib not loaded */ }
}

function updateDeepLinkDisplay() {
    const el = document.getElementById('my-deep-link');
    if (el && currentUser) {
        el.textContent = inviteUrl(currentUser.id);
    }
}

document.getElementById('share-deep-link-btn')?.addEventListener('click', async () => {
    const el = document.getElementById('my-deep-link');
    if (!el || !el.textContent) return;
    try {
        await window.__TAURI_INTERNALS__.invoke('plugin:sharesheet|share_text', {
            text: el.textContent,
            mimeType: 'text/plain',
        });
        return;
    } catch {
        // fallback: clipboard
    }
    try {
        await navigator.clipboard.writeText(el.textContent);
        await Swal.fire('Copiado', 'Enlace copiado al portapapeles', 'success');
    } catch {
        await Swal.fire('Error', 'No se pudo copiar el enlace', 'error');
    }
});

// ---- Deep Link Listener ----
function handleDeepLink(url) {
    const match = url.match(/pianovirtual:\/\/add-friend\/([a-f0-9-]+)/i) ||
                  url.match(/\/invite\/([a-f0-9-]+)/i);
    if (!match) return;
    const targetId = match[1];
    if (!currentUser) {
        Swal.fire('Inicia sesión', 'Debes iniciar sesión para agregar amigos.', 'info');
        return;
    }
    if (targetId === currentUser.id) {
        Swal.fire('Oops', 'No puedes agregarte a ti mismo.', 'info');
        return;
    }
    adminFetch('/api/friends/request', {
        method: 'POST',
        body: JSON.stringify({ user_id: targetId }),
    })
        .then(resp => {
            if (!resp.ok) return resp.json().then(e => { throw new Error(e.error); });
            Swal.fire('Solicitud enviada', '', 'success');
        })
        .catch(err => {
            Swal.fire('Error', friendlyError(err, 'friend-add'), 'error');
        });
}

if (window.__TAURI_INTERNALS__) {
    try {
        window.__TAURI_INTERNALS__.event.listen('deep-link://new-url', (event) => {
            const urls = event.payload;
            if (Array.isArray(urls) && urls.length > 0) {
                handleDeepLink(urls[0]);
            }
        });
    } catch (err) { logClientError(err?.message || 'deep-link listen error', 'deep-link'); }
    // Check if app was opened via a deep link (cold start)
    async function checkColdStart() {
        try {
            const urls = await window.__TAURI_INTERNALS__.invoke('plugin:deep-link|get_current');
            if (Array.isArray(urls) && urls.length > 0) { handleDeepLink(urls[0]); return; }
        } catch { /* fallback */ }
        try {
            const url = await window.__TAURI_INTERNALS__.invoke('get_pending_deep_link');
            if (url) handleDeepLink(url);
        } catch { /* ignore */ }
    }
    checkColdStart();
}

// ---- QR Scanner with Overlay (native plugin) ----
const qrOverlay = document.getElementById('qr-scanner-overlay');
const qrCancelBtn = document.getElementById('qr-scanner-cancel');

function showQROverlay() {
    console.log('showQROverlay');
    qrOverlay?.classList.add('active');
}

function hideQROverlay() {
    console.log('hideQROverlay');
    qrOverlay?.classList.remove('active');
}

async function cancelQrScanner() {
    console.log('cancelQrScanner called');
    try {
        await window.__TAURI_INTERNALS__.invoke('plugin:barcode-scanner|cancel');
        console.log('cancelQrScanner: success');
    } catch (e) {
        console.log('cancelQrScanner: error', e);
    }
}

qrCancelBtn?.addEventListener('click', async () => {
    console.log('Cancel button clicked');
    await cancelQrScanner();
    hideQROverlay();
});

document.getElementById('scan-start-btn')?.addEventListener('click', async () => {
    if (!IS_MOBILE) return;
    if (!currentUser) {
        Swal.fire('Error', 'Debes iniciar sesión para enviar solicitudes.', 'error');
        return;
    }
    const startBtn = document.getElementById('scan-start-btn');
    setLoading(startBtn, true);
    showQROverlay();
    console.log('scan-start: overlay shown, requesting permissions');
    try {
        try {
            await window.__TAURI_INTERNALS__.invoke('plugin:barcode-scanner|request_permissions');
            console.log('scan-start: permissions ok');
        } catch (permErr) {
            console.log('scan-start: permissions error', permErr);
            const msg = (permErr && (permErr.message || String(permErr))) || '';
            if (msg.includes('denied')) {
                hideQROverlay();
                setLoading(startBtn, false);
                Swal.fire('Permiso denegado', 'Debes aceptar el permiso de cámara para escanear códigos QR.', 'error');
                return;
            }
        }
        console.log('scan-start: invoking scan');
        const result = await window.__TAURI_INTERNALS__.invoke('plugin:barcode-scanner|scan', {
            formats: ['QR_CODE'],
            windowed: false
        });
        console.log('scan-start: scan returned', result);

        setLoading(startBtn, false);
        hideQROverlay();

        if (!result || !result.content) return;

        let targetId = result.content;
        const match = result.content.match(/pianovirtual:\/\/add-friend\/([a-f0-9-]+)/i) ||
                      result.content.match(/\/invite\/([a-f0-9-]+)/i);
        if (match) targetId = match[1];

        if (targetId === currentUser.id) {
            Swal.fire('Oops', 'No puedes agregarte a ti mismo.', 'info');
            return;
        }

        const resp = await adminFetch('/api/friends/request', {
            method: 'POST',
            body: JSON.stringify({ user_id: targetId }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || 'Error');
        }
        Swal.fire('Solicitud enviada', '', 'success');
        qrResultDiv.style.display = 'block';
        qrResultDiv.textContent = '✅ QR escaneado correctamente';
    } catch (err) {
        console.log('scan-start: catch block, err=', err, 'name=', err?.name);
        setLoading(startBtn, false);
        hideQROverlay();
        if (err && typeof err === 'object' && err.name === 'Cancel') return;
        Swal.fire('Error', friendlyError(err, 'friend-scan'), 'error');
    }
});



// Manual friend request by ID
document.getElementById('manual-friend-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('manual-friend-id');
    const id = input?.value.trim();
    if (!id) return Swal.fire('Error', 'Ingresa un ID de usuario.', 'error');
    if (!currentUser) return Swal.fire('Error', 'Debes iniciar sesión.', 'error');
    if (id === currentUser.id) return Swal.fire('Oops', 'No puedes agregarte a ti mismo.', 'info');
    const btn = document.getElementById('manual-friend-btn');
    setLoading(btn, true);
    try {
        const resp = await adminFetch('/api/friends/request', {
            method: 'POST',
            body: JSON.stringify({ user_id: id }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || 'Error');
        }
        Swal.fire('Solicitud enviada', '', 'success');
        input.value = '';
    } catch (err) {
        Swal.fire('Error', friendlyError(err, 'friend-manual'), 'error');
    } finally {
        setLoading(btn, false);
    }
});

async function loadFriendsRequests() {
    if (!requestsList) return;
    requestsList.innerHTML = '<div class="spinner" style="margin:20px auto"></div>';
    try {
        const resp = await adminFetch('/api/friends/requests');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const requests = await resp.json();
        requestsBadge.style.display = requests.length ? 'inline' : 'none';
        requestsBadge.textContent = requests.length;
        requestsEmpty.style.display = requests.length ? 'none' : 'block';
        requestsList.innerHTML = requests.map(r => `
            <div class="friend-request-card">
                <span class="friend-request-user">${r.sender_username}</span>
                <span class="friend-request-date">${new Date(r.created_at).toLocaleDateString()}</span>
                <div class="friend-request-actions">
                    <button class="btn primary btn-sm" onclick="handleFriendRequest('${r.id}', 'accept')">Aceptar</button>
                    <button class="btn secondary btn-sm" onclick="handleFriendRequest('${r.id}', 'reject')">Rechazar</button>
                </div>
            </div>
        `).join('');
    } catch (err) { logClientError(err?.message || 'loadFriendsRequests error', 'friend-requests'); }
}

async function handleFriendRequest(requestId, action) {
    const btn = document.querySelector(`button[onclick="handleFriendRequest('${requestId}', '${action}')"]`);
    setLoading(btn, true);
    const method = action === 'accept' ? 'accept' : 'reject';
    try {
        const resp = await adminFetch(`/api/friends/${method}/${requestId}`, { method: 'POST' });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || 'Error');
        }
        Swal.fire(action === 'accept' ? 'Aceptada' : 'Rechazada', '', 'success');
        loadFriendsRequests();
        loadFriendsList();
    } catch (err) {
        Swal.fire('Error', friendlyError(err, 'friend-request'), 'error');
    } finally {
        setLoading(btn, false);
    }
}

async function loadFriendsList() {
    if (!friendsList) return;
    friendsList.innerHTML = '<div class="spinner" style="margin:20px auto"></div>';
    try {
        const resp = await adminFetch('/api/friends');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const friends = await resp.json();
        friendsEmpty.style.display = friends.length ? 'none' : 'block';
        friendsList.innerHTML = friends.map(f => `
            <div class="friend-card">
                <span class="friend-status-dot ${f.is_active ? 'online' : 'offline'}"></span>
                <span class="friend-card-user">${f.username}</span>
                <span class="friend-card-since">Desde ${new Date(f.since).toLocaleDateString()}${f.is_active ? ' · En línea' : ''}</span>
            </div>
        `).join('');
    } catch (err) { logClientError(err?.message || 'loadFriendsList error', 'friend-list'); }
}

const streaksList = document.getElementById('streaks-list');
const streaksEmpty = document.getElementById('streaks-empty');

async function loadUserStreaks() {
    if (!streaksList) return;
    streaksList.innerHTML = '<div class="spinner" style="margin:20px auto"></div>';
    try {
        const resp = await adminFetch('/api/streaks');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const streaks = await resp.json();
        streaksEmpty.style.display = streaks.length ? 'none' : 'block';
        streaksList.innerHTML = streaks.map(s => {
            const fireEmojis = s.streak_days >= 7 ? '🔥' : s.streak_days >= 3 ? '⭐' : '⚡';
            return `
                <div class="streak-card">
                    <span class="streak-icon">${fireEmojis}</span>
                    <span class="streak-card-user">${s.username}</span>
                    <span class="streak-card-days">${s.streak_days} día${s.streak_days !== 1 ? 's' : ''}</span>
                </div>
            `;
        }).join('');
    } catch (err) { logClientError(err?.message || 'loadUserStreaks error', 'streaks'); }
}

// ---- Multiplayer ----
const multiplayerModal = document.getElementById('multiplayer-modal');
const multiplayerClose = document.getElementById('multiplayer-modal-close');
const multiplayerBtn = document.getElementById('multiplayer-btn');
const multiplayerCreateBtn = document.getElementById('multiplayer-create-btn');
const multiplayerJoinBtn = document.getElementById('multiplayer-join-btn');
const multiplayerLeaveBtn = document.getElementById('multiplayer-leave-btn');
const multiplayerStartBtn = document.getElementById('multiplayer-start-btn');
const multiplayerCodeInput = document.getElementById('multiplayer-code-input');
const multiplayerCodeDisplay = document.getElementById('multiplayer-code');
const multiplayerStatus = document.getElementById('multiplayer-status');
const multiplayerParticipantsList = document.getElementById('multiplayer-participants-list');
const multiplayerSessionInfo = document.getElementById('multiplayer-session-info');
const multiplayerJoinCreate = document.getElementById('multiplayer-join-create');
const multiplayerResults = document.getElementById('multiplayer-results');
const multiplayerResultsList = document.getElementById('multiplayer-results-list');
const multiplayerCreateError = document.getElementById('multiplayer-create-error');
const multiplayerJoinError = document.getElementById('multiplayer-join-error');

document.querySelectorAll('.multiplayer-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.multiplayer-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.multiplayer-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById('panel-' + tab.dataset.tab);
        if (panel) panel.classList.add('active');
        if (multiplayerCreateError) multiplayerCreateError.textContent = '';
        if (multiplayerJoinError) multiplayerJoinError.textContent = '';
    });
});

function resetMultiplayerSession() {
    multiplayerSessionId = null;
    multiplayerScoreSubmitted = false;
    if (multiplayerPollInterval) {
        clearInterval(multiplayerPollInterval);
        multiplayerPollInterval = null;
    }
    if (multiplayerBtn) multiplayerBtn.style.display = 'none';
    if (multiplayerSessionInfo) multiplayerSessionInfo.style.display = 'none';
    if (multiplayerJoinCreate) multiplayerJoinCreate.style.display = 'block';
    if (multiplayerResults) multiplayerResults.style.display = 'none';
    if (multiplayerStartBtn) multiplayerStartBtn.style.display = 'none';
    if (multiplayerStatus) multiplayerStatus.textContent = '';
    if (multiplayerParticipantsList) multiplayerParticipantsList.innerHTML = '';
}

function showMultiplayerLobby(data) {
    if (multiplayerSessionInfo) multiplayerSessionInfo.style.display = 'block';
    if (multiplayerJoinCreate) multiplayerJoinCreate.style.display = 'none';
    if (multiplayerResults) multiplayerResults.style.display = 'none';
    if (multiplayerCodeDisplay) multiplayerCodeDisplay.textContent = data.session.code;

    const isHost = data.host_username === currentUser.username;
    if (multiplayerStartBtn) {
        multiplayerStartBtn.style.display = data.session.status === 'waiting' && isHost ? 'inline-block' : 'none';
    }

    if (multiplayerStatus) {
        const statusLabels = { 'waiting': 'Esperando jugadores...', 'playing': 'Sesión en curso', 'finished': 'Finalizada' };
        multiplayerStatus.textContent = statusLabels[data.session.status] || data.session.status;
    }

    renderParticipants(data.participants, data.host_username);
}

function renderParticipants(participants, hostUsername) {
    if (!multiplayerParticipantsList) return;
    multiplayerParticipantsList.innerHTML = participants.map(p => `
        <div class="multiplayer-participant">
            <span>${p.username} ${p.username === hostUsername ? '<span class="host-badge">Anfitrión</span>' : ''}</span>
            <span>${p.completed ? '<span class="completed-badge">✅ Listo</span>' : '<span class="pending-badge">⏳ Esperando</span>'}</span>
        </div>
    `).join('');
}

function showMultiplayerResults(data) {
    if (multiplayerSessionInfo) multiplayerSessionInfo.style.display = 'block';
    if (multiplayerJoinCreate) multiplayerJoinCreate.style.display = 'none';
    if (multiplayerResults) multiplayerResults.style.display = 'block';
    if (multiplayerStartBtn) multiplayerStartBtn.style.display = 'none';
    if (multiplayerStatus) multiplayerStatus.textContent = 'Sesión finalizada';

    const sorted = [...data.participants].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.perfects !== a.perfects) return b.perfects - a.perfects;
        return a.misses - b.misses;
    });

    if (multiplayerResultsList) {
        multiplayerResultsList.innerHTML = sorted.map((p, i) => {
            const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            return `
                <div class="multiplayer-result-row">
                    <span class="rank ${rankClass}">${medal}</span>
                    <span class="name">${p.username}</span>
                    <span class="score">${p.score}%</span>
                    <span class="details">${p.perfects}P / ${p.goods}B / ${p.lates}T / ${p.misses}F</span>
                </div>
            `;
        }).join('');
    }
}

async function pollMultiplayerSession() {
    if (!multiplayerSessionId) return;
    try {
        const resp = await adminFetch(`/api/multiplayer/session/${multiplayerSessionId}`);
        if (!resp.ok) { resetMultiplayerSession(); return; }
        const data = await resp.json();

        if (data.session.status === 'finished') {
            if (multiplayerPollInterval) {
                clearInterval(multiplayerPollInterval);
                multiplayerPollInterval = null;
            }
            showMultiplayerResults(data);
            return;
        }

        if (data.session.status === 'cancelled') {
            resetMultiplayerSession();
            if (multiplayerModal) multiplayerModal.style.display = 'none';
            Swal.fire('Sesión cancelada', 'El anfitrión ha cancelado la sesión.', 'info');
            return;
        }

        if (data.session.status === 'playing') {
            if (multiplayerPollInterval) {
                clearInterval(multiplayerPollInterval);
                multiplayerPollInterval = null;
            }
            multiplayerModal.style.display = 'none';
            if (pianoSection.style.display === 'none' || !currentLesson || currentLesson.id !== data.session.lesson_id) {
                const savedId = multiplayerSessionId;
                await openLesson(data.session.lesson_id);
                multiplayerSessionId = savedId;
            }
            startLesson();
            return;
        }

        showMultiplayerLobby(data);
    } catch (err) {
        logClientError(err?.message || 'multiplayer-poll error', 'multiplayer-poll');
    }
}

function startMultiplayerPolling() {
    if (multiplayerPollInterval) clearInterval(multiplayerPollInterval);
    multiplayerPollInterval = setInterval(pollMultiplayerSession, 3000);
}

multiplayerBtn?.addEventListener('click', () => {
    if (!multiplayerSessionId) {
        resetMultiplayerSession();
        if (multiplayerJoinCreate) multiplayerJoinCreate.style.display = 'block';
        if (multiplayerSessionInfo) multiplayerSessionInfo.style.display = 'none';
    } else {
        if (multiplayerJoinCreate) multiplayerJoinCreate.style.display = 'none';
        if (multiplayerSessionInfo) multiplayerSessionInfo.style.display = 'block';
        pollMultiplayerSession();
    }
    multiplayerModal.style.display = 'flex';
});

if (multiplayerClose) {
    multiplayerClose.addEventListener('click', () => { multiplayerModal.style.display = 'none'; });
}

multiplayerModal?.addEventListener('click', (e) => {
    if (e.target === multiplayerModal) multiplayerModal.style.display = 'none';
});

multiplayerCreateBtn?.addEventListener('click', async () => {
    if (!currentLesson) return;
    if (multiplayerCreateError) multiplayerCreateError.textContent = '';
    setLoading(multiplayerCreateBtn, true);
    try {
        const resp = await adminFetch('/api/multiplayer/create', {
            method: 'POST',
            body: JSON.stringify({ lesson_id: currentLesson.id }),
        });
        if (!resp.ok) { let errMsg; try { const e = await resp.json(); errMsg = e.error; } catch {} throw new Error(errMsg || 'Ocurrió un error. Intenta de nuevo.'); }
        const data = await resp.json();
        multiplayerSessionId = data.session.id;
        showMultiplayerLobby(data);
        startMultiplayerPolling();
        if (multiplayerBtn) multiplayerBtn.style.display = 'inline-block';
    } catch (err) {
        if (multiplayerCreateError) multiplayerCreateError.textContent = friendlyError(err, 'multiplayer-create');
    } finally {
        setLoading(multiplayerCreateBtn, false);
    }
});

multiplayerJoinBtn?.addEventListener('click', async () => {
    const code = multiplayerCodeInput?.value.trim().toUpperCase();
    if (!code) { if (multiplayerJoinError) multiplayerJoinError.textContent = 'Ingresa un código'; return; }
    if (multiplayerJoinError) multiplayerJoinError.textContent = '';
    setLoading(multiplayerJoinBtn, true);
    try {
        const resp = await adminFetch('/api/multiplayer/join', {
            method: 'POST',
            body: JSON.stringify({ code }),
        });
        if (!resp.ok) { let errMsg; try { const e = await resp.json(); errMsg = e.error; } catch {} throw new Error(errMsg || 'Ocurrió un error. Intenta de nuevo.'); }
        const data = await resp.json();
        multiplayerSessionId = data.session.id;
        showMultiplayerLobby(data);
        startMultiplayerPolling();
        if (multiplayerBtn) multiplayerBtn.style.display = 'inline-block';
    } catch (err) {
        if (multiplayerJoinError) multiplayerJoinError.textContent = friendlyError(err, 'multiplayer-join');
    } finally {
        setLoading(multiplayerJoinBtn, false);
    }
});

multiplayerLeaveBtn?.addEventListener('click', async () => {
    if (!multiplayerSessionId) { resetMultiplayerSession(); return; }
    setLoading(multiplayerLeaveBtn, true);
    try {
        await adminFetch('/api/multiplayer/leave', {
            method: 'POST',
            body: JSON.stringify({ session_id: multiplayerSessionId }),
        });
    } catch (err) {
        logClientError(err?.message || 'multiplayer-leave error', 'multiplayer-leave');
    }
    resetMultiplayerSession();
    setLoading(multiplayerLeaveBtn, false);
    multiplayerModal.style.display = 'none';
});

multiplayerStartBtn?.addEventListener('click', async () => {
    if (!multiplayerSessionId) return;
    setLoading(multiplayerStartBtn, true);
    try {
        const resp = await adminFetch(`/api/multiplayer/start/${multiplayerSessionId}`, { method: 'POST' });
        if (!resp.ok) { let errMsg; try { const e = await resp.json(); errMsg = e.error; } catch {} throw new Error(errMsg || 'Ocurrió un error. Intenta de nuevo.'); }
        multiplayerModal.style.display = 'none';
        startLesson();
    } catch (err) {
        Swal.fire('Error', friendlyError(err, 'multiplayer-start'), 'error');
    } finally {
        setLoading(multiplayerStartBtn, false);
    }
});

// ---- Settings modal ----
const settingsModal = document.getElementById('settings-modal');
const settingsBtn = document.getElementById('settings-btn');
const settingsClose = document.getElementById('settings-modal-close');

if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        settingsModal.style.display = 'flex';
        history.pushState({ settingsModal: true }, '');
        const showSettings = token ? 'block' : 'none';
        ['key-mappings-section', 'practice-options-section'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = showSettings;
        });
        loadAppInfo();
    });
}

if (settingsClose) {
    settingsClose.addEventListener('click', () => { settingsModal.style.display = 'none'; });
}

settingsModal?.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.style.display = 'none';
});

// ---- Password change ----
const passwordForm = document.getElementById('password-form');
const passwordError = document.getElementById('password-error');
const passwordSuccess = document.getElementById('password-success');

if (passwordForm) {
    passwordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        passwordError.textContent = '';
        passwordSuccess.textContent = '';
        const current = document.getElementById('pass-current').value;
        const newPass = document.getElementById('pass-new').value;
        const confirmPass = document.getElementById('pass-confirm').value;
        if (!token) { passwordError.textContent = 'Inicia sesión primero'; return; }
        if (newPass.length < 4) { passwordError.textContent = 'Mínimo 4 caracteres'; return; }
        if (newPass !== confirmPass) { passwordError.textContent = 'Las contraseñas no coinciden'; return; }
        const btn = passwordForm.querySelector('button[type="submit"]');
        setLoading(btn, true);
        try {
            const resp = await fetch(`${API_URL}/api/change-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ current_password: current, new_password: newPass }),
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Error');
            passwordSuccess.textContent = '✅ Contraseña actualizada correctamente';
            passwordForm.reset();
        } catch (err) {
            passwordError.textContent = friendlyError(err, 'password-change');
        } finally {
            setLoading(btn, false);
        }
    });
}

// ---- Delete account ----
const deleteAccountBtn = document.getElementById('delete-account-btn');
const deleteAccountMsg = document.getElementById('delete-account-msg');

if (deleteAccountBtn) {
    deleteAccountBtn.addEventListener('click', async () => {
        deleteAccountMsg.textContent = '';
        if (!token) { deleteAccountMsg.textContent = 'No autenticado'; return; }

        const confirmed = await Swal.fire({
            title: '¿Eliminar cuenta?',
            text: 'Todos tus datos se borrarán permanentemente. Esta acción no se puede deshacer.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#6b7280',
            confirmButtonText: 'Sí, eliminar',
            cancelButtonText: 'Cancelar'
        });
        if (!confirmed.isConfirmed) return;

        const secondConfirm = await Swal.fire({
            title: '¿Estás seguro?',
            text: 'Escribe "ELIMINAR" para confirmar',
            icon: 'warning',
            input: 'text',
            inputPlaceholder: 'ELIMINAR',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            confirmButtonText: 'Eliminar definitivamente',
            cancelButtonText: 'Cancelar',
            preConfirm: (value) => {
                if (value !== 'ELIMINAR') {
                    Swal.showValidationMessage('Debes escribir ELIMINAR');
                }
            }
        });
        if (!secondConfirm.isConfirmed) return;

        setLoading(deleteAccountBtn, true);
        try {
            const resp = await fetch(`${API_URL}/api/account`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error);
            token = null;
            currentUser = null;
            Swal.fire({
                icon: 'success',
                title: 'Cuenta eliminada',
                text: data.message,
                timer: 3000,
                timerProgressBar: true,
            });
            setTimeout(() => window.location.reload(), 3000);
        } catch (err) {
            deleteAccountMsg.textContent = friendlyError(err, 'delete-account');
        } finally {
            setLoading(deleteAccountBtn, false);
        }
    });
}

// Check connection on load
setTimeout(async () => {
    const ok = await testConnection(API_URL);
    updateConnectionStatus(ok);
}, 500);

// Refresh connection status after successful operations
function refreshConnectionStatus() {
    testConnection(API_URL).then(ok => updateConnectionStatus(ok));
}

let token = null;
let currentUser = null;
let currentLesson = null;
let currentNoteIndex = 0;
let score = 0;
let lessonActive = false;
let playedNotes = [];
let lessonStartTime = 0;
let lastNoteTime = 0;
let flatTiming = [];
let flatTexts = [];
let practiceNotes = [];
let gameRunning = false;
let gameFrameId = null;
let combo = 0;
let bestCombo = 0;
let totalHits = 0;
let totalNotes = 0;
let multiplayerSessionId = null;
let multiplayerPollInterval = null;
let multiplayerScoreSubmitted = false;
let duetMode = false;
const duetToggleBtn = document.getElementById('duet-toggle-btn');
const duetOverlay = document.getElementById('duet-overlay');
duetToggleBtn?.addEventListener('click', toggleDuetMode);

// Shared piano config
const NOTE_NAMES = { 'C': 'Do', 'D': 'Re', 'E': 'Mi', 'F': 'Fa', 'G': 'Sol', 'A': 'La', 'B': 'Si' };
const SEMITONES = { 'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11 };
const WHITE_KEYS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const BLACK_POS = { 'C': 'C#', 'D': 'D#', 'F': 'F#', 'G': 'G#', 'A': 'A#' };
const BASE_OCTAVE = 4;
const KEY_MAP = {
    // Home row = naturales, Top row = sostenidos, empieza desde Q = Do#1
    'a': ['C', 0], 'q': ['C#', 0],
    's': ['D', 0], 'w': ['D#', 0],
    'd': ['E', 0],
    'f': ['F', 0], 'e': ['F#', 0],
    'g': ['G', 0], 'r': ['G#', 0],
    'h': ['A', 0], 't': ['A#', 0],
    'j': ['B', 0],
    'k': ['C', 1], 'y': ['C#', 1],
    'l': ['D', 1], 'u': ['D#', 1],
    'ñ': ['E', 1],
    "'": ['C', 2],
    'm': ['F', 1], 'i': ['F#', 1],
    ',': ['G', 1], 'o': ['G#', 1],
    '.': ['A', 1], 'p': ['A#', 1],
    '-': ['B', 1],
};

const MAPPABLE_KEYS = Object.keys(KEY_MAP).sort((a, b) => {
    const order = 'aqswdfegrhtjkyluñ\'mi,o.p-';
    return order.indexOf(a) - order.indexOf(b);
});

let practiceOctaveShift = 0;
let editorOctaveShift = 0;
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// Canvas roundRect polyfill for older browsers
if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
        if (r > w / 2) r = w / 2;
        if (r > h / 2) r = h / 2;
        this.moveTo(x + r, y);
        this.lineTo(x + w - r, y);
        this.quadraticCurveTo(x + w, y, x + w, y + r);
        this.lineTo(x + w, y + h - r);
        this.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        this.lineTo(x + r, y + h);
        this.quadraticCurveTo(x, y + h, x, y + h - r);
        this.lineTo(x, y + r);
        this.quadraticCurveTo(x, y, x + r, y);
        this.closePath();
        return this;
    };
}

// Editor state
let editingLessonId = null;
let segments = [];
let isRecording = false;
let recordingStartTime = 0;
let currentSegmentNotes = [];
let recordingTimerInterval = null;

// ---- Shared utilities ----

function getNoteName(relNote, relOct, shift) {
    return relNote + (BASE_OCTAVE + shift + relOct);
}

function getFrequency(noteName) {
    const m = noteName.match(/^([A-Z]#?)(\d+)$/);
    if (!m) return 440;
    const midi = parseInt(m[2]) * 12 + (SEMITONES[m[1]] || 0);
    return 440 * Math.pow(2, (midi - 69) / 12);
}

function getDisplayName(noteName) {
    const m = noteName.match(/^([A-Z]#?)(\d+)$/);
    if (!m) return noteName;
    const base = NOTE_NAMES[m[1].replace('#', '')] || m[1].replace('#', '♯');
    return base + (m[1].includes('#') ? '♯' : '') + m[2];
}

function playNote(frequency, duration = 0.5) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
}

function getActiveNotes(shift) {
    const base = BASE_OCTAVE + shift;
    const notes = [];
    const blackNotes = {};
    for (let oct = base; oct <= base + 1; oct++) {
        for (const w of WHITE_KEYS) {
            const wn = w + oct;
            notes.push(wn);
            if (BLACK_POS[w]) {
                blackNotes[wn] = BLACK_POS[w] + oct;
            }
        }
    }
    return { notes, blackNotes };
}

function getNotePlayer(note) {
    const m = note.match(/^[A-Z]#?(\d+)$/);
    if (!m) return null;
    const oct = parseInt(m[1]);
    const base = BASE_OCTAVE + practiceOctaveShift;
    if (oct === base) return 1;
    if (oct === base + 1) return 2;
    return null;
}

function getComputedNote(eKey, shift) {
    const map = window.__KEY_MAP || KEY_MAP;
    const entry = map[eKey.toLowerCase()];
    if (!entry) return null;
    const [relNote, relOct] = entry;
    return getNoteName(relNote, relOct, shift);
}

function formatTime(ms) {
    const totalSec = ms / 1000;
    const min = Math.floor(totalSec / 60);
    const sec = Math.floor(totalSec % 60);
    const tenth = Math.floor((totalSec % 1) * 10);
    return `${min}:${String(sec).padStart(2, '0')}.${tenth}`;
}

function buildPianoIn(containerId, shift, onPress, onRelease) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    const { notes, blackNotes } = getActiveNotes(shift);
    const addEvents = (el, note) => {
        el.addEventListener('mousedown', (e) => { e.preventDefault(); onPress(note); });
        el.addEventListener('mouseup', () => onRelease(note));
        el.addEventListener('mouseleave', () => onRelease(note));
        el.addEventListener('touchstart', (e) => { e.preventDefault(); onPress(note); }, { passive: false });
        el.addEventListener('touchend', (e) => { e.preventDefault(); onRelease(note); }, { passive: false });
        el.addEventListener('touchcancel', () => onRelease(note));
    };
    notes.forEach(note => {
        const key = document.createElement('div');
        key.className = 'key white';
        key.dataset.note = note;
        key.textContent = getDisplayName(note);
        addEvents(key, note);
        container.appendChild(key);
        if (blackNotes[note]) {
            const black = document.createElement('div');
            black.className = 'key black';
            black.dataset.note = blackNotes[note];
            black.textContent = getDisplayName(blackNotes[note]);
            addEvents(black, blackNotes[note]);
            container.appendChild(black);
        }
    });
}

// ---- DOM refs ----
const authSection = document.getElementById('auth-section');
const lessonsSection = document.getElementById('lessons-section');
const pianoSection = document.getElementById('piano-section');
const adminSection = document.getElementById('admin-section');
const editorSection = document.getElementById('editor-section');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');
const verifySection = document.getElementById('verify-section');
const registerSuccessMsg = document.getElementById('register-success-msg');
const verifyCodeInput = document.getElementById('verify-code');
const verifyBtn = document.getElementById('verify-btn');
const resendBtn = document.getElementById('resend-btn');
const verifyBackBtn = document.getElementById('verify-back-btn');
const verifyError = document.getElementById('verify-error');
const lessonsList = document.getElementById('lessons-list');
const lessonTitle = document.getElementById('piano-lesson-title');
const lessonDescription = document.getElementById('lesson-description');
const noteIndicator = null;
const scoreDisplay = document.getElementById('piano-score');
const resultDisplay = document.getElementById('result-display');
const startLessonBtn = document.getElementById('start-lesson-btn');
const resetLessonBtn = document.getElementById('reset-lesson-btn');
const backBtn = document.getElementById('back-to-lessons');
const usernameDisplay = document.getElementById('username-display');
const logoutBtn = document.getElementById('logout-btn');
const adminBtn = document.getElementById('admin-btn');
const backToLessonsBtn = document.getElementById('back-to-lessons-btn');
const pianoComboEl = document.getElementById('piano-combo');
const pianoBestComboEl = document.getElementById('piano-best-combo');
const highTextEl = document.getElementById('highway-text-display');
const pianoTempoDisplay = document.getElementById('piano-tempo-display');
const pianoOctaveDisplay = document.getElementById('piano-octave-display');
const octaveIndicator = document.getElementById('octave-indicator');
let highwayCanvas = document.getElementById('highway-canvas');
let highwayCtx = highwayCanvas ? highwayCanvas.getContext('2d') : null;
let pianoKeyStartX = 10;

// ---- Password visibility toggle ----
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-toggle-pass');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.textContent = isPassword ? '🙈' : '👁';
    btn.title = isPassword ? 'Ocultar contraseña' : 'Mostrar contraseña';
});

// ---- Auth ----
const tabs = document.querySelectorAll('.tab');
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        loginForm.style.display = target === 'login' ? 'flex' : 'none';
        registerForm.style.display = target === 'register' ? 'flex' : 'none';
        verifySection.style.display = 'none';
    });
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const btn = loginForm.querySelector('button[type="submit"]');
    setLoading(btn, true);
    try {
        const resp = await fetch(`${API_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: document.getElementById('login-email').value,
                password: document.getElementById('login-password').value
            })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);
        token = data.token;
        currentUser = data.user;
        onAuthSuccess();
    } catch (err) {
        loginError.textContent = friendlyError(err, 'login');
    } finally {
        setLoading(btn, false);
    }
});

registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    registerError.textContent = '';
    verifyError.textContent = '';
    const btn = registerForm.querySelector('button[type="submit"]');
    setLoading(btn, true);
    try {
        const resp = await fetch(`${API_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: document.getElementById('register-username').value,
                email: document.getElementById('register-email').value,
                password: document.getElementById('register-password').value
            })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);
        registerSuccessMsg.textContent = data.message || 'Registro exitoso';
        registerForm.style.display = 'none';
        verifySection.style.display = 'flex';
        verifyCodeInput.value = '';
        verifyCodeInput.focus();
    } catch (err) {
        registerError.textContent = friendlyError(err, 'register');
    } finally {
        setLoading(btn, false);
    }
});

verifyBtn.addEventListener('click', async () => {
    verifyError.textContent = '';
    const code = verifyCodeInput.value.trim();
    if (!code || code.length !== 6) {
        verifyError.textContent = 'Ingresa el código de 6 dígitos';
        return;
    }
    const email = document.getElementById('register-email').value;
    setLoading(verifyBtn, true);
    try {
        const resp = await fetch(`${API_URL}/api/verify-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, code })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);
        token = data.token;
        currentUser = data.user;
        onAuthSuccess();
    } catch (err) {
        verifyError.textContent = friendlyError(err, 'verify');
    } finally {
        setLoading(verifyBtn, false);
    }
});

resendBtn.addEventListener('click', async () => {
    verifyError.textContent = '';
    const email = document.getElementById('register-email').value;
    setLoading(resendBtn, true);
    try {
        const resp = await fetch(`${API_URL}/api/resend-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);
        verifyError.textContent = '';
        registerSuccessMsg.textContent = data.message || 'Código reenviado';
    } catch (err) {
        verifyError.textContent = friendlyError(err, 'resend');
    } finally {
        setLoading(resendBtn, false);
    }
});

verifyBackBtn.addEventListener('click', () => {
    verifySection.style.display = 'none';
    registerForm.style.display = 'flex';
    registerForm.reset();
    registerSuccessMsg.textContent = '';
});

function onAuthSuccess() {
    usernameDisplay.textContent = currentUser.username;
    logoutBtn.style.display = 'inline-block';
    friendsBtn.style.display = 'inline-block';
    authSection.style.display = 'none';
    lessonsSection.style.display = 'block';
    if (currentUser.role === 'admin') adminBtn.style.display = 'inline-block';
    document.getElementById('password-section').style.display = 'block';
    document.getElementById('delete-account-section').style.display = 'block';
    refreshConnectionStatus();
    loadLessons();
    checkVersion();
    startHeartbeat();
    loadKeyMappings();
}

logoutBtn.addEventListener('click', () => {
    token = null;
    currentUser = null;
    currentLesson = null;
    usernameDisplay.textContent = '';
    logoutBtn.style.display = 'none';
    friendsBtn.style.display = 'none';
    adminBtn.style.display = 'none';
    backToLessonsBtn.style.display = 'none';
    document.getElementById('password-section').style.display = 'none';
    document.getElementById('delete-account-section').style.display = 'none';
    authSection.style.display = 'block';
    lessonsSection.style.display = 'none';
    pianoSection.style.display = 'none';
    leavePianoOrientation();
    adminSection.style.display = 'none';
    editorSection.style.display = 'none';
    loginForm.reset();
    registerForm.reset();
    verifySection.style.display = 'none';
    registerSuccessMsg.textContent = '';
    stopHeartbeat();
    resetMultiplayerSession();
});

// ---- Navigation ----
adminBtn.addEventListener('click', () => {
    lessonsSection.style.display = 'none';
    pianoSection.style.display = 'none';
    leavePianoOrientation();
    adminSection.style.display = 'block';
    adminBtn.style.display = 'none';
    backToLessonsBtn.style.display = 'inline-block';
    loadAdminLessons();
});

backToLessonsBtn.addEventListener('click', () => {
    adminSection.style.display = 'none';
    editorSection.style.display = 'none';
    pianoSection.style.display = 'none';
    leavePianoOrientation();
    lessonsSection.style.display = 'block';
    adminBtn.style.display = currentUser?.role === 'admin' ? 'inline-block' : 'none';
    backToLessonsBtn.style.display = 'none';
    loadLessons();
});

// ---- Admin Panel ----
document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.admin-panel').forEach(p => p.style.display = 'none');
        const panel = document.getElementById(tab.dataset.tab);
        if (panel) {
            panel.style.display = 'block';
            if (tab.dataset.tab === 'admin-lessons') loadAdminLessons();
            if (tab.dataset.tab === 'admin-approvals') loadAdminApprovals();
            if (tab.dataset.tab === 'admin-users') loadAdminUsers();
            if (tab.dataset.tab === 'admin-stats') loadAdminStats();
            if (tab.dataset.tab === 'admin-config') loadAdminConfig();
        }
    });
});

function adminFetch(path, options = {}) {
    return fetch(`${API_URL}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
            ...options.headers,
        },
    });
}

function getStatusBadge(status) {
    const labels = { 'draft': 'Borrador', 'pending_approval': 'En revisión', 'public': 'Pública' };
    return `<span class="status-badge status-${status}">${labels[status] || status}</span>`;
}

// ---- Admin: Lessons ----
async function loadAdminLessons() {
    const container = document.getElementById('admin-lessons-list');
    container.innerHTML = '<div class="spinner" style="margin:40px auto"></div>';
    try {
        const resp = await adminFetch('/api/admin/lessons');
        const lessons = await resp.json();
        if (!resp.ok) throw new Error(lessons.error || 'Error');
        renderAdminLessons(lessons);
    } catch (err) {
        container.innerHTML = `<p class="error">${friendlyError(err, 'admin-lessons')}</p>`;
    }
}

function renderAdminLessons(lessons) {
    const container = document.getElementById('admin-lessons-list');
    if (!lessons.length) {
        container.innerHTML = '<p class="empty-state">No hay lecciones. Crea la primera.</p>';
        return;
    }
    container.innerHTML = `
        <table class="admin-lesson-table">
            <thead><tr>
                <th>Título</th>
                <th>Dificultad</th>
                <th>Estado</th>
                <th>Aprobaciones</th>
                <th>Acciones</th>
            </tr></thead>
            <tbody>
                ${lessons.map(l => `
                    <tr>
                        <td><strong>${l.lesson.title}</strong></td>
                        <td><span class="difficulty ${l.lesson.difficulty}">${l.lesson.difficulty}</span></td>
                        <td>${getStatusBadge(l.status)}</td>
                        <td>${l.approval_count}/${l.min_approvals}</td>
                        <td>
                            <div class="admin-actions">
                                ${l.status === 'draft' ? `
                                    <button class="btn-sm edit" onclick="openEditor(${l.lesson.id})">Editar</button>
                                    <button class="btn-sm submit" onclick="submitLesson(${l.lesson.id})">Enviar</button>
                                ` : ''}
                                ${l.status === 'pending_approval' ? `
                                    <button class="btn-sm edit" onclick="openEditor(${l.lesson.id})">Editar</button>
                                ` : ''}
                                ${l.status === 'public' ? '<span class="status-badge status-public" style="font-size:0.7rem">✓ Publicada</span>' : ''}
                                <button class="btn-sm delete" onclick="deleteLesson(${l.lesson.id})">Eliminar</button>
                            </div>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
}

async function submitLesson(id) {
    const { isConfirmed } = await Swal.fire({
        title: '¿Enviar a revisión?',
        text: 'La lección quedará visible para otros administradores para su aprobación.',
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'Sí, enviar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#4a6cf7',
        background: '#16213e',
        color: '#e0e0e0',
    });
    if (!isConfirmed) return;
    const btn = document.querySelector(`button[onclick="submitLesson(${id})"]`);
    setLoading(btn, true);
    try {
        const resp = await adminFetch(`/api/admin/lessons/${id}/submit`, { method: 'POST' });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Error');
        await Swal.fire({ icon: 'success', title: 'Enviada a revisión', timer: 1500, showConfirmButton: false, background: '#16213e', color: '#e0e0e0' });
        loadAdminLessons();
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Error', text: friendlyError(err, 'admin-submit-lesson'), confirmButtonColor: '#4a6cf7', background: '#16213e', color: '#e0e0e0' });
    } finally {
        setLoading(btn, false);
    }
}

async function deleteLesson(id) {
    const { isConfirmed } = await Swal.fire({
        title: '¿Eliminar lección?',
        text: 'Esta acción no se puede deshacer.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Sí, eliminar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#dc2626',
        cancelButtonColor: '#4a4a4a',
        background: '#16213e',
        color: '#e0e0e0',
    });
    if (!isConfirmed) return;
    const btn = document.querySelector(`button[onclick="deleteLesson(${id})"]`);
    setLoading(btn, true);
    try {
        const resp = await adminFetch(`/api/admin/lessons/${id}`, { method: 'DELETE' });
        if (!resp.ok) {
            const data = await resp.json();
            throw new Error(data.error || 'Error');
        }
        await Swal.fire({ icon: 'success', title: 'Lección eliminada', timer: 1500, showConfirmButton: false, background: '#16213e', color: '#e0e0e0' });
        loadAdminLessons();
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Error', text: friendlyError(err, 'admin-delete-lesson'), confirmButtonColor: '#4a6cf7', background: '#16213e', color: '#e0e0e0' });
    } finally {
        setLoading(btn, false);
    }
}

// ---- Admin: Approvals ----
async function loadAdminApprovals() {
    const container = document.getElementById('admin-approvals-list');
    container.innerHTML = '<div class="spinner" style="margin:40px auto"></div>';
    try {
        const resp = await adminFetch('/api/admin/approvals/pending');
        const lessons = await resp.json();
        if (!resp.ok) throw new Error(lessons.error || 'Error');
        renderAdminApprovals(lessons);
    } catch (err) {
        container.innerHTML = `<p class="error">${friendlyError(err, 'admin-approvals')}</p>`;
    }
}

function renderAdminApprovals(lessons) {
    const container = document.getElementById('admin-approvals-list');
    if (!lessons.length) {
        container.innerHTML = '<p class="empty-state">No hay lecciones pendientes de aprobación.</p>';
        return;
    }
    container.innerHTML = lessons.map(l => `
        <div class="approval-card">
            <h4>${l.lesson.title}</h4>
            <p>${l.lesson.description}</p>
            <div class="approval-meta">
                <span>Dificultad: ${l.lesson.difficulty}</span>
                <span>Aprobaciones: ${l.approval_count}/${l.min_approvals}</span>
            </div>
            <button class="btn-sm approve" onclick="approveLesson(${l.lesson.id})">✓ Aprobar</button>
        </div>
    `).join('');
}

async function approveLesson(id) {
    const btn = document.querySelector(`button[onclick="approveLesson(${id})"]`);
    setLoading(btn, true);
    try {
        const resp = await adminFetch(`/api/admin/lessons/${id}/approve`, {
            method: 'POST',
            body: JSON.stringify({ comment: null }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Error');
        const msg = data.new_status === 'public'
            ? '✅ Lección aprobada y publicada automáticamente.'
            : `✅ Aprobación registrada (${data.approval_count}/${data.min_approvals})`;
        await Swal.fire({ icon: 'success', title: msg, timer: 2000, showConfirmButton: false, background: '#16213e', color: '#e0e0e0' });
        loadAdminApprovals();
        loadAdminLessons();
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Error', text: friendlyError(err, 'admin-approve-lesson'), confirmButtonColor: '#4a6cf7', background: '#16213e', color: '#e0e0e0' });
    } finally {
        setLoading(btn, false);
    }
}

// ---- Admin: Users ----
document.getElementById('admin-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('admin-user-error');
    const successEl = document.getElementById('admin-user-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    const btn = e.target.querySelector('button[type="submit"]');
    setLoading(btn, true);
    try {
        const resp = await adminFetch('/api/admin/users', {
            method: 'POST',
            body: JSON.stringify({
                username: document.getElementById('admin-new-username').value,
                email: document.getElementById('admin-new-email').value,
                password: document.getElementById('admin-new-password').value,
            }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Error');
        successEl.textContent = `✅ Admin "${data.username}" creado.`;
        e.target.reset();
        loadAdminUsers();
    } catch (err) {
        errorEl.textContent = friendlyError(err, 'admin-create-user');
    } finally {
        setLoading(btn, false);
    }
});

// ---- Admin: Users List ----
async function loadAdminUsers() {
    const container = document.getElementById('admin-users-list');
    container.innerHTML = '<div class="spinner" style="margin:40px auto"></div>';
    try {
        const resp = await adminFetch('/api/admin/users');
        const users = await resp.json();
        if (!resp.ok) throw new Error(users.error || 'Error');
        if (!users.length) {
            container.innerHTML = '<p class="empty">No hay usuarios registrados.</p>';
            return;
        }
        const roleBadge = (role) => role === 'admin'
            ? '<span class="badge badge-admin">Admin</span>'
            : '<span class="badge badge-user">Usuario</span>';
        container.innerHTML = `
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>Usuario</th>
                        <th>Correo</th>
                        <th>Rol</th>
                        <th>Lecciones Completadas</th>
                        <th>Registrado</th>
                    </tr>
                </thead>
                <tbody>
                    ${users.map(u => `
                        <tr>
                            <td><strong>${escapeHtml(u.username)}</strong></td>
                            <td>${escapeHtml(u.email)}</td>
                            <td>${roleBadge(u.role)}</td>
                            <td>${u.lessons_completed}</td>
                            <td>${new Date(u.created_at).toLocaleDateString()}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>`;
    } catch (err) {
        document.getElementById('admin-users-list').innerHTML = `<p class="error">${escapeHtml(friendlyError(err, 'admin-users'))}</p>`;
    }
}

// ---- Admin: Stats ----
let statsCharts = {};

function destroyStatsCharts() {
    Object.values(statsCharts).forEach(c => { if (c) c.destroy(); });
    statsCharts = {};
}

async function loadAdminStats() {
    destroyStatsCharts();
    document.getElementById('admin-stats-cards').innerHTML = '<div class="spinner" style="margin:40px auto;grid-column:1/-1"></div>';
    try {
        const resp = await adminFetch('/api/admin/stats');
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Error');

        // Summary cards
        const cardsContainer = document.getElementById('admin-stats-cards');
        cardsContainer.innerHTML = `
            <div class="stat-card"><span class="stat-val">${data.total_users}</span><span class="stat-label">Usuarios</span></div>
            <div class="stat-card"><span class="stat-val">${data.total_lessons}</span><span class="stat-label">Lecciones Públicas</span></div>
            <div class="stat-card"><span class="stat-val">${data.total_completions}</span><span class="stat-label">Lecciones Completadas</span></div>
        `;

        // Chart.js — Completions by lesson (bar)
        const lessonLabels = data.completions_by_lesson.map(l => l.title);
        const lessonCounts = data.completions_by_lesson.map(l => l.completions);
        const lessonColors = lessonLabels.map(() => `hsl(${Math.random() * 360}, 70%, 60%)`);

        const ctxL = document.getElementById('chart-lessons').getContext('2d');
        statsCharts.lessons = new Chart(ctxL, {
            type: 'bar',
            data: {
                labels: lessonLabels,
                datasets: [{
                    label: 'Completaciones',
                    data: lessonCounts,
                    backgroundColor: lessonColors,
                    borderRadius: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                },
                scales: {
                    y: { beginAtZero: true, ticks: { stepSize: 1, color: '#aaa' }, grid: { color: '#2a2a4a' } },
                    x: { ticks: { color: '#ccc', maxRotation: 45 } },
                },
            },
        });

        // Chart.js — Completions by difficulty (pie)
        const diffLabels = data.completions_by_difficulty.map(d => d.difficulty || 'sin nivel');
        const diffCounts = data.completions_by_difficulty.map(d => d.completions);
        const diffColors = ['#4a6cf7', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6'];

        const ctxD = document.getElementById('chart-difficulty').getContext('2d');
        statsCharts.difficulty = new Chart(ctxD, {
            type: 'pie',
            data: {
                labels: diffLabels,
                datasets: [{
                    data: diffCounts,
                    backgroundColor: diffColors.slice(0, diffLabels.length),
                    borderColor: '#16213e',
                    borderWidth: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: '#ccc', padding: 12 },
                    },
                },
            },
        });
    } catch (err) {
        document.getElementById('admin-stats-cards').innerHTML = `<p class="error">${escapeHtml(friendlyError(err, 'admin-stats'))}</p>`;
    }
}

// ---- Admin: Config ----
async function loadAdminConfig() {
    try {
        document.getElementById('admin-min-approvals').disabled = true;
        const resp = await adminFetch('/api/admin/config');
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Error');
        document.getElementById('admin-min-approvals').value = data.min_approvals;
    } catch (err) {
        document.getElementById('admin-config-error').textContent = friendlyError(err, 'admin-config-load');
    } finally {
        document.getElementById('admin-min-approvals').disabled = false;
    }
}

document.getElementById('admin-config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('admin-config-error');
    const successEl = document.getElementById('admin-config-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    const btn = e.target.querySelector('button[type="submit"]');
    setLoading(btn, true);
    try {
        const resp = await adminFetch('/api/admin/config', {
            method: 'PUT',
            body: JSON.stringify({
                min_approvals: parseInt(document.getElementById('admin-min-approvals').value),
            }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Error');
        successEl.textContent = '✅ Configuración guardada.';
    } catch (err) {
        errorEl.textContent = friendlyError(err, 'admin-config-save');
    } finally {
        setLoading(btn, false);
    }
});

// ---- Lesson Editor ----
document.getElementById('new-lesson-btn').addEventListener('click', () => openEditor(null));
document.getElementById('editor-back-btn').addEventListener('click', closeEditor);
document.getElementById('editor-cancel-btn').addEventListener('click', closeEditor);

function openEditor(lessonId) {
    editingLessonId = lessonId;
    segments = [];
    isRecording = false;

    document.getElementById('editor-error').textContent = '';
    document.getElementById('editor-title').textContent = lessonId ? 'Editar Lección' : 'Nueva Lección';
    document.getElementById('editor-lesson-title').value = '';
    document.getElementById('editor-lesson-desc').value = '';
    document.getElementById('editor-lesson-difficulty').value = 'beginner';
    document.getElementById('editor-tempo').value = '80';

    // Hide admin/lessons, show editor
    adminSection.style.display = 'none';
    lessonsSection.style.display = 'none';
    pianoSection.style.display = 'none';
    leavePianoOrientation();
    editorSection.style.display = 'block';
    backToLessonsBtn.style.display = 'none';
    adminBtn.style.display = 'none';

    // Build editor piano
    editorOctaveShift = 0;
    buildEditorPiano();
    updateEditorOctaveDisplay();
    renderSegments();

    // If editing, load existing data
    if (lessonId) {
        loadLessonIntoEditor(lessonId);
    }
}

function closeEditor() {
    stopRecording();
    editorSection.style.display = 'none';
    adminSection.style.display = 'block';
    adminBtn.style.display = 'none';
    backToLessonsBtn.style.display = 'inline-block';
    loadAdminLessons();
}

async function loadLessonIntoEditor(id) {
    const saveBtn = document.getElementById('editor-save-btn');
    setLoading(saveBtn, true);
    try {
        const resp = await adminFetch(`/api/admin/lessons/${id}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Error');
        const l = data.lesson;
        document.getElementById('editor-lesson-title').value = l.title;
        document.getElementById('editor-lesson-desc').value = l.description;
        document.getElementById('editor-lesson-difficulty').value = l.difficulty;
        document.getElementById('editor-tempo').value = l.content?.tempo || 80;

        // Load segments from content
        if (l.content?.segments) {
            segments = l.content.segments.map(s => ({
                notes: [...s.notes],
                timing: [...s.timing],
                texts: s.texts ? s.texts.map(t => ({ ...t })) : [],
            }));
            renderSegments();
        }
    } catch (err) {
        document.getElementById('editor-error').textContent = 'Error al cargar: ' + friendlyError(err, 'editor-load');
    } finally {
        setLoading(saveBtn, false);
    }
}

// ---- Editor Piano ----
function buildEditorPiano() {
    buildPianoIn('editor-piano', editorOctaveShift, onEditorKeyPress, onEditorKeyRelease);
}

function updateEditorOctaveDisplay() {
    const el = document.getElementById('editor-octave-display');
    if (el) {
        const base = BASE_OCTAVE + editorOctaveShift;
        el.textContent = `${getDisplayName('C' + base)} – ${getDisplayName('B' + (base + 1))}`;
    }
}

function shiftEditorOctave(delta) {
    const ns = editorOctaveShift + delta;
    if (ns < -3 || ns > 3) return;
    editorOctaveShift = ns;
    buildEditorPiano();
    updateEditorOctaveDisplay();
}

function onEditorKeyPress(note) {
    const freq = getFrequency(note);
    if (freq) playNote(freq, 0.4);
    const el = document.querySelector('#editor-piano .key[data-note="' + note + '"]');
    if (el) el.classList.add('active');
    if (isRecording) {
        const elapsed = performance.now() - recordingStartTime;
        currentSegmentNotes.push({ note, time: elapsed });
        updateRecordingStatus();
    }
}

function onEditorKeyRelease(note) {
    const el = document.querySelector('#editor-piano .key[data-note="' + note + '"]');
    if (el) el.classList.remove('active');
}

// ---- Recording ----
document.getElementById('record-btn').addEventListener('click', startRecording);
document.getElementById('stop-btn').addEventListener('click', stopRecording);

function startRecording() {
    if (isRecording) return;
    isRecording = true;
    currentSegmentNotes = [];
    recordingStartTime = performance.now();

    document.getElementById('record-btn').classList.add('recording');
    document.getElementById('record-btn').style.display = 'none';
    document.getElementById('stop-btn').style.display = 'inline-block';
    document.getElementById('recording-status').textContent = '🔴 Grabando...';

    recordingTimerInterval = setInterval(() => {
        const elapsed = performance.now() - recordingStartTime;
        document.getElementById('recording-timer').textContent = formatTime(elapsed);
    }, 100);
}

function stopRecording() {
    if (!isRecording) return;
    isRecording = false;

    clearInterval(recordingTimerInterval);
    document.getElementById('record-btn').classList.remove('recording');
    document.getElementById('record-btn').style.display = 'inline-block';
    document.getElementById('stop-btn').style.display = 'none';
    document.getElementById('recording-status').textContent = '';

    const elapsed = performance.now() - recordingStartTime;
    document.getElementById('recording-timer').textContent = formatTime(elapsed);

    if (currentSegmentNotes.length > 0) {
        segments.push({
            notes: currentSegmentNotes.map(n => n.note),
            timing: currentSegmentNotes.map(n => Math.round(n.time)),
            texts: [],
        });
        renderSegments();
    }
}

function updateRecordingStatus() {
    const count = currentSegmentNotes.length;
    document.getElementById('recording-status').textContent = `🔴 Grabando... ${count} nota(s)`;
}

// ---- Segments ----
function renderSegments() {
    const list = document.getElementById('segments-list');
    const empty = document.getElementById('segments-empty');
    const count = document.getElementById('segments-count');

    count.textContent = segments.length ? `(${segments.length})` : '';

    if (segments.length === 0) {
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';

    list.innerHTML = segments.map((seg, i) => {
        const dur = seg.timing.length > 0 ? seg.timing[seg.timing.length - 1] : 0;
        return `
            <div class="segment-card">
                <div class="segment-info">
                    <span class="segment-number">${i + 1}</span>
                    <div class="segment-details">
                        <strong>${seg.notes.length} notas</strong>
                        <span>${formatTime(dur)}</span>
                        ${seg.texts.length ? `<span>📝 ${seg.texts.length} texto(s)</span>` : ''}
                    </div>
                </div>
                <div class="segment-actions">
                    <button class="btn-icon play" onclick="playSegment(${i})">▶</button>
                    <button class="btn-icon texts" onclick="openTextEditor(${i})">📝 Textos</button>
                    <button class="btn-icon delete-seg" onclick="deleteSegment(${i})">✕</button>
                </div>
            </div>
        `;
    }).join('');
}

function playSegment(index) {
    const seg = segments[index];
    if (!seg || seg.notes.length === 0) return;
    const startTime = performance.now();
    seg.notes.forEach((note, i) => {
        const delay = seg.timing[i] || 0;
        setTimeout(() => {
            playNote(getFrequency(note), 0.4);
            const el = document.querySelector('#editor-piano .key[data-note="' + note + '"]');
            if (el) {
                el.classList.add('active');
                setTimeout(() => el.classList.remove('active'), 300);
            }
        }, delay);
    });
}

async function deleteSegment(index) {
    const result = await Swal.fire({
        title: '¿Eliminar grabación?',
        text: `Se eliminará la grabación ${index + 1} con sus ${segments[index]?.texts.length || 0} texto(s).`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Eliminar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#dc2626',
        cancelButtonColor: '#4a4a4a',
        background: '#16213e',
        color: '#e0e0e0',
    });
    if (!result.isConfirmed) return;
    segments.splice(index, 1);
    renderSegments();
}

// ---- Text Editor ----
let editingSegmentIndex = -1;

document.getElementById('text-modal-close').addEventListener('click', closeTextEditor);
document.getElementById('text-done-btn').addEventListener('click', closeTextEditor);
document.getElementById('text-add-btn').addEventListener('click', addText);
document.getElementById('text-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('text-modal')) closeTextEditor();
});

function openTextEditor(segIndex) {
    editingSegmentIndex = segIndex;
    const seg = segments[segIndex];
    document.getElementById('text-modal-subtitle').textContent =
        `Grabación ${segIndex + 1} — ${seg.notes.length} notas`;
    document.getElementById('text-error').textContent = '';
    document.getElementById('text-timestamp-input').value = '';
    document.getElementById('text-content-input').value = '';
    renderTexts();
    document.getElementById('text-modal').style.display = 'flex';
}

function closeTextEditor() {
    editingSegmentIndex = -1;
    document.getElementById('text-modal').style.display = 'none';
}

function renderTexts() {
    const container = document.getElementById('text-list');
    const seg = segments[editingSegmentIndex];
    if (!seg) return;
    if (seg.texts.length === 0) {
        container.innerHTML = '<p style="color:#666;font-size:0.85rem">Sin textos aún. Añade el primero.</p>';
        return;
    }
    container.innerHTML = seg.texts.map((t, i) => `
        <div class="text-item">
            <span class="text-time">${formatTime(t.timestamp)}</span>
            <span class="text-content">${escapeHtml(t.text)}</span>
            <button class="text-del" onclick="deleteText(${i})">✕</button>
        </div>
    `).join('');
}

function addText() {
    const seg = segments[editingSegmentIndex];
    if (!seg) return;
    const timeInput = document.getElementById('text-timestamp-input');
    const textInput = document.getElementById('text-content-input');
    const errorEl = document.getElementById('text-error');
    errorEl.textContent = '';

    const timestamp = parseFloat(timeInput.value);
    if (isNaN(timestamp) || timestamp < 0) {
        errorEl.textContent = 'Ingresa un tiempo válido (ej: 1.5)';
        return;
    }
    if (!textInput.value.trim()) {
        errorEl.textContent = 'Ingresa un texto descriptivo';
        return;
    }

    seg.texts.push({
        timestamp: Math.round(timestamp * 1000),
        text: textInput.value.trim(),
    });
    seg.texts.sort((a, b) => a.timestamp - b.timestamp);
    timeInput.value = '';
    textInput.value = '';
    renderTexts();
    renderSegments();
}

function deleteText(index) {
    const seg = segments[editingSegmentIndex];
    if (!seg) return;
    seg.texts.splice(index, 1);
    renderTexts();
    renderSegments();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ---- Save Lesson ----
document.getElementById('editor-save-btn').addEventListener('click', saveLesson);

async function saveLesson() {
    const errorEl = document.getElementById('editor-error');
    errorEl.textContent = '';

    const title = document.getElementById('editor-lesson-title').value.trim();
    if (!title) {
        errorEl.textContent = 'El título es obligatorio.';
        return;
    }
    if (segments.length === 0) {
        errorEl.textContent = 'Debes grabar al menos una secuencia de notas.';
        return;
    }

    // Build expected array from all segment notes
    const expected = segments.flatMap(s => s.notes);
    const tempo = parseInt(document.getElementById('editor-tempo').value) || 80;

    const body = {
        title,
        description: document.getElementById('editor-lesson-desc').value.trim(),
        difficulty: document.getElementById('editor-lesson-difficulty').value,
        content: { segments, expected, tempo },
    };

    const btn = document.getElementById('editor-save-btn');
    setLoading(btn, true);
    try {
        const url = editingLessonId
            ? `/api/admin/lessons/${editingLessonId}`
            : '/api/admin/lessons';
        const method = editingLessonId ? 'PUT' : 'POST';
        const resp = await adminFetch(url, { method, body: JSON.stringify(body) });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Error al guardar');
        closeEditor();
    } catch (err) {
        errorEl.textContent = friendlyError(err, 'editor-save');
    } finally {
        setLoading(btn, false);
    }
}

// ---- Lessons (public) ----
async function loadLessons() {
    lessonsList.innerHTML = '<div class="spinner" style="margin:40px auto"></div>';
    try {
        const resp = await fetch(`${API_URL}/api/lessons`);
        const lessons = await resp.json();
        renderLessons(lessons);
        if (token) loadProgress();
    } catch (err) {
        lessonsList.innerHTML = `<p class="error">${friendlyError(err, 'lessons-list')}</p>`;
    }
}

async function loadProgress() {
    try {
        const resp = await fetch(`${API_URL}/api/progress`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!resp.ok) return;
        const progress = await resp.json();
        const completed = {};
        progress.forEach(p => { completed[p.progress.lesson_id] = p.progress; });
        document.querySelectorAll('.lesson-card').forEach(card => {
            const id = parseInt(card.dataset.id);
            if (completed[id] && completed[id].completed) {
                const badge = card.querySelector('.completed-badge') || document.createElement('span');
                badge.className = 'completed-badge';
                badge.textContent = '✓ Completada';
                card.querySelector('h3').after(badge);
            }
        });
    } catch (err) {
        // ignore
    }
}

function renderLessons(lessons) {
    lessonsList.innerHTML = lessons.map(l => {
        const isDuet = l.content?.duet === true;
        return `
        <div class="lesson-card" data-id="${l.id}" onclick="openLesson(${l.id})">
            <h3>${l.title}</h3>
            <p>${l.description}</p>
            <div class="lesson-card-tags">
                <span class="difficulty ${l.difficulty}">${l.difficulty}</span>
                ${isDuet ? '<span class="duet-badge">👫 Dúo</span>' : ''}
            </div>
        </div>
    `}).join('');
}

async function openLesson(id) {
    try {
        lessonsList.innerHTML = '<div class="spinner" style="margin:40px auto"></div>';
        const resp = await fetch(`${API_URL}/api/lessons/${id}`);
        const lesson = await resp.json();
        currentLesson = lesson;
        lessonsSection.style.display = 'none';
        pianoSection.style.display = 'block';
        history.pushState({ piano: true }, '');
        handlePianoOrientation();
        if (lessonTitle) {
            lessonTitle.innerHTML = lesson.title + (lesson.content?.duet ? ' <span class="duet-badge-full">👫 Dúo</span>' : '');
        }
        if (lessonDescription) lessonDescription.textContent = lesson.description;
        resultDisplay.textContent = '';
        if (pianoTempoDisplay) pianoTempoDisplay.textContent = lesson.content?.tempo ? `${lesson.content.tempo} BPM` : '';
        scoreDisplay.textContent = '0';
        score = 0;
        practiceOctaveShift = 0;
        combo = 0;
        bestCombo = 0;
        totalHits = 0;
        currentNoteIndex = 0;
        lessonActive = false;
        playedNotes = [];
        gameRunning = false;
        practiceNotes = [];
        resetMultiplayerSession();
        startLessonBtn.style.display = 'inline-block';
        resetLessonBtn.style.display = 'none';
        if (multiplayerBtn) multiplayerBtn.style.display = token ? 'inline-block' : 'none';
        const isDuetLesson = lesson.content?.duet === true;
        if (duetToggleBtn) {
            duetToggleBtn.style.display = isDuetLesson ? 'inline-block' : 'none';
            duetToggleBtn.classList.remove('active');
        }
        if (duetOverlay) duetOverlay.style.display = 'none';
        duetMode = false;

        // Build flat timing and texts from segments
        flatTiming = [];
        flatTexts = [];
        const segs = lesson.content?.segments || [];
        let cumulativeTime = 0;
        for (const seg of segs) {
            for (let i = 0; i < (seg.notes || []).length; i++) {
                flatTiming.push(cumulativeTime + (seg.timing?.[i] || 0));
                const matching = (seg.texts || [])
                    .filter(tx => tx.timestamp <= (seg.timing?.[i] || 0));
                flatTexts.push(matching.length > 0 ? matching[matching.length - 1].text : null);
            }
            if (seg.timing?.length > 0) {
                cumulativeTime += seg.timing[seg.timing.length - 1] + 1000;
            }
        }

        // Build PracticeNote objects
        const expectedNotes = lesson.content?.expected || [];
        totalNotes = expectedNotes.length;
        practiceNotes = expectedNotes.map((n, i) => ({
            note: n,
            expectedTime: flatTiming[i] || (i * 500),
            text: flatTexts[i] || null,
            hit: false,
            missed: false,
            result: null,
        }));

        if (highTextEl) { highTextEl.textContent = ''; }
        buildPracticePiano();
        resizeHighwayCanvas();
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Error', text: friendlyError(err, 'lesson-open'), confirmButtonColor: '#4a6cf7', background: '#16213e', color: '#e0e0e0' });
    }
}

function resizeHighwayCanvas() {
    const wrapper = document.getElementById('highway-wrapper');
    const piano = document.getElementById('piano');
    if (highwayCanvas && wrapper && piano) {
        const pianoWidth = piano.scrollWidth;
        const h = wrapper.clientHeight;
        highwayCanvas.width = pianoWidth;
        highwayCanvas.height = h;
        highwayCanvas.style.width = pianoWidth + 'px';
        const firstKey = piano.querySelector('.key.white');
        if (firstKey) {
            const pianoRect = piano.getBoundingClientRect();
            const keyRect = firstKey.getBoundingClientRect();
            const canvasRect = highwayCanvas.getBoundingClientRect();
            const keyInCanvas = keyRect.left - canvasRect.left;
            pianoKeyStartX = Math.max(0, keyInCanvas);
        }
    }
}

backBtn.addEventListener('click', () => {
    stopGameLoop();
    pianoSection.style.display = 'none';
    leavePianoOrientation();
    lessonsSection.style.display = 'block';
    loadLessons();
    resetMultiplayerSession();
});

// ---- Practice Piano ----
function buildPracticePiano() {
    buildPianoIn('piano', practiceOctaveShift, onPracticeKeyPress, onPracticeKeyRelease);
    if (duetMode) applyDuetColoring();
    updatePracticeOctaveDisplay();
}

function applyDuetColoring() {
    const piano = document.getElementById('piano');
    if (!piano) return;
    piano.querySelectorAll('.key').forEach(key => {
        const note = key.dataset.note;
        const player = getNotePlayer(note);
        key.classList.remove('player1', 'player2');
        if (player === 1) key.classList.add('player1');
        else if (player === 2) key.classList.add('player2');
    });
    const base = BASE_OCTAVE + practiceOctaveShift;
    const splitNote = 'C' + (base + 1);
    const existing = piano.querySelector('.duet-divider');
    if (existing) existing.remove();
    const firstKeyP2 = piano.querySelector(`.key[data-note="${splitNote}"]`);
    if (firstKeyP2) {
        const divider = document.createElement('div');
        divider.className = 'duet-divider';
        piano.insertBefore(divider, firstKeyP2);
    }
}

function toggleDuetMode() {
    duetMode = !duetMode;
    duetToggleBtn.classList.toggle('active', duetMode);
    if (duetOverlay) duetOverlay.style.display = duetMode ? 'flex' : 'none';
    buildPracticePiano();
}

function updatePracticeOctaveDisplay() {
    const el = document.getElementById('piano-octave-display');
    if (el) {
        const base = BASE_OCTAVE + practiceOctaveShift;
        el.textContent = `${getDisplayName('C' + base)} – ${getDisplayName('B' + (base + 1))}`;
    }
}

function shiftPracticeOctave(delta) {
    const ns = practiceOctaveShift + delta;
    if (ns < -3 || ns > 3) return;
    practiceOctaveShift = ns;
    buildPracticePiano();
    updatePracticeOctaveDisplay();
}

// ---- Lane helpers for highway rendering ----
function noteToLane(n) {
    const m = n.match(/^([A-G]#?)(\d+)$/);
    if (!m) return -1;
    const letter = m[1];
    const isBlack = letter.includes('#');
    const whiteLetter = isBlack ? letter[0] : letter;
    const octave = parseInt(m[2]);
    const baseOctave = BASE_OCTAVE + practiceOctaveShift;
    const whiteKeys = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    const whiteIdx = whiteKeys.indexOf(whiteLetter);
    if (whiteIdx === -1) return -1;
    const baseIdx = (octave - baseOctave) * 7 + whiteIdx;
    return isBlack ? baseIdx + 1 : baseIdx + 0.5;
}

function noteToMidi(n) {
    const m = n.match(/^([A-G]#?)(-?\d)$/);
    if (!m) return -1;
    return (parseInt(m[2]) + 1) * 12 + SEMITONES[m[1]];
}

// ---- Game Loop ----
const FALL_DURATION = 2800;
const COUNTDOWN_MS = 3000;

function startGameLoop() {
    if (gameRunning) return;
    gameRunning = true;
    lessonStartTime = performance.now() + COUNTDOWN_MS;
    lastNoteTime = lessonStartTime;
    gameFrameId = requestAnimationFrame(gameLoop);
}

function stopGameLoop() {
    gameRunning = false;
    if (gameFrameId) { cancelAnimationFrame(gameFrameId); gameFrameId = null; }
}

function gameLoop() {
    if (!gameRunning) return;
    const elapsed = performance.now() - lessonStartTime;
    if (elapsed < 0) {
        const remaining = Math.ceil(-elapsed / 1000);
        if (highTextEl) {
            highTextEl.textContent = `⏳ ${remaining}`;
            highTextEl.style.fontSize = '2rem';
            highTextEl.style.textAlign = 'center';
            highTextEl.style.padding = '30px';
            highTextEl.style.fontWeight = 'bold';
        }
        renderHighway(elapsed);
        gameFrameId = requestAnimationFrame(gameLoop);
        return;
    }
    if (highTextEl) {
        highTextEl.style.fontSize = '';
        highTextEl.style.textAlign = '';
        highTextEl.style.padding = '';
        highTextEl.style.fontWeight = '';
    }
    renderHighway(elapsed);
    checkForMisses(elapsed);
    preGlowKeys(elapsed);
    updateHighwayText(elapsed);
    updateHUD();
    updateOctaveIndicator(elapsed);
    if (practiceNotes.every(n => n.hit || n.missed)) {
        finishLesson();
        return;
    }
    gameFrameId = requestAnimationFrame(gameLoop);
}

// ---- Canvas rendering ----
function renderHighway(elapsed) {
    if (!highwayCtx || !highwayCanvas) return;
    const ctx = highwayCtx;
    const w = highwayCanvas.width;
    const h = highwayCanvas.height;
    const padX = pianoKeyStartX + 4;
    const drawW = w - padX * 2;
    const numLanes = 14;
    const laneW = drawW / numLanes;
    const topY = 0;
    const strikeY = h * 0.88;

    ctx.clearRect(0, 0, w, h);

    // Strike line
    ctx.strokeStyle = 'rgba(74, 108, 247, 0.6)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, strikeY);
    ctx.lineTo(w, strikeY);
    ctx.stroke();
    // Strike line glow
    const glowGrad = ctx.createRadialGradient(w / 2, strikeY, 0, w / 2, strikeY, 60);
    glowGrad.addColorStop(0, 'rgba(74, 108, 247, 0.15)');
    glowGrad.addColorStop(1, 'rgba(74, 108, 247, 0)');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(0, strikeY - 60, w, 120);

    // Advance preview line
    const previewY = h * 0.62;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(74, 108, 247, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, previewY);
    ctx.lineTo(w, previewY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Faint lane dividers
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= numLanes; i++) {
        const x = padX + i * laneW;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
    }

    // Note tails
    for (const n of practiceNotes) {
        if (n.hit || n.missed) continue;
        const rel = noteToLane(n.note);
        if (rel < -0.25 || rel > numLanes + 0.25) continue;
        const progress = (elapsed - (n.expectedTime - FALL_DURATION)) / FALL_DURATION;
        if (progress < -0.1 || progress > 1.3) continue;
        const y = topY + Math.max(0, Math.min(1, progress)) * (strikeY - topY);
        const tailLen = Math.min(120, (1 - Math.max(0, progress)) * (strikeY - topY) * 0.5);
        if (tailLen > 10) {
            const grad = ctx.createLinearGradient(0, y - tailLen, 0, y);
            grad.addColorStop(0, 'rgba(255,255,255,0)');
            grad.addColorStop(1, getNoteColor(n.note, 0.15));
            ctx.fillStyle = grad;
            const lx = padX + rel * laneW;
            ctx.fillRect(lx - 2, y - tailLen, 4, tailLen);
        }
    }

    // Falling notes
    for (const n of practiceNotes) {
        if (n.hit || n.missed) continue;
        const rel = noteToLane(n.note);
        if (rel < -0.25 || rel > numLanes + 0.25) continue;
        const progress = (elapsed - (n.expectedTime - FALL_DURATION)) / FALL_DURATION;
        if (progress < -0.1) continue;
        const y = topY + Math.max(0, Math.min(1, progress)) * (strikeY - topY);
        const isBlack = n.note.includes('#');
        const nw = laneW * (isBlack ? 0.5 : 0.75);
        const nh = isBlack ? 22 : 30;
        const x = padX + rel * laneW - nw / 2;

        const secsToStrike = (n.expectedTime - elapsed) / 1000;
        let alpha = 1;
        if (secsToStrike > 2) alpha = 0.3;

        ctx.globalAlpha = alpha;
        const color = getNoteColor(n.note, 1);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y - nh / 2, nw, nh, isBlack ? 3 : 5);
        ctx.fill();

        ctx.globalAlpha = Math.min(1, alpha + 0.3);
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${isBlack ? 9 : 11}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(getDisplayName(n.note), x + nw / 2, y);
        ctx.globalAlpha = 1;
    }

    // Next note text
    const upcoming = practiceNotes
        .filter(n => !n.hit && !n.missed && (n.expectedTime - elapsed) / 1000 > -0.5)
        .sort((a, b) => a.expectedTime - b.expectedTime)[0];
    if (upcoming) {
        const secs = ((upcoming.expectedTime - elapsed) / 1000).toFixed(1);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`Siguiente: ${getDisplayName(upcoming.note)} (${secs}s)`, w - 16, strikeY - 12);
    }
}

function getNoteColor(note, alpha = 1) {
    if (duetMode) {
        const player = getNotePlayer(note);
        if (player === 1) return `rgba(74, 150, 255, ${alpha})`;
        if (player === 2) return `rgba(255, 160, 50, ${alpha})`;
    }
    return note.includes('#')
        ? `rgba(80, 100, 200, ${alpha})`
        : `rgba(200, 220, 255, ${alpha})`;
}

// ---- Pre-glow keys ----
function preGlowKeys(elapsed) {
    document.querySelectorAll('#piano .key.pre-glow').forEach(el => el.classList.remove('pre-glow'));
    const upcoming = practiceNotes
        .filter(n => !n.hit && !n.missed)
        .find(n => {
            const secs = (n.expectedTime - elapsed) / 1000;
            return secs > 0 && secs <= 1.5;
        });
    if (upcoming) {
        const el = document.querySelector(`#piano .key[data-note="${upcoming.note}"]`);
        if (el) el.classList.add('pre-glow');
    }
}

// ---- Miss detection ----
function checkForMisses(elapsed) {
    for (const n of practiceNotes) {
        if (n.hit || n.missed) continue;
        if (elapsed > n.expectedTime + 200) {
            n.missed = true;
            n.result = 'miss';
            combo = 0;
            const el = document.querySelector(`#piano .key[data-note="${n.note}"]`);
            if (el) { el.classList.add('miss'); setTimeout(() => el.classList.remove('miss'), 300); }
        }
    }
}

// ---- Update HUD ----
function updateHUD() {
    if (scoreDisplay) scoreDisplay.textContent = score;
    if (pianoComboEl) {
        pianoComboEl.textContent = combo;
        pianoComboEl.className = 'hud-stat-value' + (combo >= 10 ? ' combo-fire' : '');
    }
    if (pianoBestComboEl && bestCombo > 0) {
        pianoBestComboEl.textContent = `Mejor: ${bestCombo}`;
    }
    const total = practiceNotes.length;
    const hit = practiceNotes.filter(n => n.hit).length;
    if (total > 0 && totalHits > 0) {
        resultDisplay.textContent = `${hit}/${total}`;
        resultDisplay.style.color = '#a0a0c0';
    }
}

let autoOctaveEnabled = false;

function getOctaveFromNote(note) {
    const m = note.match(/\d+$/);
    return m ? parseInt(m[0]) : -1;
}

function updateOctaveIndicator(elapsed) {
    if (!octaveIndicator) return;
    const upcoming = practiceNotes
        .filter(n => !n.hit && !n.missed && (n.expectedTime - elapsed) / 1000 > -0.5)
        .sort((a, b) => a.expectedTime - b.expectedTime)[0];
    if (!upcoming) {
        octaveIndicator.style.display = 'none';
        return;
    }
    const noteOctave = getOctaveFromNote(upcoming.note);
    if (noteOctave < 0) { octaveIndicator.style.display = 'none'; return; }
    const currentBase = BASE_OCTAVE + practiceOctaveShift;
    const currentMax = currentBase + 1;
    const arrows = octaveIndicator.querySelectorAll('.octave-arrow');
    if (noteOctave < currentBase) {
        octaveIndicator.style.display = 'flex';
        arrows.forEach(a => a.style.display = a.classList.contains('down') ? '' : 'none');
    } else if (noteOctave > currentMax) {
        octaveIndicator.style.display = 'flex';
        arrows.forEach(a => a.style.display = a.classList.contains('up') ? '' : 'none');
    } else {
        octaveIndicator.style.display = 'none';
    }
    if (autoOctaveEnabled) {
        if (noteOctave < currentBase) {
            shiftPracticeOctave(-1);
        } else if (noteOctave > currentMax) {
            shiftPracticeOctave(1);
        }
    }
}

// ---- Update highway text ----
function updateHighwayText(elapsed) {
    if (!highTextEl) return;
    const upcoming = practiceNotes
        .filter(n => !n.hit && !n.missed)
        .find(n => {
            const secs = (n.expectedTime - elapsed) / 1000;
            return secs > -0.3;
        });
    if (upcoming && upcoming.text) {
        highTextEl.textContent = '💡 ' + upcoming.text;
    } else if (highTextEl.textContent) {
        highTextEl.textContent = '';
    }
}

// ---- Combo burst ----
function showComboBurst() {
    if (combo < 5) return;
    const el = document.createElement('div');
    el.className = 'combo-burst';
    el.textContent = combo + 'x';
    el.style.color = combo >= 20 ? '#f59e0b' : combo >= 10 ? '#4ade80' : '#6fcf97';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 700);
}

// ---- Hit detection ----
function handleHit(noteName, elapsed) {
    const candidates = practiceNotes
        .filter(n => !n.hit && !n.missed && n.note === noteName)
        .sort((a, b) => Math.abs(a.expectedTime - elapsed) - Math.abs(b.expectedTime - elapsed));

    const match = candidates[0];
    if (!match) {
        score = Math.max(0, score - 1);
        if (scoreDisplay) scoreDisplay.textContent = score;
        return;
    }

    const diff = elapsed - match.expectedTime;
    const absDiff = Math.abs(diff);

    let noteScore;
    let result;
    if (absDiff <= 60) {
        noteScore = 100;
        result = 'perfect';
    } else if (absDiff <= 180) {
        noteScore = 50;
        result = 'good';
    } else {
        noteScore = 10;
        result = 'late';
    }

    match.hit = true;
    match.result = result;
    score += noteScore;
    totalHits++;
    combo++;
    if (combo > bestCombo) bestCombo = combo;
    if (scoreDisplay) scoreDisplay.textContent = score;

    const el = document.querySelector(`#piano .key[data-note="${noteName}"]`);
    if (el) {
        const cls = result === 'perfect' ? 'hit-perfect' : 'active';
        el.classList.add(cls);
        setTimeout(() => { el.classList.remove(cls); el.classList.remove('active'); }, 200);
        el.classList.remove('pre-glow');
    }

    if (combo >= 5 && combo % 5 === 0) showComboBurst();

    const labels = { perfect: '✅ Perfecto', good: '👍 Bien', late: '⏰ Tarde' };
    const colorMap = { perfect: '#4ade80', good: '#f5d76e', late: '#ff6b6b' };
    resultDisplay.textContent = labels[result] || '';
    resultDisplay.style.color = colorMap[result] || '#fff';
    setTimeout(() => {
        if (!practiceNotes.every(n => n.hit || n.missed)) {
            resultDisplay.textContent = `${totalHits}/${practiceNotes.length}`;
            resultDisplay.style.color = '#a0a0c0';
        }
    }, 600);
}

// ---- Key Press/Release ----
function onPracticeKeyPress(note) {
    const freq = getFrequency(note);
    if (freq) playNote(freq, 0.35);
    const el = document.querySelector(`#piano .key[data-note="${note}"]`);
    if (el) el.classList.add('active');
    if (lessonActive && gameRunning) {
        playedNotes.push(note);
        const elapsed = performance.now() - lessonStartTime;
        handleHit(note, elapsed);
    }
}

function onPracticeKeyRelease(note) {
    const el = document.querySelector(`#piano .key[data-note="${note}"]`);
    if (el) el.classList.remove('active');
}

function startLesson() {
    if (!currentLesson || practiceNotes.length === 0 || gameRunning) return;
    lessonActive = true;
    combo = 0;
    bestCombo = 0;
    totalHits = 0;
    score = 0;
    playedNotes = [];
    if (scoreDisplay) scoreDisplay.textContent = '0';
    if (resultDisplay) resultDisplay.textContent = '';
    if (highTextEl) highTextEl.textContent = '';
    startLessonBtn.style.display = 'none';
    resetLessonBtn.style.display = 'inline-block';
    for (const n of practiceNotes) { n.hit = false; n.missed = false; n.result = null; }
    startGameLoop();
}

// ---- Start / Reset ----
startLessonBtn.addEventListener('click', startLesson);

resetLessonBtn.addEventListener('click', () => {
    stopGameLoop();
    lessonActive = false;
    combo = 0;
    totalHits = 0;
    score = 0;
    if (scoreDisplay) scoreDisplay.textContent = '0';
    if (resultDisplay) resultDisplay.textContent = '';
    if (highTextEl) highTextEl.textContent = '';
    for (const n of practiceNotes) { n.hit = false; n.missed = false; n.result = null; }
    document.querySelectorAll('#piano .key.pre-glow').forEach(el => el.classList.remove('pre-glow'));
    startLessonBtn.style.display = 'inline-block';
    resetLessonBtn.style.display = 'none';
    if (highwayCtx && highwayCanvas) {
        highwayCtx.clearRect(0, 0, highwayCanvas.width, highwayCanvas.height);
    }
});

// ---- Finish ----
async function finishLesson() {
    stopGameLoop();
    lessonActive = false;
    if (highTextEl) highTextEl.textContent = '';
    document.querySelectorAll('#piano .key.pre-glow').forEach(el => el.classList.remove('pre-glow'));

    const total = practiceNotes.length;
    const hit = practiceNotes.filter(n => n.hit).length;
    const perfects = practiceNotes.filter(n => n.result === 'perfect').length;
    const goods = practiceNotes.filter(n => n.result === 'good').length;
    const lates = practiceNotes.filter(n => n.result === 'late').length;
    const misses = practiceNotes.filter(n => n.result === 'miss').length;
    const pct = total > 0 ? Math.round((hit / total) * 100) : 0;
    const passed = pct >= 60;
    const maxPossible = total * 100;
    const avgPct = maxPossible > 0 ? Math.round((score / maxPossible) * 100) : 0;

    resultDisplay.textContent = passed
        ? `✅ ¡Completado! ${hit}/${total} notas (${avgPct}%)`
        : `❌ Intenta de nuevo. ${hit}/${total} notas (${avgPct}%)`;
    resultDisplay.style.color = passed ? '#4ade80' : '#ff6b6b';

    const parts = [];
    if (perfects > 0) parts.push(`Perfectos: ${perfects}`);
    if (goods > 0) parts.push(`Buenos: ${goods}`);
    if (lates > 0) parts.push(`Tarde: ${lates}`);
    if (misses > 0) parts.push(`Falladas: ${misses}`);
    if (parts.length > 0) {
        setTimeout(() => {
            resultDisplay.textContent += ` | ${parts.join(', ')}`;
        }, 1500);
    }

    startLessonBtn.style.display = 'inline-block';
    startLessonBtn.textContent = 'Reintentar';
    resetLessonBtn.style.display = 'none';

    if (token) {
        try {
            await fetch(`${API_URL}/api/progress`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ lesson_id: currentLesson.id, score: avgPct, completed: passed })
            });
        } catch (err) { logClientError(err?.message || 'Error saving progress', 'progress-save'); console.error(err); }

        if (multiplayerSessionId && !multiplayerScoreSubmitted) {
            multiplayerScoreSubmitted = true;
            try {
                const resp = await adminFetch('/api/multiplayer/submit-score', {
                    method: 'POST',
                    body: JSON.stringify({
                        session_id: multiplayerSessionId,
                        score: avgPct,
                        perfects,
                        goods,
                        lates,
                        misses,
                        completed: true,
                    }),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    if (multiplayerPollInterval) {
                        clearInterval(multiplayerPollInterval);
                        multiplayerPollInterval = null;
                    }
                    if (data.session.status === 'finished') {
                        showMultiplayerResults(data);
                        multiplayerModal.style.display = 'flex';
                    } else {
                        startMultiplayerPolling();
                    }
                }
            } catch (err) { logClientError(err?.message || 'Error submitting multiplayer score', 'multiplayer-submit'); console.error(err); }
        }
    }
}

// ---- Canvas resize on window resize ----
window.addEventListener('resize', () => {
    if (pianoSection.style.display !== 'none') {
        resizeHighwayCanvas();
    }
});

// ---- Global Keyboard ----
document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    // Editor keyboard
    if (editorSection.style.display !== 'none' && editorSection.style.display !== '') {
        if (e.key === 'z' || e.key === 'Z') { shiftEditorOctave(-1); return; }
        if (e.key === 'x' || e.key === 'X') { shiftEditorOctave(1); return; }
        const note = getComputedNote(e.key, editorOctaveShift);
        if (note && !e.repeat) {
            e.preventDefault();
            onEditorKeyPress(note);
        }
        return;
    }

    // Practice keyboard
    if (pianoSection.style.display !== 'none' && pianoSection.style.display !== '') {
        if (e.key === 'z' || e.key === 'Z') { shiftPracticeOctave(-1); return; }
        if (e.key === 'x' || e.key === 'X') { shiftPracticeOctave(1); return; }
        const note = getComputedNote(e.key, practiceOctaveShift);
        if (note && !e.repeat) {
            e.preventDefault();
            onPracticeKeyPress(note);
        }
    }
});

document.addEventListener('keyup', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (editorSection.style.display !== 'none' && editorSection.style.display !== '') {
        const note = getComputedNote(e.key, editorOctaveShift);
        if (note) onEditorKeyRelease(note);
        return;
    }

    if (pianoSection.style.display !== 'none' && pianoSection.style.display !== '') {
        const note = getComputedNote(e.key, practiceOctaveShift);
        if (note) onPracticeKeyRelease(note);
    }
});
