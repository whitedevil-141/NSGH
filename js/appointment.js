// NSGH Care client-side appointment portal.
const STORAGE_SESSION = 'medicare_session';
const STORAGE_API_TOKEN = 'medicare_api_token';
const STORAGE_VIEW = 'medicare_last_view';
const API_BASE = window.NSGH_APPOINTMENT_API || 'http://127.0.0.1:8000/appointment';
const SLOT_INTERVAL_MINUTES = 30;
const BOOKING_WINDOW_DAYS = 90;

const ROLES = { USER: 'user', DOCTOR: 'doctor', ADMIN: 'admin', MARKETING: 'marketing', COMMISSION_DOCTOR: 'commission_doctor' };
const VALID_APPOINTMENT_STATUSES = ['Booked', 'Completed', 'Cancelled'];

const PERMISSIONS = {
    user: { dashboard: true, viewDoctors: true, viewAppointments: true, createAppointments: true },
    doctor: { doctorDashboard: true, viewAppointments: true },
    admin: { adminPanel: true, manageUsers: true, manageDoctors: true, manageAppointments: true, manageMarketing: true },
    marketing: { marketingDashboard: true, viewDoctors: true, viewAppointments: true, createAppointments: true, cancelAppointments: true, changeOwnPassword: true },
    commission_doctor: { marketingDashboard: true, viewDoctors: true, viewAppointments: true, createAppointments: true, cancelAppointments: true }
};

let appState = {
    currentUser: null,
    currentView: 'auth',
    authToken: localStorage.getItem(STORAGE_API_TOKEN),
    users: [],
    doctors: [],
    appointments: []
};

let authState = {
    mode: 'login',
    pendingRegistration: null,
    pendingReset: null
};

let pdfState = {
    appointmentId: null,
    objectUrl: null
};

// --- Helpers ---
function getEl(id) { return document.getElementById(id); }

function getRole(user) { return (user && user.role) || ROLES.USER; }

function hasPermission(perm) {
    if (!appState.currentUser) return false;
    return !!PERMISSIONS[getRole(appState.currentUser)]?.[perm];
}

function roleLabel(role) {
    const labels = {
        user: 'Patient',
        doctor: 'Doctor',
        admin: 'Admin',
        marketing: 'Marketing Officer',
        commission_doctor: 'Commission Doctor'
    };
    return labels[role] || String(role || 'User').replace(/_/g, ' ');
}

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function normalizeCategoryList(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (value === null || value === undefined) return [];
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed.filter(Boolean);
        } catch {
            return trimmed.split(',').map(item => item.trim()).filter(Boolean);
        }
        return [trimmed];
    }
    return [String(value)];
}

function normalizeLogin(value) {
    const trimmed = String(value || '').trim();
    if (/^[+\d\s().-]+$/.test(trimmed)) return trimmed.replace(/[^\d+]/g, '');
    return trimmed;
}

function normalizePhone(value) {
    return String(value || '').trim().replace(/[^\d+]/g, '');
}

function isValidPhone(value) {
    return /^\+?\d{7,15}$/.test(value);
}

function isValidEmail(value) {
    return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function setText(id, value) {
    const el = getEl(id);
    if (el) el.textContent = value ?? '';
}

function setLoading(btnId, loading, loadingText = 'Please wait...') {
    const btn = getEl(btnId);
    if (!btn) return;
    if (loading) {
        if (!btn.dataset.originalText) btn.dataset.originalText = btn.innerHTML;
        btn.innerHTML = `<span class="loader" style="width:16px;height:16px;border-width:2px;"></span> ${escapeHTML(loadingText)}`;
        btn.disabled = true;
    } else {
        btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
        btn.dataset.originalText = '';
        btn.disabled = false;
    }
}

async function apiRequest(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    if (appState.authToken) headers.Authorization = `Bearer ${appState.authToken}`;

    let response;
    try {
        response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    } catch (error) {
        error.isNetworkError = true;
        throw error;
    }

    let payload = null;
    const text = await response.text();
    if (text) {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = { detail: text };
        }
    }

    if (!response.ok) {
        const error = new Error(payload?.detail || 'Request failed');
        error.status = response.status;
        error.payload = payload;
        throw error;
    }
    return payload;
}

async function refreshDataFromApi() {
    const data = await apiRequest('/data');
    appState.users = data.users || [];
    appState.doctors = data.doctors || [];
    appState.appointments = data.appointments || [];
    normalizeData();
    return data;
}

function showToast(message, type = 'success') {
    const container = getEl('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success'
        ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
        : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;

    toast.innerHTML = `${icon} <span></span>`;
    toast.querySelector('span').textContent = message;
    container.appendChild(toast);

    window.setTimeout(() => toast.classList.add('show'), 10);
    window.setTimeout(() => {
        toast.classList.remove('show');
        window.setTimeout(() => toast.remove(), 300);
    }, 3200);
}

function toDateISO(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().split('T')[0];
}

function todayISO() {
    return toDateISO(new Date());
}

function addDaysISO(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return toDateISO(date);
}

function parseLocalDate(dateStr) {
    if (!dateStr) return null;
    const [year, month, day] = dateStr.split('-').map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day);
}

function formatDate(dateStr) {
    const date = parseLocalDate(dateStr);
    if (!date) return '-';
    return date.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function timeToMinutes(value) {
    if (value === undefined || value === null || value === '') return null;
    const raw = String(value).trim();
    let match = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) return hours * 60 + minutes;
        return null;
    }

    match = raw.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
    if (!match) return null;
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const suffix = match[3].toUpperCase();
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;
    if (suffix === 'PM' && hours !== 12) hours += 12;
    if (suffix === 'AM' && hours === 12) hours = 0;
    return hours * 60 + minutes;
}

function minutesToTimeValue(totalMinutes) {
    if (totalMinutes === null || Number.isNaN(totalMinutes)) return '';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function formatTime(value) {
    const minutes = timeToMinutes(value);
    if (minutes === null) return String(value || '-');
    const date = new Date(1970, 0, 1, Math.floor(minutes / 60), minutes % 60);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function parseScheduleFromLabel(label) {
    if (!label) return null;
    const [start, end] = String(label).split(/\s+-\s+/);
    const startMin = timeToMinutes(start);
    const endMin = timeToMinutes(end);
    if (startMin === null || endMin === null || endMin <= startMin) return null;
    return { startTime: minutesToTimeValue(startMin), endTime: minutesToTimeValue(endMin) };
}

function getDoctorSchedule(doc) {
    const explicitStart = timeToMinutes(doc?.startTime);
    const explicitEnd = timeToMinutes(doc?.endTime);
    if (explicitStart !== null && explicitEnd !== null && explicitEnd > explicitStart) {
        return { startTime: minutesToTimeValue(explicitStart), endTime: minutesToTimeValue(explicitEnd) };
    }

    const parsed = parseScheduleFromLabel(doc?.time);
    return parsed || { startTime: '09:00', endTime: '17:00' };
}

function buildScheduleLabel(startTime, endTime) {
    return `${formatTime(startTime)} - ${formatTime(endTime)}`;
}

function statusBadgeClass(status) {
    if (status === 'Booked') return 'badge-success';
    if (status === 'Cancelled') return 'badge-danger';
    if (status === 'Completed') return 'badge-info';
    return 'badge-warning';
}

function appointmentTimestamp(app) {
    const date = parseLocalDate(app.date);
    const minutes = timeToMinutes(app.time) || 0;
    return date ? date.getTime() + minutes * 60000 : 0;
}

function isPastAppointment(app) {
    const date = parseLocalDate(app.date);
    if (!date) return false;
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    return endOfDay.getTime() < Date.now();
}

function sortAppointments(items) {
    const statusWeight = { Booked: 0, Completed: 1, Cancelled: 2 };
    return [...items].sort((a, b) => {
        const statusDiff = (statusWeight[a.status] ?? 9) - (statusWeight[b.status] ?? 9);
        if (statusDiff) return statusDiff;
        return appointmentTimestamp(a) - appointmentTimestamp(b);
    });
}

function findAppointment(appId) {
    return appState.appointments.find(app => app.id === Number(appId));
}

function formatAppointmentId(appId) {
    return `#${String(Number(appId) || 0).padStart(6, '0')}`;
}

function appointmentPdfFileName(app) {
    const patient = String(app.patientName || 'patient').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    return `appointment-${formatAppointmentId(app.id).slice(1)}-${patient || 'patient'}.pdf`;
}

async function downloadAppointmentPdf(appId) {
    const app = findAppointment(appId);
    if (!app) {
        showToast('Appointment not found', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/appointments/${appId}/pdf`, {
            headers: { 'Authorization': `Bearer ${appState.authToken}` }
        });
        if (!response.ok) throw new Error('Failed to fetch PDF');
        
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = appointmentPdfFileName(app);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
        showToast('Could not download PDF from server', 'error');
    }
}

async function openAppointmentPdf(appId) {
    const app = findAppointment(appId);
    if (!app) {
        showToast('Appointment not found', 'error');
        return;
    }

    getEl('appointment-pdf-modal')?.classList.add('active');
    setText('pdf-appointment-title', `Loading PDF...`);
    const frame = getEl('appointment-pdf-frame');
    if (frame) frame.removeAttribute('src');

    if (pdfState.objectUrl) URL.revokeObjectURL(pdfState.objectUrl);
    pdfState.appointmentId = Number(appId);
    
    try {
        const response = await fetch(`${API_BASE}/appointments/${appId}/pdf`, {
            headers: { 'Authorization': `Bearer ${appState.authToken}` }
        });
        if (!response.ok) throw new Error('Failed to fetch PDF');
        
        const blob = await response.blob();
        pdfState.objectUrl = URL.createObjectURL(blob);
        
        if (frame) frame.src = pdfState.objectUrl;
        setText('pdf-appointment-title', `Appointment ${formatAppointmentId(app.id)} - ${app.patientName}`);
    } catch (error) {
        showToast('Could not load PDF from server', 'error');
        closeAppointmentPdfModal();
    }
}

function downloadCurrentAppointmentPdf() {
    if (pdfState.appointmentId) downloadAppointmentPdf(pdfState.appointmentId);
}

function closeAppointmentPdfModal() {
    closeModal('appointment-pdf-modal');
    const frame = getEl('appointment-pdf-frame');
    if (frame) frame.removeAttribute('src');
    if (pdfState.objectUrl) URL.revokeObjectURL(pdfState.objectUrl);
    pdfState = { appointmentId: null, objectUrl: null };
}

function appointmentPdfActions(appId) {
    const safeId = Number(appId);
    return `
        <button class="btn btn-soft btn-compact" onclick="openAppointmentPdf(${safeId})">View PDF</button>
        <button class="btn btn-outline btn-compact" onclick="downloadAppointmentPdf(${safeId})">Download</button>
    `;
}

function normalizeData() {
    appState.users = (appState.users || []).map(user => ({
        ...user,
        role: user.role || ROLES.USER
    }));

    appState.doctors = (appState.doctors || []).map(doc => {
        const schedule = getDoctorSchedule(doc);
        const categories = normalizeCategoryList(doc.category ?? doc.specialty);
        const categoryLabel = categories.length ? categories.join(', ') : 'General Physician';
        const isAvailable = doc.is_available ?? doc.isAvailable ?? 1;
        return {
            ...doc,
            id: Number(doc.id),
            name: doc.name || 'Doctor',
            phone: doc.phone || '',
            category: categories,
            categoryLabel,
            startTime: schedule.startTime,
            endTime: schedule.endTime,
            time: buildScheduleLabel(schedule.startTime, schedule.endTime),
            room: doc.room || '-',
            is_available: isAvailable ? 1 : 0
        };
    });

    appState.appointments = (appState.appointments || []).map(app => {
        const minutes = timeToMinutes(app.time);
        return {
            ...app,
            id: Number(app.id),
            docId: Number(app.docId),
            time: minutes === null ? app.time : minutesToTimeValue(minutes),
            status: VALID_APPOINTMENT_STATUSES.includes(app.status) ? app.status : 'Booked',
            reason: app.reason || '',
            bookedById: app.bookedById || null,
            bookedByName: app.bookedByName || null,
            bookedByRole: app.bookedByRole || null,
            marketingOfficerId: app.marketingOfficerId || null,
            marketingOfficerName: app.marketingOfficerName || null,
            commissionDoctorId: app.commissionDoctorId || null,
            commissionDoctorName: app.commissionDoctorName || null
        };
    });

    populateFilterDropdowns();
}

function persistSession() {
    if (appState.currentUser) {
        localStorage.setItem(STORAGE_SESSION, JSON.stringify({ userId: appState.currentUser.id, token: appState.authToken || null }));
        if (appState.authToken) localStorage.setItem(STORAGE_API_TOKEN, appState.authToken);
    } else {
        localStorage.removeItem(STORAGE_SESSION);
        localStorage.removeItem(STORAGE_API_TOKEN);
    }
}

async function loadData() {
    const session = localStorage.getItem(STORAGE_SESSION);
    if (session) {
        try {
            const { userId, token } = JSON.parse(session);
            if (token) {
                appState.authToken = token;
                await refreshDataFromApi();
                const user = appState.users.find(u => u.id === userId) || appState.users[0];
                if (user) {
                    appState.currentUser = user;
                    const storedView = localStorage.getItem(STORAGE_VIEW);
                    const targetView = storedView && canAccess(storedView)
                        ? storedView
                        : defaultViewFor(user);
                    navigateSafe(targetView);
                    return;
                }
            }
        } catch (e) {
            console.warn('API session restore failed:', e);
            appState.authToken = null;
            localStorage.removeItem(STORAGE_API_TOKEN);
        }
    }
    navigateSafe('auth');
}

// --- Navigation ---
function canAccess(view) {
    const role = getRole(appState.currentUser);
    switch (view) {
        case 'auth': return true;
        case 'dashboard': return role === ROLES.USER;
        case 'doctor-dashboard': return role === ROLES.DOCTOR;
        case 'marketing-dashboard': return role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR;
        case 'admin': return role === ROLES.ADMIN;
        case 'doctors': return role === ROLES.USER || role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR;
        case 'appointments': return role === ROLES.USER || role === ROLES.DOCTOR || role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR;
        default: return false;
    }
}

function defaultViewFor(user) {
    const role = getRole(user);
    if (role === ROLES.ADMIN) return 'admin';
    if (role === ROLES.DOCTOR) return 'doctor-dashboard';
    if (role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR) return 'marketing-dashboard';
    return 'dashboard';
}

function navigate(view) {
    if (view !== 'auth' && !appState.currentUser) {
        navigateSafe('auth');
        return;
    }
    if (!canAccess(view)) {
        showToast('Access denied.', 'error');
        navigateSafe(defaultViewFor(appState.currentUser));
        return;
    }
    navigateSafe(view);
}

function navigateSafe(view) {
    appState.currentView = view;
    if (view === 'auth') localStorage.removeItem(STORAGE_VIEW);
    else localStorage.setItem(STORAGE_VIEW, view);
    ['auth-view', 'dashboard-view', 'doctor-dashboard-view', 'marketing-dashboard-view', 'doctors-view', 'appointments-view', 'admin-view']
        .forEach(v => getEl(v)?.classList.add('hidden'));
    getEl(`${view}-view`)?.classList.remove('hidden');

    const navbar = getEl('main-nav');
    if (view === 'auth') {
        navbar?.classList.add('hidden');
    } else {
        navbar?.classList.remove('hidden');
        updateNavbar();
    }

    if (view === 'dashboard') initDashboard();
    if (view === 'doctor-dashboard') initDoctorDashboard();
    if (view === 'marketing-dashboard') initMarketingDashboard();
    if (view === 'doctors') renderDoctors();
    if (view === 'appointments') renderAppointments();
    if (view === 'admin') renderAdmin();

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goHome() {
    if (appState.currentUser) navigate(defaultViewFor(appState.currentUser));
}

function updateNavbar() {
    if (!appState.currentUser) return;
    const role = getRole(appState.currentUser);
    setText('nav-user-name', `${appState.currentUser.name} (${roleLabel(role)})`);
    const adminBtn = getEl('admin-nav-btn');
    if (adminBtn) adminBtn.style.display = role === ROLES.ADMIN ? '' : 'none';
}

function redirectByRole(user, withToast = true) {
    if (withToast) showToast(`Welcome, ${user.name}!`);
    navigate(defaultViewFor(user));
}

// --- Auth tabs ---
function switchAuthTab(tab) {
    authState.mode = tab;
    ['login', 'register', 'forgot'].forEach(t => {
        getEl(`${t}-content`)?.classList.add('hidden');
        getEl(`tab-${t}`)?.classList.remove('active');
    });
    getEl(`${tab}-content`)?.classList.remove('hidden');
    if (tab === 'forgot') getEl('tab-login')?.classList.add('active');
    else getEl(`tab-${tab}`)?.classList.add('active');

    if (tab === 'register') {
        showRegStep(1);
        authState.pendingRegistration = null;
    }
    if (tab === 'forgot') {
        showForgotStep(1);
        authState.pendingReset = null;
    }
}

function showRegStep(n) {
    for (let i = 1; i <= 3; i++) getEl(`register-step-${i}`)?.classList.add('hidden');
    getEl(`register-step-${n}`)?.classList.remove('hidden');
}

function showForgotStep(n) {
    for (let i = 1; i <= 3; i++) getEl(`forgot-step-${i}`)?.classList.add('hidden');
    getEl(`forgot-step-${n}`)?.classList.remove('hidden');
}

// --- Login ---
async function loginWithPassword() {
    const phone = normalizeLogin(getEl('login-phone').value);
    const password = getEl('login-password').value;
    if (!phone || !password) {
        showToast('Enter phone and password', 'error');
        return;
    }

    setLoading('btn-login', true, 'Signing in...');
    try {
        const result = await apiRequest('/login', {
            method: 'POST',
            body: JSON.stringify({ phone, password })
        });
        appState.authToken = result.access_token;
        appState.currentUser = result.user;
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === result.user.id) || result.user;
        persistSession();
        getEl('login-password').value = '';
        redirectByRole(appState.currentUser);
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Invalid phone or password'), 'error');
        appState.authToken = null;
    } finally {
        setLoading('btn-login', false);
    }
}

// --- Registration ---
async function startRegistration() {
    const phone = normalizePhone(getEl('reg-phone').value);
    const password = getEl('reg-password').value;
    const confirm = getEl('reg-confirm-password').value;

    if (!isValidPhone(phone)) {
        showToast('Enter a valid phone number', 'error');
        return;
    }
    if (password.length < 6) {
        showToast('Password must be at least 6 characters', 'error');
        return;
    }
    if (password !== confirm) {
        showToast('Passwords do not match', 'error');
        return;
    }

    setLoading('btn-start-reg', true, 'Sending OTP...');
    try {
        await apiRequest('/otp/send', {
            method: 'POST',
            body: JSON.stringify({ phone })
        });
        authState.pendingRegistration = { phone, password, otpVerified: false };
        setText('reg-display-phone', phone);
        getEl('reg-otp').value = '';
        showRegStep(2);
        showToast(`OTP sent to ${phone}`);
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not send OTP'), 'error');
    } finally {
        setLoading('btn-start-reg', false);
    }
}

async function verifyRegistrationOTP() {
    if (!authState.pendingRegistration) {
        showRegStep(1);
        return;
    }
    const otp = getEl('reg-otp').value.trim();
    if (!/^\d{6}$/.test(otp)) {
        showToast('Enter the 6-digit OTP', 'error');
        return;
    }

    setLoading('btn-verify-reg-otp', true, 'Verifying...');
    try {
        await apiRequest('/otp/verify', {
            method: 'POST',
            body: JSON.stringify({ phone: authState.pendingRegistration.phone, otp })
        });
        authState.pendingRegistration.otpVerified = true;
        showRegStep(3);
        showToast('Phone verified. Complete your profile.');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not verify OTP'), 'error');
    } finally {
        setLoading('btn-verify-reg-otp', false);
    }
}

async function completeRegistration() {
    const pending = authState.pendingRegistration;
    if (!pending || !pending.otpVerified) {
        showToast('Verify your phone first', 'error');
        showRegStep(1);
        return;
    }

    const name = getEl('reg-name').value.trim();
    const age = parseInt(getEl('reg-age').value, 10);
    const gender = getEl('reg-gender').value;
    const bloodGroup = getEl('reg-blood-group').value;
    const email = getEl('reg-email').value.trim();

    if (name.length < 2 || !age || age < 1 || age > 120 || !gender || !bloodGroup) {
        showToast('Please complete the required profile fields', 'error');
        return;
    }
    if (!isValidEmail(email)) {
        showToast('Enter a valid email address', 'error');
        return;
    }

    setLoading('btn-complete-reg', true, 'Creating account...');
    try {
        const newUser = await apiRequest('/users', {
            method: 'POST',
            body: JSON.stringify({
                name,
                phone: pending.phone,
                password: pending.password,
                age,
                gender,
                bloodGroup,
                email: email || null,
                role: ROLES.USER
            })
        });
        const loginResult = await apiRequest('/login', {
            method: 'POST',
            body: JSON.stringify({ phone: pending.phone, password: pending.password })
        });
        appState.authToken = loginResult.access_token;
        appState.currentUser = loginResult.user || newUser;
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();

        getEl('registration-form').reset();
        ['reg-phone', 'reg-password', 'reg-confirm-password', 'reg-otp'].forEach(id => {
            const el = getEl(id);
            if (el) el.value = '';
        });
        authState.pendingRegistration = null;
        setLoading('btn-complete-reg', false);
        redirectByRole(appState.currentUser);
        return;
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not create account'), 'error');
    } finally {
        setLoading('btn-complete-reg', false);
    }
}

// --- Forgot password ---
async function sendForgotOTP() {
    const phone = normalizeLogin(getEl('forgot-phone').value);
    if (!phone) {
        showToast('Enter your phone number', 'error');
        return;
    }

    setLoading('btn-forgot-otp', true, 'Sending OTP...');
    try {
        await apiRequest('/otp/send', {
            method: 'POST',
            body: JSON.stringify({ phone })
        });
        authState.pendingReset = { phone, otpVerified: false };
        setText('forgot-display-phone', phone);
        getEl('forgot-otp').value = '';
        showForgotStep(2);
        showToast('OTP sent');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not send OTP'), 'error');
    } finally {
        setLoading('btn-forgot-otp', false);
    }
}

async function verifyForgotOTP() {
    if (!authState.pendingReset) {
        showForgotStep(1);
        return;
    }
    const otp = getEl('forgot-otp').value.trim();
    if (!/^\d{6}$/.test(otp)) {
        showToast('Enter the 6-digit OTP', 'error');
        return;
    }

    setLoading('btn-verify-forgot-otp', true, 'Verifying...');
    try {
        await apiRequest('/otp/verify', {
            method: 'POST',
            body: JSON.stringify({ phone: authState.pendingReset.phone, otp })
        });
        authState.pendingReset.otpVerified = true;
        showForgotStep(3);
        showToast('OTP verified. Set a new password.');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not verify OTP'), 'error');
    } finally {
        setLoading('btn-verify-forgot-otp', false);
    }
}

async function resetPassword() {
    const pending = authState.pendingReset;
    if (!pending || !pending.otpVerified) {
        showToast('Verify OTP first', 'error');
        showForgotStep(1);
        return;
    }

    const newPass = getEl('forgot-new-password').value;
    const confirm = getEl('forgot-confirm-password').value;
    if (newPass.length < 6) {
        showToast('Password must be at least 6 characters', 'error');
        return;
    }
    if (newPass !== confirm) {
        showToast('Passwords do not match', 'error');
        return;
    }

    setLoading('btn-reset-password', true, 'Saving...');
    try {
        await apiRequest('/password/reset', {
            method: 'POST',
            body: JSON.stringify({ phone: pending.phone, newPassword: newPass })
        });
        authState.pendingReset = null;
        ['forgot-phone', 'forgot-otp', 'forgot-new-password', 'forgot-confirm-password'].forEach(id => {
            const el = getEl(id);
            if (el) el.value = '';
        });
        setLoading('btn-reset-password', false);
        showToast('Password reset. Please login.');
        switchAuthTab('login');
        return;
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not reset password'), 'error');
    } finally {
        setLoading('btn-reset-password', false);
    }
}

// --- Logout ---
function logout() {
    appState.currentUser = null;
    appState.authToken = null;
    persistSession();
    localStorage.removeItem(STORAGE_VIEW);
    authState = { mode: 'login', pendingRegistration: null, pendingReset: null };
    ['login-phone', 'login-password'].forEach(id => {
        const el = getEl(id);
        if (el) el.value = '';
    });
    switchAuthTab('login');
    navigateSafe('auth');
    showToast('Logged out successfully');
}

// --- Dashboards ---
function initDashboard() {
    const u = appState.currentUser;
    setText('dash-user-name', u.name);
    setText('dash-user-phone', u.phone);
    setText('dash-user-gender', u.gender || '-');
    setText('dash-user-age', u.age || '-');
    setText('dash-user-blood', u.bloodGroup || '-');
}

function initDoctorDashboard() {
    const u = appState.currentUser;
    const doctorRecord = appState.doctors.find(d => d.phone === u.phone);

    setText('doc-dash-name', u.name);
    setText('doc-dash-specialty', u.specialty || doctorRecord?.categoryLabel || 'N/A');
    setText('doc-dash-phone', u.phone);
}

function initMarketingDashboard() {
    const u = appState.currentUser;
    const role = getRole(u);
    setText('marketing-dash-name', u.name);
    setText('marketing-dash-role', roleLabel(role));
    setText('marketing-dash-phone', u.phone);
    setText('marketing-dash-under', role === ROLES.COMMISSION_DOCTOR ? (u.createdByName || 'Not assigned') : '-');

    getEl('marketing-password-card')?.classList.toggle('hidden', role !== ROLES.MARKETING);
}

// --- Doctor listing ---
function getBookedSlots(docId, date) {
    return new Set(appState.appointments
        .filter(app => app.docId === Number(docId) && app.date === date && app.status === 'Booked')
        .map(app => minutesToTimeValue(timeToMinutes(app.time))));
}

function getAvailableSlots(docId, date) {
    const doc = appState.doctors.find(d => d.id === Number(docId));
    if (!doc || !doc.is_available || !date || date < todayISO() || date > addDaysISO(BOOKING_WINDOW_DAYS)) return [];

    const schedule = getDoctorSchedule(doc);
    const start = timeToMinutes(schedule.startTime);
    const end = timeToMinutes(schedule.endTime);
    const booked = getBookedSlots(docId, date);
    const slots = [];

    for (let minute = start; minute < end; minute += SLOT_INTERVAL_MINUTES) {
        const value = minutesToTimeValue(minute);
        if (!booked.has(value)) slots.push({ value, label: formatTime(value) });
    }
    return slots;
}

async function fetchAvailableSlots(docId, date) {
    return getAvailableSlots(docId, date);
}

function getNextAvailability(docId) {
    const doc = appState.doctors.find(d => d.id === Number(docId));
    if (!doc || !doc.is_available) return 'Doctor not available';
    return 'Book appointment to join queue';
}

function renderDoctors() {
    const backBtn = getEl('doctors-back-btn');
    if (backBtn) backBtn.setAttribute('onclick', `navigate('${defaultViewFor(appState.currentUser)}')`);
    const query = getEl('search-doctor').value.trim().toLowerCase();
    const category = getEl('filter-category').value;
    const filtered = appState.doctors.filter(d => {
        const categoryText = Array.isArray(d.category) ? d.category.join(' ') : String(d.category || '');
        const haystack = `${d.name} ${categoryText} ${d.room}`.toLowerCase();
        const matchName = haystack.includes(query);
        const matchAvailable = d.is_available;
        const matchCat = category === 'all'
            || (Array.isArray(d.category) ? d.category.includes(category) : d.category === category);
        return matchName && matchAvailable && matchCat;
    });

    const listEl = getEl('doctor-list');
    listEl.innerHTML = '';

    if (filtered.length === 0) {
        getEl('doctor-empty').classList.remove('hidden');
        listEl.classList.add('hidden');
        return;
    }
    getEl('doctor-empty').classList.add('hidden');
    listEl.classList.remove('hidden');

    listEl.innerHTML = filtered.map(doc => {
        const initial = escapeHTML(doc.name.replace(/^Dr\.?\s*/i, '').charAt(0).toUpperCase() || 'D');
        return `
            <div class="card doctor-card">
                <div>
                    <div class="doc-header">
                        <div class="doc-avatar">${initial}</div>
                        <div class="doc-title">
                            <h3>${escapeHTML(doc.name)}</h3>
                            <p>${escapeHTML(doc.categoryLabel)}</p>
                        </div>
                    </div>
                    <div class="doc-info mt-2">
                        <p><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ${escapeHTML(doc.time)}</p>
                        <p><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> Room ${escapeHTML(doc.room)}</p>
                        <p class="availability-pill">Next: ${escapeHTML(getNextAvailability(doc.id))}</p>
                    </div>
                </div>
                <button class="btn btn-primary mt-4" style="width:100%" onclick="openBookingModal(${Number(doc.id)})">Book Appointment</button>
            </div>
        `;
    }).join('');
}

function filterDoctors() { renderDoctors(); }

// --- Appointments view ---
function appointmentSourceMeta(app) {
    const lines = [];
    if (app.commissionDoctorName) lines.push(`Commission Doctor: ${app.commissionDoctorName}`);
    if (app.marketingOfficerName) lines.push(`Marketing Officer: ${app.marketingOfficerName}`);
    if (!app.commissionDoctorName && !app.marketingOfficerName && app.bookedByName && app.bookedByRole !== ROLES.USER) {
        lines.push(`Booked by: ${app.bookedByName} (${roleLabel(app.bookedByRole)})`);
    }
    return lines.map(line => `<div class="row-subtle">${escapeHTML(line)}</div>`).join('');
}

function canCancelSerial(app) {
    const role = getRole(appState.currentUser);
    if (app.status !== 'Booked' || isPastAppointment(app)) return false;
    if (role === ROLES.MARKETING) return app.marketingOfficerId === appState.currentUser.id || app.bookedById === appState.currentUser.id;
    if (role === ROLES.COMMISSION_DOCTOR) return app.commissionDoctorId === appState.currentUser.id || app.bookedById === appState.currentUser.id;
    return false;
}

function getFilteredMyAppointments() {
    const role = getRole(appState.currentUser);
    let myApps = [];
    if (role === ROLES.USER) {
        myApps = appState.appointments.filter(a => a.patientPhone === appState.currentUser.phone);
    } else if (role === ROLES.DOCTOR) {
        const doctorRecord = appState.doctors.find(d => d.phone === appState.currentUser.phone);
        if (doctorRecord) myApps = appState.appointments.filter(a => a.docId === doctorRecord.id);
    } else if (role === ROLES.MARKETING) {
        myApps = appState.appointments.filter(a => a.marketingOfficerId === appState.currentUser.id || a.bookedById === appState.currentUser.id);
    } else if (role === ROLES.COMMISSION_DOCTOR) {
        myApps = appState.appointments.filter(a => a.commissionDoctorId === appState.currentUser.id || a.bookedById === appState.currentUser.id);
    }

    const date = getEl('filter-my-app-date')?.value;
    const status = getEl('filter-my-app-status')?.value;
    const docId = getEl('filter-my-app-doctor')?.value;

    return myApps.filter(a => {
        if (date && a.date !== date) return false;
        if (status && a.status !== status) return false;
        if (docId && String(a.docId) !== docId) return false;
        return true;
    });
}

function renderAppointments() {
    const role = getRole(appState.currentUser);
    const listEl = getEl('appointments-list');
    const tableContainer = getEl('appointments-table').parentElement;
    listEl.innerHTML = '';

    if (role === ROLES.DOCTOR) {
        setText('appointments-heading', 'Patient Appointments');
        setText('appointments-th-1', 'Patient');
        getEl('appointments-back-btn').setAttribute('onclick', "navigate('doctor-dashboard')");
        setText('appointments-empty-text', 'No patients have booked an appointment yet.');
        getEl('appointments-book-btn').classList.add('hidden');
        getEl('filter-my-app-doctor-group')?.classList.add('hidden');
    } else if (role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR) {
        setText('appointments-heading', 'Serial List');
        setText('appointments-th-1', 'Patient / Source');
        getEl('appointments-back-btn').setAttribute('onclick', "navigate('marketing-dashboard')");
        setText('appointments-empty-text', 'No serials have been created yet.');
        getEl('appointments-book-btn').classList.remove('hidden');
        getEl('filter-my-app-doctor-group')?.classList.remove('hidden');
    } else {
        setText('appointments-heading', 'My Appointments');
        setText('appointments-th-1', 'Doctor');
        getEl('appointments-back-btn').setAttribute('onclick', "navigate('dashboard')");
        setText('appointments-empty-text', "You haven't booked any appointments.");
        getEl('appointments-book-btn').classList.remove('hidden');
        getEl('filter-my-app-doctor-group')?.classList.remove('hidden');
    }

    const myApps = getFilteredMyAppointments();

    if (myApps.length === 0) {
        tableContainer.classList.add('hidden');
        getEl('appointments-empty').classList.remove('hidden');
        return;
    }
    tableContainer.classList.remove('hidden');
    getEl('appointments-empty').classList.add('hidden');

    listEl.innerHTML = sortAppointments(myApps).map(app => {
        const canCancel = canCancelSerial(app);
        const firstCol = role === ROLES.DOCTOR
            ? `<strong>${escapeHTML(app.patientName)}</strong><div class="row-subtle">${escapeHTML(app.patientPhone)}</div>${appointmentSourceMeta(app)}${app.reason ? `<div class="row-note">${escapeHTML(app.reason)}</div>` : ''}`
            : (role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR)
                ? `<strong>${escapeHTML(app.patientName)}</strong><div class="row-subtle">${escapeHTML(app.patientPhone)}</div><div class="row-subtle">Doctor: ${escapeHTML(app.docName)}</div>${appointmentSourceMeta(app)}${app.reason ? `<div class="row-note">${escapeHTML(app.reason)}</div>` : ''}`
                : `<strong>${escapeHTML(app.docName)}</strong>${appointmentSourceMeta(app)}${app.reason ? `<div class="row-note">${escapeHTML(app.reason)}</div>` : ''}`;

        return `
            <tr>
                <td data-label="${role === ROLES.DOCTOR || role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR ? 'Patient' : 'Doctor'}">${firstCol}</td>
                <td data-label="Date">${formatDate(app.date)}</td>
                <td data-label="Serial">${app.serial_number ? `#${app.serial_number}` : '-'}</td>
                <td data-label="Room">${escapeHTML(app.room)}</td>
                <td data-label="Status"><span class="badge ${statusBadgeClass(app.status)}">${escapeHTML(app.status)}</span></td>
                <td data-label="Action">
                    <div class="table-actions">
                        ${appointmentPdfActions(app.id)}
                        ${canCancel
                            ? `<button class="btn btn-outline btn-compact btn-danger-ghost" onclick="cancelAppointment(${Number(app.id)})">Cancel</button>`
                            : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// --- Booking ---
function openBookingModal(docId) {
    if (!hasPermission('createAppointments')) {
        showToast('No permission to create serials', 'error');
        return;
    }
    const doc = appState.doctors.find(d => d.id === Number(docId));
    if (!doc) return;
    
    if (!doc.is_available) {
        showToast('This doctor is currently unavailable', 'error');
        return;
    }

    const initial = doc.name.replace(/^Dr\.?\s*/i, '').charAt(0).toUpperCase() || 'D';
    getEl('booking-doc-id').value = doc.id;
    setText('modal-doc-name', doc.name);
    setText('modal-doc-cat', doc.categoryLabel);
    setText('modal-doc-time', doc.time);
    setText('modal-doc-room', doc.room);
    setText('modal-doc-initial', initial);
    const needsPatientFields = getRole(appState.currentUser) !== ROLES.USER;
    getEl('booking-patient-fields')?.classList.toggle('hidden', !needsPatientFields);
    getEl('booking-patient-name').value = '';
    getEl('booking-patient-phone').value = '';
    setText('booking-reason-label', needsPatientFields ? 'Note' : 'Reason for Visit');
    getEl('booking-reason').placeholder = needsPatientFields ? 'Write a note for this serial' : 'Briefly describe symptoms or appointment purpose';

    const bookingDate = getEl('booking-date');
    bookingDate.min = todayISO();
    bookingDate.max = addDaysISO(BOOKING_WINDOW_DAYS);
    bookingDate.value = todayISO();
    getEl('booking-reason').value = '';
    
    // Hide time selection (queue-based system doesn't need it)
    const timeGroup = getEl('booking-time-group');
    if (timeGroup) timeGroup.classList.add('hidden');
    
    getEl('btn-confirm-booking').disabled = false;
    getEl('booking-modal').classList.add('active');
}

async function renderBookingTimeSlots() {
    const docId = parseInt(getEl('booking-doc-id')?.value || '', 10);
    const date = getEl('booking-date')?.value;
    const select = getEl('booking-time');
    const helper = getEl('booking-slot-helper');
    const confirmBtn = getEl('btn-confirm-booking');
    if (!select || !helper || !confirmBtn) return;

    select.innerHTML = '';
    if (!docId || !date) {
        select.innerHTML = '<option value="">Select a date first</option>';
        helper.textContent = 'Available slots are shown after you choose a date.';
        confirmBtn.disabled = true;
        return;
    }

    select.innerHTML = '<option value="">Loading slots...</option>';
    helper.textContent = 'Checking available slots...';
    confirmBtn.disabled = true;

    let slots = [];
    try {
        slots = await fetchAvailableSlots(docId, date);
    } catch (error) {
        select.innerHTML = '<option value="">Could not load slots</option>';
        helper.textContent = error.isNetworkError ? 'Could not connect to the appointment API.' : (error.message || 'Could not load available slots.');
        showToast(helper.textContent, 'error');
        return;
    }

    if (!slots.length) {
        select.innerHTML = '<option value="">No open slots</option>';
        helper.textContent = 'This date is fully booked or outside the booking window.';
        confirmBtn.disabled = true;
        return;
    }

    select.innerHTML = '<option value="">Choose a time slot...</option>' + slots
        .map(slot => `<option value="${escapeHTML(slot.value)}">${escapeHTML(slot.label)}</option>`)
        .join('');
    helper.textContent = `${slots.length} open slot${slots.length === 1 ? '' : 's'} on ${formatDate(date)}.`;
    confirmBtn.disabled = false;
}

function closeModal(modalId) {
    getEl(modalId)?.classList.remove('active');
}

async function confirmBooking() {
    if (!hasPermission('createAppointments')) {
        showToast('No permission to book', 'error');
        return;
    }

    const docId = parseInt(getEl('booking-doc-id').value, 10);
    const date = getEl('booking-date').value;
    const reason = getEl('booking-reason').value.trim().slice(0, 180);
    const patientName = getEl('booking-patient-name')?.value.trim() || '';
    const patientPhone = normalizePhone(getEl('booking-patient-phone')?.value || '');
    const doc = appState.doctors.find(d => d.id === docId);
    const isPatientBooking = getRole(appState.currentUser) === ROLES.USER;

    if (!doc || !date) {
        showToast('Please select a date', 'error');
        return;
    }
    if (date < todayISO() || date > addDaysISO(BOOKING_WINDOW_DAYS)) {
        showToast('Choose a valid appointment date', 'error');
        return;
    }
    if (!isPatientBooking && patientName.length < 2) {
        showToast('Patient name is required', 'error');
        return;
    }
    if (!isPatientBooking && !isValidPhone(patientPhone)) {
        showToast('Enter a valid patient phone number', 'error');
        return;
    }

    // Check if patient already has an appointment with this doctor on this date (queue system - one per date per doctor)
    const hasPatientConflict = appState.appointments.some(app =>
        app.docId === docId &&
        app.patientPhone === (isPatientBooking ? appState.currentUser.phone : patientPhone) &&
        app.date === date &&
        app.status === 'Booked'
    );
    if (hasPatientConflict) {
        showToast('You already have an appointment with this doctor on this date', 'error');
        return;
    }

    setLoading('btn-confirm-booking', true, 'Booking...');
    try {
        const payload = { docId, date, reason };
        if (!isPatientBooking) {
            payload.patientName = patientName;
            payload.patientPhone = patientPhone;
        }
        const response = await apiRequest('/appointments', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        
        // Handle the queue response with serial number
        const appointment = response.details || response;
        const serialNumber = response.serial_number || appointment.serial_number;
        
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        if (!appState.appointments.some(app => app.id === appointment.id)) {
            appState.appointments.push(appointment);
        }
        persistSession();
        closeModal('booking-modal');
        
        // Show success with queue position
        const message = response.message || 'Appointment booked successfully.';
        const queueMsg = response.queue_position ? `\n${response.queue_position}` : '';
        showToast(`${message}${queueMsg}`);
        navigate('appointments');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not book appointment'), 'error');
    } finally {
        setLoading('btn-confirm-booking', false);
    }
}

async function cancelAppointment(appId) {
    if (!hasPermission('cancelAppointments')) {
        showToast('No permission to cancel', 'error');
        return;
    }
    const app = appState.appointments.find(a => a.id === Number(appId));
    if (!app || !canCancelSerial(app)) {
        showToast('Cannot cancel this appointment', 'error');
        return;
    }
    if (isPastAppointment(app)) {
        showToast('Past appointments cannot be cancelled here', 'error');
        return;
    }
    if (!confirm('Cancel this appointment?')) return;
    try {
        await apiRequest(`/appointments/${Number(appId)}/cancel`, { method: 'POST' });
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        renderAppointments();
        showToast('Appointment cancelled.', 'error');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not cancel appointment'), 'error');
    }
}

// --- Admin ---
function renderAdmin() {
    if (!hasPermission('adminPanel')) {
        showToast('Admin privileges required', 'error');
        navigate(defaultViewFor(appState.currentUser));
        return;
    }
    switchAdminTab('admin-users');
}

function switchAdminTab(tabId) {
    ['admin-users', 'admin-doctors', 'admin-marketing', 'admin-appointments', 'admin-today-serials'].forEach(t => {
        getEl(`tab-${t}`)?.classList.remove('active');
        getEl(`${t}-content`)?.classList.add('hidden');
    });
    getEl(`tab-${tabId}`)?.classList.add('active');
    getEl(`${tabId}-content`)?.classList.remove('hidden');

    if (tabId === 'admin-users') renderAdminUsers();
    if (tabId === 'admin-doctors') renderAdminDoctors();
    if (tabId === 'admin-marketing') renderAdminMarketing();
    if (tabId === 'admin-appointments') renderAdminAppointments();
    if (tabId === 'admin-today-serials') renderAdminTodaySerials();
}

function renderAdminUsers() {
    const tbody = getEl('admin-user-list');
    tbody.innerHTML = '';
    const patients = appState.users.filter(u => getRole(u) === ROLES.USER);
    if (patients.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="color:var(--text-muted)">No patients have registered yet.</td></tr>';
        return;
    }
    tbody.innerHTML = patients.map(user => `
        <tr>
            <td data-label="Name"><strong>${escapeHTML(user.name)}</strong></td>
            <td data-label="Phone">${escapeHTML(user.phone)}</td>
            <td data-label="Age">${escapeHTML(user.age || '-')}</td>
            <td data-label="Gender">${escapeHTML(user.gender || '-')}</td>
            <td data-label="Email">${escapeHTML(user.email || '-')}</td>
            <td data-label="Actions">
                <div class="table-actions">
                    <button class="btn btn-outline btn-compact" onclick="editUser('${escapeHTML(user.id)}')">Edit</button>
                    <button class="btn btn-danger btn-compact" onclick="deleteUser('${escapeHTML(user.id)}')">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function editUser(userId) {
    const user = appState.users.find(u => u.id === userId);
    if (!user) return;
    getEl('edit-user-id').value = user.id;
    getEl('edit-user-name').value = user.name;
    getEl('edit-user-phone').value = user.phone;
    getEl('edit-user-email').value = user.email || '';
    getEl('edit-user-age').value = user.age || '';
    getEl('edit-user-gender').value = user.gender || '';
    getEl('admin-edit-user-modal').classList.add('active');
}

async function saveEditedUser() {
    const userId = getEl('edit-user-id').value;
    const user = appState.users.find(u => u.id === userId);
    if (!user) return;

    const name = getEl('edit-user-name').value.trim();
    const email = getEl('edit-user-email').value.trim();
    const ageVal = parseInt(getEl('edit-user-age').value, 10);
    const gender = getEl('edit-user-gender').value;

    if (name.length < 2) {
        showToast('Patient name is required', 'error');
        return;
    }
    if (email && !isValidEmail(email)) {
        showToast('Enter a valid email address', 'error');
        return;
    }
    if (!Number.isNaN(ageVal) && (ageVal < 1 || ageVal > 120)) {
        showToast('Enter a valid age', 'error');
        return;
    }

    setLoading('btn-save-edited-user', true, 'Saving...');
    try {
        await apiRequest(`/users/${encodeURIComponent(userId)}`, {
            method: 'PUT',
            body: JSON.stringify({
                name,
                email: email || null,
                age: Number.isNaN(ageVal) ? null : ageVal,
                gender: gender || null,
                bloodGroup: user.bloodGroup || null
            })
        });
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        showToast('Patient updated successfully');
        closeModal('admin-edit-user-modal');
        renderAdminUsers();
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not update patient'), 'error');
    } finally {
        setLoading('btn-save-edited-user', false);
    }
}

async function deleteUser(userId) {
    const user = appState.users.find(u => u.id === userId);
    if (!user) return;
    if (getRole(user) !== ROLES.USER) {
        showToast('Only patient accounts can be deleted here', 'error');
        return;
    }
    if (!confirm(`Delete patient "${user.name}"? This action cannot be undone.`)) return;

    try {
        await apiRequest(`/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        renderAdminUsers();
        showToast('Patient deleted.', 'error');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not delete patient'), 'error');
    }
}

// --- Admin marketing officers ---
function renderAdminMarketing() {
    const tbody = getEl('admin-marketing-list');
    if (!tbody) return;
    const officers = appState.users.filter(u => getRole(u) === ROLES.MARKETING);
    if (!officers.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center" style="color:var(--text-muted)">No marketing officers yet.</td></tr>';
        return;
    }
    tbody.innerHTML = officers.map(user => `
            <tr>
                <td data-label="Name"><strong>${escapeHTML(user.name)}</strong></td>
                <td data-label="Phone">${escapeHTML(user.phone)}</td>
                <td data-label="Email">${escapeHTML(user.email || '-')}</td>
                <td data-label="Role"><span class="badge badge-info">Marketing Officer</span></td>
            </tr>
    `).join('');
}

function openAdminMarketingModal() {
    getEl('admin-marketing-form')?.reset();
    getEl('admin-marketing-modal')?.classList.add('active');
}

async function saveMarketingOfficer() {
    const name = getEl('admin-marketing-name').value.trim();
    const phone = normalizePhone(getEl('admin-marketing-phone').value);
    const email = getEl('admin-marketing-email').value.trim();
    const password = getEl('admin-marketing-password').value;

    if (name.length < 2 || !isValidPhone(phone)) {
        showToast('Enter marketing officer name and valid phone', 'error');
        return;
    }
    if (!isValidEmail(email)) {
        showToast('Enter a valid email address', 'error');
        return;
    }
    if (password.length < 6) {
        showToast('Password must be at least 6 characters', 'error');
        return;
    }

    setLoading('btn-save-marketing', true, 'Creating...');
    try {
        await apiRequest('/marketing-officers', {
            method: 'POST',
            body: JSON.stringify({ name, phone, email: email || null, password, specialty: 'Marketing Officer' })
        });
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        closeModal('admin-marketing-modal');
        renderAdminMarketing();
        showToast('Marketing officer ID created');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not create marketing officer'), 'error');
    } finally {
        setLoading('btn-save-marketing', false);
    }
}

// --- Admin doctors ---
function renderAdminDoctors() {
    const tbody = getEl('admin-doctor-list');
    tbody.innerHTML = '';
    if (appState.doctors.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="color:var(--text-muted)">No doctors yet. Click "+ Add Doctor".</td></tr>';
        return;
    }
    tbody.innerHTML = appState.doctors.map(doc => {
        const statusLabel = doc.is_available ? '<span class="badge badge-success">Available</span>' : '<span class="badge badge-warning">Unavailable</span>';
        return `
        <tr>
            <td data-label="Name"><strong>${escapeHTML(doc.name)}</strong></td>
            <td data-label="Phone">${escapeHTML(doc.phone || '-')}</td>
            <td data-label="Category">${escapeHTML(doc.categoryLabel)}</td>
            <td data-label="Time">${escapeHTML(doc.time)}</td>
            <td data-label="Room">${escapeHTML(doc.room)}</td>
            <td data-label="Status">${statusLabel}</td>
            <td data-label="Actions">
                <div class="table-actions">
                    <button class="btn btn-outline btn-compact" onclick="editDoctor(${Number(doc.id)})">Edit</button>
                    <button class="btn btn-danger btn-compact" onclick="deleteDoctor(${Number(doc.id)})">Delete</button>
                </div>
            </td>
        </tr>
    `
    }).join('');
}

function openAdminDoctorModal(docId = null) {
    // Ensure time options are available before setting values
    generateTimeOptions('admin-doc-start-time');
    generateTimeOptions('admin-doc-end-time');
    
    const passwordGroup = getEl('admin-doc-password-group');
    if (docId) {
        const doc = appState.doctors.find(d => d.id === Number(docId));
        if (!doc) return;
        const linkedUser = appState.users.find(u => u.phone === doc.phone && getRole(u) === ROLES.DOCTOR);
        const schedule = getDoctorSchedule(doc);

        setText('admin-doc-modal-title', 'Edit Doctor');
        getEl('admin-doc-id').value = doc.id;
        getEl('admin-doc-name').value = doc.name;
        getEl('admin-doc-phone').value = doc.phone || '';
        getEl('admin-doc-phone').disabled = true;
        getEl('admin-doc-email').value = linkedUser?.email || '';
        const docCategory = Array.isArray(doc.category) && doc.category.length
            ? doc.category[0]
            : doc.categoryLabel;
        getEl('admin-doc-category').value = docCategory;
        getEl('admin-doc-start-time').value = schedule.startTime;
        getEl('admin-doc-end-time').value = schedule.endTime;
        getEl('admin-doc-room').value = doc.room;
        getEl('admin-doc-available').checked = doc.is_available ? true : false;
        getEl('admin-doc-password').value = '';
        passwordGroup.classList.add('hidden');
    } else {
        setText('admin-doc-modal-title', 'Add New Doctor');
        getEl('admin-doc-form').reset();
        getEl('admin-doc-id').value = '';
        getEl('admin-doc-phone').disabled = false;
        getEl('admin-doc-available').checked = true;
        passwordGroup.classList.remove('hidden');
        getEl('admin-doc-start-time').value = '09:00';
        getEl('admin-doc-end-time').value = '17:00';
    }
    getEl('admin-doctor-modal').classList.add('active');
}

function editDoctor(id) { openAdminDoctorModal(id); }

async function deleteDoctor(id) {
    const doc = appState.doctors.find(d => d.id === Number(id));
    if (!doc) return;
    if (!confirm(`Delete doctor "${doc.name}" and cancel their booked appointments?`)) return;

    try {
        await apiRequest(`/doctors/${Number(id)}`, { method: 'DELETE' });
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        renderAdminDoctors();
        showToast('Doctor removed and active appointments cancelled.', 'error');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not delete doctor'), 'error');
    }
}

async function saveDoctor() {
    const idVal = getEl('admin-doc-id').value;
    const name = getEl('admin-doc-name').value.trim();
    const phone = normalizePhone(getEl('admin-doc-phone').value);
    const email = getEl('admin-doc-email').value.trim();
    const category = getEl('admin-doc-category').value;
    const startTime = getEl('admin-doc-start-time').value;
    const endTime = getEl('admin-doc-end-time').value;
    const room = getEl('admin-doc-room').value.trim();
    const password = getEl('admin-doc-password').value;
    const isAvailable = getEl('admin-doc-available').checked;

    if (name.length < 2 || !phone || !category || !startTime || !endTime || !room) {
        showToast('Please fill required fields', 'error');
        return;
    }
    if (!isValidPhone(phone)) {
        showToast('Enter a valid doctor phone number', 'error');
        return;
    }
    if (!isValidEmail(email)) {
        showToast('Enter a valid email address', 'error');
        return;
    }
    if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
        showToast('End time must be after start time', 'error');
        return;
    }
    if (!idVal) {
        if (password.length < 6) {
            showToast('Password must be at least 6 characters', 'error');
            return;
        }
        if (appState.users.some(u => u.phone === phone)) {
            showToast('A user with this phone already exists', 'error');
            return;
        }
    }

    setLoading('btn-save-doc', true, 'Saving...');
    try {
        const payload = { name, phone, email: email || null, category, startTime, endTime, room };
        if (idVal) {
            // Update doctor details first
            await apiRequest(`/doctors/${Number(idVal)}`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            
            // Refresh data to get updated doctor info
            await refreshDataFromApi();
            
            // Get the refreshed doctor from the updated data
            const refreshedDoc = appState.doctors.find(d => d.id === Number(idVal));
            const currentAvailability = refreshedDoc?.is_available;
            const desiredAvailability = isAvailable ? 1 : 0;
            
            // Toggle availability if it doesn't match what user wants
            if (currentAvailability !== desiredAvailability) {
                await apiRequest(`/doctors/${Number(idVal)}/availability`, {
                    method: 'PATCH'
                });
                // Refresh again to get the final state
                await refreshDataFromApi();
            }
            showToast('Doctor updated');
        } else {
            await apiRequest('/doctors', {
                method: 'POST',
                body: JSON.stringify({ ...payload, password })
            });
            await refreshDataFromApi();
            showToast('Doctor added with login account');
        }
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        closeModal('admin-doctor-modal');
        renderAdminDoctors();
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not save doctor'), 'error');
    } finally {
        setLoading('btn-save-doc', false);
    }
}

// --- Admin appointments ---
function getFilteredAdminAppointments() {
    const date = getEl('filter-admin-app-date')?.value;
    const status = getEl('filter-admin-app-status')?.value;
    const docId = getEl('filter-admin-app-doctor')?.value;

    return appState.appointments.filter(a => {
        if (date && a.date !== date) return false;
        if (status && a.status !== status) return false;
        if (docId && String(a.docId) !== docId) return false;
        return true;
    });
}

function renderAdminAppointments() {
    const tbody = getEl('admin-all-appointments-list');
    tbody.innerHTML = '';
    const filtered = getFilteredAdminAppointments();
    const sorted = sortAppointments(filtered);
    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="color:var(--text-muted)">No appointments found.</td></tr>';
        return;
    }
    tbody.innerHTML = sorted.map(app => `
        <tr>
            <td data-label="Patient">
                <div><strong>${escapeHTML(app.patientName)}</strong></div>
                <div class="row-subtle">${escapeHTML(app.patientPhone)}</div>
                ${appointmentSourceMeta(app)}
                ${app.reason ? `<div class="row-note">${escapeHTML(app.reason)}</div>` : ''}
            </td>
            <td data-label="Doctor">${escapeHTML(app.docName)}</td>
            <td data-label="Date/Time">
                <div>${formatDate(app.date)}</div>
                <div class="row-subtle">Serial: ${app.serial_number ? `#${app.serial_number}` : '-'}</div>
            </td>
            <td data-label="Status"><span class="badge ${statusBadgeClass(app.status)}">${escapeHTML(app.status)}</span></td>
            <td data-label="Actions">
                <div class="table-actions">
                    <select class="compact-select" onchange="updateAppointmentStatus(${Number(app.id)}, this.value)">
                        <option value="Booked" ${app.status === 'Booked' ? 'selected' : ''}>Booked</option>
                        <option value="Completed" ${app.status === 'Completed' ? 'selected' : ''}>Completed</option>
                        <option value="Cancelled" ${app.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                    </select>
                    ${appointmentPdfActions(app.id)}
                </div>
            </td>
        </tr>
    `).join('');
}

function getFilteredTodaySerials() {
    const today = todayISO();
    const status = getEl('filter-admin-today-status')?.value;
    const docId = getEl('filter-admin-today-doctor')?.value;

    return appState.appointments.filter(a => {
        if (a.date !== today) return false;
        if (status && a.status !== status) return false;
        if (docId && String(a.docId) !== docId) return false;
        return true;
    });
}

function renderAdminTodaySerials() {
    const tbody = getEl('admin-today-serials-list');
    tbody.innerHTML = '';
    const filtered = getFilteredTodaySerials();
    const sorted = sortAppointments(filtered);
    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="color:var(--text-muted)">No serials found for today.</td></tr>';
        return;
    }
    tbody.innerHTML = sorted.map(app => `
        <tr>
            <td data-label="Patient">
                <div><strong>${escapeHTML(app.patientName)}</strong></div>
                <div class="row-subtle">${escapeHTML(app.patientPhone)}</div>
                ${appointmentSourceMeta(app)}
                ${app.reason ? `<div class="row-note">${escapeHTML(app.reason)}</div>` : ''}
            </td>
            <td data-label="Doctor">${escapeHTML(app.docName)}</td>
            <td data-label="Serial / Date">
                <div>Serial: <strong>${app.serial_number ? `#${app.serial_number}` : '-'}</strong></div>
                <div class="row-subtle">${formatDate(app.date)}</div>
            </td>
            <td data-label="Status"><span class="badge ${statusBadgeClass(app.status)}">${escapeHTML(app.status)}</span></td>
            <td data-label="Actions">
                <div class="table-actions">
                    <select class="compact-select" onchange="updateAppointmentStatus(${Number(app.id)}, this.value)">
                        <option value="Booked" ${app.status === 'Booked' ? 'selected' : ''}>Booked</option>
                        <option value="Completed" ${app.status === 'Completed' ? 'selected' : ''}>Completed</option>
                        <option value="Cancelled" ${app.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                    </select>
                    ${appointmentPdfActions(app.id)}
                </div>
            </td>
        </tr>
    `).join('');
}

function generateTimeOptions(selectId) {
    const select = getEl(selectId);
    if (!select) return;
    const first = select.querySelector('option[value=""]')?.outerHTML || '<option value="">Select</option>';
    select.innerHTML = first;

    for (let h = 6; h <= 22; h++) {
        for (let m = 0; m < 60; m += SLOT_INTERVAL_MINUTES) {
            const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            const option = document.createElement('option');
            option.value = value;
            option.textContent = formatTime(value);
            select.appendChild(option);
        }
    }
}

async function updateAppointmentStatus(id, newStatus) {
    if (!VALID_APPOINTMENT_STATUSES.includes(newStatus)) {
        showToast('Invalid appointment status', 'error');
        return;
    }
    const app = appState.appointments.find(a => a.id === Number(id));
    if (!app) return;
    try {
        await apiRequest(`/appointments/${Number(id)}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: newStatus })
        });
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        renderAdminAppointments();
        if (getEl('admin-today-serials-content') && !getEl('admin-today-serials-content').classList.contains('hidden')) renderAdminTodaySerials();
        showToast(`Status updated to ${newStatus}`);
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not update status'), 'error');
        renderAdminAppointments();
        if (getEl('admin-today-serials-content') && !getEl('admin-today-serials-content').classList.contains('hidden')) renderAdminTodaySerials();
    }
}

function openMarketingPasswordModal() {
    if (!hasPermission('changeOwnPassword')) {
        showToast('Only marketing officers can change password here', 'error');
        return;
    }
    getEl('marketing-password-form')?.reset();
    getEl('marketing-password-modal')?.classList.add('active');
}

async function changeMarketingPassword() {
    const currentPassword = getEl('marketing-current-password').value;
    const newPassword = getEl('marketing-new-password').value;
    const confirmPassword = getEl('marketing-confirm-password').value;

    if (!currentPassword) {
        showToast('Enter current password', 'error');
        return;
    }
    if (newPassword.length < 6) {
        showToast('Password must be at least 6 characters', 'error');
        return;
    }
    if (newPassword !== confirmPassword) {
        showToast('Passwords do not match', 'error');
        return;
    }

    setLoading('btn-change-marketing-password', true, 'Saving...');
    try {
        await apiRequest('/password/change', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword })
        });
        closeModal('marketing-password-modal');
        showToast('Password changed successfully');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not change password'), 'error');
    } finally {
        setLoading('btn-change-marketing-password', false);
    }
}

function bindUIEvents() {
    getEl('booking-date')?.addEventListener('change', renderBookingTimeSlots);

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', event => {
            if (event.target === overlay) {
                if (overlay.id === 'appointment-pdf-modal') closeAppointmentPdfModal();
                else closeModal(overlay.id);
            }
        });
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active').forEach(modal => {
                if (modal.id === 'appointment-pdf-modal') closeAppointmentPdfModal();
                else closeModal(modal.id);
            });
        }
    });

    ['reg-otp', 'forgot-otp'].forEach(id => {
        getEl(id)?.addEventListener('input', event => {
            event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
        });
    });
}

// --- Export and Filter Utils ---
function exportToCSV(appointments, filename) {
    if (!appointments || !appointments.length) {
        showToast('No data to export', 'error');
        return;
    }

    const headers = ['Appointment ID', 'Date', 'Time/Serial', 'Patient Name', 'Patient Phone', 'Doctor', 'Room', 'Status', 'Reason', 'Source'];
    const csvRows = [headers.join(',')];

    appointments.forEach(app => {
        const id = formatAppointmentId(app.id);
        const date = app.date || '-';
        const timeSerial = app.serial_number ? `Serial #${app.serial_number}` : (formatTime(app.time) || '-');
        const patientName = `"${(app.patientName || '').replace(/"/g, '""')}"`;
        const patientPhone = app.patientPhone || '-';
        const doctor = `"${(app.docName || '').replace(/"/g, '""')}"`;
        const room = app.room || '-';
        const status = app.status || '-';
        const reason = `"${(app.reason || '').replace(/"/g, '""')}"`;
        
        let source = 'Patient';
        if (app.commissionDoctorName) source = `Commission Doctor: ${app.commissionDoctorName}`;
        else if (app.marketingOfficerName) source = `Marketing Officer: ${app.marketingOfficerName}`;
        else if (app.bookedByName && app.bookedByRole !== ROLES.USER) source = `${app.bookedByName} (${roleLabel(app.bookedByRole)})`;
        source = `"${source.replace(/"/g, '""')}"`;

        csvRows.push([id, date, timeSerial, patientName, patientPhone, doctor, room, status, reason, source].join(','));
    });

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function populateFilterDropdowns() {
    const doctorOptions = '<option value="">All Doctors</option>' + 
        appState.doctors.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join('');
        
    ['filter-my-app-doctor', 'filter-admin-app-doctor', 'filter-admin-today-doctor'].forEach(id => {
        const el = getEl(id);
        if (el) {
            const currentVal = el.value;
            el.innerHTML = doctorOptions;
            el.value = currentVal;
        }
    });
}

function clearMyAppFilters() {
    if(getEl('filter-my-app-date')) getEl('filter-my-app-date').value = '';
    if(getEl('filter-my-app-status')) getEl('filter-my-app-status').value = '';
    if(getEl('filter-my-app-doctor')) getEl('filter-my-app-doctor').value = '';
    renderAppointments();
}

function clearAdminAppFilters() {
    if(getEl('filter-admin-app-date')) getEl('filter-admin-app-date').value = '';
    if(getEl('filter-admin-app-status')) getEl('filter-admin-app-status').value = '';
    if(getEl('filter-admin-app-doctor')) getEl('filter-admin-app-doctor').value = '';
    renderAdminAppointments();
}

function clearTodaySerialsFilters() {
    if(getEl('filter-admin-today-status')) getEl('filter-admin-today-status').value = '';
    if(getEl('filter-admin-today-doctor')) getEl('filter-admin-today-doctor').value = '';
    renderAdminTodaySerials();
}

function exportMyAppointments() { exportToCSV(sortAppointments(getFilteredMyAppointments()), 'my-appointments.csv'); }
function exportAdminAppointments() { exportToCSV(sortAppointments(getFilteredAdminAppointments()), 'all-appointments.csv'); }
function exportTodaySerials() { exportToCSV(sortAppointments(getFilteredTodaySerials()), 'today-serials.csv'); }

// Boot
generateTimeOptions('admin-doc-start-time');
generateTimeOptions('admin-doc-end-time');
bindUIEvents();
loadData();
