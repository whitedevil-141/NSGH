// NSGH Care client-side appointment portal.
const STORAGE_SESSION = 'medicare_session';
const STORAGE_API_TOKEN = 'medicare_api_token';
const STORAGE_VIEW = 'medicare_last_view';
const API_BASE = window.NSGH_APPOINTMENT_API || 'https://api.nsghbd.com/appointment';
const SLOT_INTERVAL_MINUTES = 30;
const BOOKING_WINDOW_DAYS = 7;
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAY_ALIASES = {
    mon: 'Monday',
    monday: 'Monday',
    tue: 'Tuesday',
    tues: 'Tuesday',
    tuesday: 'Tuesday',
    wed: 'Wednesday',
    wednesday: 'Wednesday',
    thu: 'Thursday',
    thur: 'Thursday',
    thurs: 'Thursday',
    thursday: 'Thursday',
    fri: 'Friday',
    friday: 'Friday',
    sat: 'Saturday',
    saturday: 'Saturday',
    sun: 'Sunday',
    sunday: 'Sunday'
};

const ROLES = { USER: 'user', DOCTOR: 'doctor', ADMIN: 'admin', MARKETING: 'marketing', COMMISSION_DOCTOR: 'commission_doctor' };
const VALID_APPOINTMENT_STATUSES = ['Booked', 'Completed', 'Cancelled'];

const PERMISSIONS = {
    user: { dashboard: true, viewDoctors: true, viewAppointments: true, createAppointments: true, cancelAppointments: true },
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

let paginationState = {
    myApp: { skip: 0, limit: 10 },
    adminApp: { skip: 0, limit: 10 },
    todaySerials: { skip: 0, limit: 10 }
};

let bookingDatePickerState = {
    visibleMonth: null,
    selectedDate: '',
    docId: null,
    allowedDates: new Set()
};

// --- Helpers ---
function getEl(id) { return document.getElementById(id); }

function closeBookingDatePicker() {
    getEl('booking-date-picker')?.classList.remove('is-open');
    getEl('booking-date-trigger')?.setAttribute('aria-expanded', 'false');
}

function openBookingDatePicker() {
    getEl('booking-date-picker')?.classList.add('is-open');
    getEl('booking-date-trigger')?.setAttribute('aria-expanded', 'true');
}

function toggleBookingDatePicker(forceOpen = null) {
    const picker = getEl('booking-date-picker');
    if (!picker) return;
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !picker.classList.contains('is-open');
    if (shouldOpen) openBookingDatePicker();
    else closeBookingDatePicker();
}

function bookingDatePickerMonthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthLabel(date) {
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatLongDate(dateStr) {
    const date = parseLocalDate(dateStr);
    if (!date) return '';
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function getMonthStart(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, amount) {
    return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function getNextAvailableBookingDate(doc) {
    const today = todayISO();
    if (isDoctorWorkingOnDate(doc, today) && !isTodayBookingCutoffPassed(doc, today)) {
        return today;
    }
    for (let i = 1; i <= 7; i++) {
        const candidate = addDaysISO(i);
        if (isDoctorWorkingOnDate(doc, candidate)) {
            return candidate;
        }
    }
    return null;
}

function isDateSelectableForBooking(doc, dateStr) {
    return !!doc && dateStr === getNextAvailableBookingDate(doc);
}

function getAllowedBookingDates(doc) {
    const candidate = getNextAvailableBookingDate(doc);
    return candidate ? [candidate] : [];
}

function selectBookingDate(dateStr) {
    const doc = appState.doctors.find(d => d.id === Number(bookingDatePickerState.docId));
    if (!doc || !dateStr || !isAllowedBookingDate(doc, dateStr)) return;

    bookingDatePickerState.selectedDate = dateStr;
    bookingDatePickerState.visibleMonth = getMonthStart(parseLocalDate(dateStr));
    const hiddenInput = getEl('booking-date');
    if (hiddenInput) hiddenInput.value = dateStr;
    renderBookingDatePicker();
    renderBookingTimeSlots();
    closeBookingDatePicker();
}

function moveBookingDatePickerMonth(offset) {
    const nextMonth = addMonths(bookingDatePickerState.visibleMonth || getMonthStart(new Date()), offset);
    renderBookingDatePicker(nextMonth);
}

function renderBookingDatePicker(monthDate = null) {
    const doc = appState.doctors.find(d => d.id === Number(bookingDatePickerState.docId));
    const grid = getEl('booking-date-grid');
    const monthLabel = getEl('booking-date-month-label');
    const triggerLabel = getEl('booking-date-trigger-label');
    const helper = getEl('booking-date-helper');
    const hiddenInput = getEl('booking-date');
    if (!grid || !monthLabel || !triggerLabel || !hiddenInput) return;

    const baseMonth = monthDate || bookingDatePickerState.visibleMonth || getMonthStart(new Date());
    bookingDatePickerState.visibleMonth = getMonthStart(baseMonth);

    const allowedDates = Array.from(bookingDatePickerState.allowedDates || []);
    const selectedDate = bookingDatePickerState.selectedDate;
    const isAvailable = selectedDate && allowedDates.includes(selectedDate);

    monthLabel.textContent = 'Next available appointment';

    const cells = [];
    if (selectedDate && doc) {
        const date = parseLocalDate(selectedDate);
        const weekday = date ? date.toLocaleDateString('en-US', { weekday: 'long' }) : 'Next Date';
        const fullDate = formatLongDate(selectedDate);
        cells.push(`
            <button type="button" class="date-picker-day date-picker-single${isAvailable ? ' is-selected' : ''}" data-date="${selectedDate}" aria-label="${fullDate}">
                <strong>${weekday}</strong>
                <span>${fullDate}</span>
                <small>${isAvailable ? 'Selected for booking' : 'Not available'}</small>
            </button>
        `);
    } else {
        cells.push('<div class="date-picker-day date-picker-single is-disabled" aria-live="polite"><strong>No appointment date available</strong><span>No upcoming dates open for this doctor.</span><small>Please choose another doctor.</small></div>');
    }

    grid.innerHTML = cells.join('');
    triggerLabel.textContent = bookingDatePickerState.selectedDate
        ? `${formatLongDate(bookingDatePickerState.selectedDate)}`
        : 'No date available';
    if (helper) {
        helper.textContent = bookingDatePickerState.selectedDate
            ? `Selected automatically: ${formatLongDate(bookingDatePickerState.selectedDate)}.`
            : 'No upcoming date is available for this doctor.';
    }
}

function toggleNav() {
    const navLinks = getEl('nav-links');
    const hamburgerBtn = document.querySelector('.hamburger-btn');
    if (navLinks) navLinks.classList.toggle('active');
    if (hamburgerBtn) hamburgerBtn.classList.toggle('active');
}

function togglePassword(inputId, btnEl) {
    const input = getEl(inputId);
    if (!input) return;
    
    if (input.type === 'password') {
        input.type = 'text';
        btnEl.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/></svg>';
    } else {
        input.type = 'password';
        btnEl.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    }
}

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

function startOtpTimer(btnId) {
    const btn = getEl(btnId);
    if (!btn) return;
    
    if (btn.dataset.timerId) {
        clearInterval(Number(btn.dataset.timerId));
    }
    
    let timeLeft = 60;
    btn.disabled = true;
    btn.textContent = `Resend OTP (${timeLeft}s)`;
    
    const timerId = window.setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
            window.clearInterval(timerId);
            btn.textContent = 'Resend OTP';
            btn.disabled = false;
            delete btn.dataset.timerId;
        } else {
            btn.textContent = `Resend OTP (${timeLeft}s)`;
        }
    }, 1000);
    
    btn.dataset.timerId = timerId;
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

function normalizeWorkingDays(value) {
    let items = [];
    if (Array.isArray(value)) {
        items = value;
    } else if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
            if (trimmed.startsWith('[')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (Array.isArray(parsed)) items = parsed;
                } catch {
                    items = trimmed.split(',');
                }
            } else {
                items = trimmed.split(',');
            }
        }
    }

    const seen = new Set();
    const normalized = [];
    items.forEach(item => {
        const key = String(item || '').trim().toLowerCase().replace(/[^a-z]/g, '');
        const day = WEEKDAY_ALIASES[key];
        if (day && !seen.has(day)) {
            seen.add(day);
            normalized.push(day);
        }
    });

    if (!normalized.length) return [...WEEKDAY_NAMES];
    return WEEKDAY_NAMES.filter(day => normalized.includes(day));
}

function normalizeScheduleEntries(value) {
    let items = [];
    if (Array.isArray(value)) {
        items = value;
    } else if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) items = parsed;
            } catch {
                items = [];
            }
        }
    }

    const normalized = [];
    const seen = new Set();
    items.forEach(item => {
        const dayKey = String(item?.day || item?.weekday || '').trim().toLowerCase().replace(/[^a-z]/g, '');
        const day = WEEKDAY_ALIASES[dayKey];
        const startTime = String(item?.startTime || item?.start_time || '').trim();
        const endTime = String(item?.endTime || item?.end_time || '').trim();
        if (!day || seen.has(day) || !startTime || !endTime) return;
        if (timeToMinutes(endTime) <= timeToMinutes(startTime)) return;
        seen.add(day);
        normalized.push({ day, startTime, endTime });
    });

    return WEEKDAY_NAMES
        .filter(day => normalized.some(item => item.day === day))
        .map(day => normalized.find(item => item.day === day));
}

function formatScheduleEntriesLabel(entries) {
    const normalized = normalizeScheduleEntries(entries);
    if (!normalized.length) return 'Schedule not set';
    return normalized.map(item => `${item.day.slice(0, 3)} ${formatTime(item.startTime)} - ${formatTime(item.endTime)}`).join(', ');
}

function getScheduleEntryForDate(doc, dateStr) {
    const weekday = getWeekdayNameFromISO(dateStr);
    const schedule = normalizeScheduleEntries(doc?.workingSchedule ?? doc?.working_schedule);
    return schedule.find(item => item.day === weekday) || null;
}

function getPreviousWeekdayName(dayName) {
    const index = WEEKDAY_NAMES.indexOf(dayName);
    if (index < 0) return '';
    return WEEKDAY_NAMES[(index - 1 + WEEKDAY_NAMES.length) % WEEKDAY_NAMES.length];
}

function isAllowedBookingDate(doc, dateStr) {
    return isDoctorWorkingOnDate(doc, dateStr);
}

function getDoctorFallbackSchedule(doc) {
    const schedule = normalizeScheduleEntries(doc?.workingSchedule ?? doc?.working_schedule);
    if (schedule.length) return schedule[0];

    const startTime = doc?.startTime || doc?.start_time;
    const endTime = doc?.endTime || doc?.end_time;
    if (startTime && endTime && timeToMinutes(endTime) > timeToMinutes(startTime)) {
        return { day: 'Monday', startTime, endTime };
    }

    const parsed = parseScheduleFromLabel(doc?.time);
    return parsed ? { day: 'Monday', ...parsed } : { day: 'Monday', startTime: '09:00', endTime: '17:00' };
}

function getWeekdayNameFromISO(dateStr) {
    const date = parseLocalDate(dateStr);
    if (!date) return '';
    const index = (date.getDay() + 6) % 7;
    return WEEKDAY_NAMES[index];
}

function isDoctorWorkingOnDate(doc, dateStr) {
    return !!getScheduleEntryForDate(doc, dateStr);
}

function isTodayBookingCutoffPassed(doc, dateStr) {
    if (dateStr !== todayISO()) return false;
    const schedule = getScheduleEntryForDate(doc, dateStr) || getDoctorFallbackSchedule(doc);
    const startMinutes = timeToMinutes(schedule?.startTime);
    if (startMinutes === null) return false;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return nowMinutes >= startMinutes;
}

function getFirstValidBookingDate(doc) {
    return getNextAvailableBookingDate(doc) || '';
}

function parseScheduleFromLabel(label) {
    if (!label) return null;
    const [start, end] = String(label).split(/\s+-\s+/);
    const startMin = timeToMinutes(start);
    const endMin = timeToMinutes(end);
    if (startMin === null || endMin === null || endMin <= startMin) return null;
    return { startTime: minutesToTimeValue(startMin), endTime: minutesToTimeValue(endMin) };
}

function buildScheduleLabel(scheduleEntries) {
    return formatScheduleEntriesLabel(scheduleEntries);
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

        const pdfBlob = await response.blob();

        pdfState.objectUrl = URL.createObjectURL(pdfBlob);

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

function showAppointmentSuccess(app) {
    setText('success-patient-name', app.patientName);
    setText('success-patient-number', app.patientPhone);
    setText('success-doctor-name', app.docName);
    setText('success-date', formatDate(app.date));
    setText('success-serial', app.serial_number ? `#${app.serial_number}` : '-');
    getEl('appointment-success-modal')?.classList.add('active');
}

function closeSuccessModal() {
    closeModal('appointment-success-modal');
    navigate('appointments');
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
        const scheduleEntries = normalizeScheduleEntries(doc.workingSchedule ?? doc.working_schedule);
        const fallbackSchedule = scheduleEntries[0] || getDoctorFallbackSchedule(doc);
        const categories = normalizeCategoryList(doc.category ?? doc.specialty);
        const workingDays = scheduleEntries.map(item => item.day);
        const categoryLabel = categories.length ? categories.join(', ') : 'General Physician';
        const isAvailable = doc.is_available ?? doc.isAvailable ?? 1;
        return {
            ...doc,
            id: Number(doc.id),
            name: doc.name || 'Doctor',
            phone: doc.phone || '',
            category: categories,
            categoryLabel,
            workingDays,
            workingDaysLabel: workingDays.length ? (workingDays.length === 7 ? 'Every day' : workingDays.map(day => day.slice(0, 3)).join(', ')) : 'Every day',
            workingSchedule: scheduleEntries,
            workingScheduleLabel: formatScheduleEntriesLabel(scheduleEntries),
            startTime: fallbackSchedule.startTime,
            endTime: fallbackSchedule.endTime,
            time: formatScheduleEntriesLabel(scheduleEntries),
            room: doc.room || '-',
            is_available: isAvailable ? 1 : 0
        };
    });

    populateFilterDropdowns();
}

function normalizeAppointments(list) {
    return (list || []).map(app => {
        const minutes = timeToMinutes(app.time);
        return {
            ...app,
            id: Number(app.id),
            docId: Number(app.docId),
            time: minutes === null ? app.time : minutesToTimeValue(minutes),
            status: VALID_APPOINTMENT_STATUSES.includes(app.status) ? app.status : 'Booked',
            reason: app.reason || '',
            patientAge: app.patientAge ?? null,
            patientAddress: app.patientAddress || '',
            bookedById: app.bookedById || null,
            bookedByName: app.bookedByName || null,
            bookedByRole: app.bookedByRole || null,
            marketingOfficerId: app.marketingOfficerId || null,
            marketingOfficerName: app.marketingOfficerName || null,
            commissionDoctorId: app.commissionDoctorId || null,
            commissionDoctorName: app.commissionDoctorName || null
        };
    });
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
    getEl('nav-links')?.classList.remove('active');
    document.querySelector('.hamburger-btn')?.classList.remove('active');

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
    if (view === 'appointments') {
        paginationState.myApp.skip = 0;
        renderAppointments();
    }
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
    const adminTabs = getEl('admin-nav-tabs');
    if (adminTabs) {
        if (role === ROLES.ADMIN) {
            adminTabs.classList.remove('hidden');
            adminTabs.style.display = 'flex';
        } else {
            adminTabs.classList.add('hidden');
            adminTabs.style.display = 'none';
        }
    }
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
        startOtpTimer('btn-resend-reg-otp');
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

async function resendRegistrationOTP() {
    if (!authState.pendingRegistration) return;
    let success = false;
    setLoading('btn-resend-reg-otp', true, 'Sending...');
    try {
        await apiRequest('/otp/send', {
            method: 'POST',
            body: JSON.stringify({ phone: authState.pendingRegistration.phone })
        });
        showToast('OTP resent successfully');
        success = true;
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not resend OTP'), 'error');
    } finally {
        setLoading('btn-resend-reg-otp', false);
    }
    if (success) startOtpTimer('btn-resend-reg-otp');
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
        startOtpTimer('btn-resend-forgot-otp');
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

async function resendForgotOTP() {
    if (!authState.pendingReset) return;
    let success = false;
    setLoading('btn-resend-forgot-otp', true, 'Sending...');
    try {
        await apiRequest('/otp/send', {
            method: 'POST',
            body: JSON.stringify({ phone: authState.pendingReset.phone })
        });
        showToast('OTP resent successfully');
        success = true;
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not resend OTP'), 'error');
    } finally {
        setLoading('btn-resend-forgot-otp', false);
    }
    if (success) startOtpTimer('btn-resend-forgot-otp');
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

    const schedule = getScheduleEntryForDate(doc, date);
    if (!schedule) return [];
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
                            <p><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/></svg> ${escapeHTML(doc.workingScheduleLabel || doc.time || 'Schedule not set')}</p>
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
    if (
        !app.commissionDoctorName &&
        !app.marketingOfficerName &&
        app.bookedByName &&
        (app.bookedByRole !== ROLES.USER || app.bookedByName !== app.patientName)
    ) {
        lines.push(`Booked by: ${app.bookedByName} (${roleLabel(app.bookedByRole)})`);
    }
    return lines.map(line => `<div class="row-subtle">${escapeHTML(line)}</div>`).join('');
}

function appointmentPatientDetailsMeta(app) {
    const lines = [];
    if (app.patientAge !== null && app.patientAge !== undefined && app.patientAge !== '') lines.push(`Age: ${app.patientAge}`);
    if (app.patientAddress) lines.push(`Address: ${app.patientAddress}`);
    return lines.map(line => `<div class="row-subtle">${escapeHTML(line)}</div>`).join('');
}

function canCancelSerial(app) {
    const role = getRole(appState.currentUser);
    if (app.status !== 'Booked' || isPastAppointment(app)) return false;
    if (role === ROLES.USER) return app.patientPhone === appState.currentUser.phone || app.bookedById === appState.currentUser.id;
    if (role === ROLES.MARKETING) return app.marketingOfficerId === appState.currentUser.id || app.bookedById === appState.currentUser.id;
    if (role === ROLES.COMMISSION_DOCTOR) return app.commissionDoctorId === appState.currentUser.id || app.bookedById === appState.currentUser.id;
    return false;
}

function renderPaginationControls(containerId, pagState, currentLength, callbackName) {
    const container = getEl(containerId);
    if (!container) return;
    
    const isFirstPage = pagState.skip === 0;
    const hasNextPage = currentLength === pagState.limit;
    
    if (isFirstPage && !hasNextPage && currentLength === 0) {
        container.innerHTML = '';
        return;
    }
    
    const pageNum = Math.floor(pagState.skip / pagState.limit) + 1;
    
    container.innerHTML = `
        <button class="btn btn-outline btn-compact" onclick="${callbackName}('prev')" ${isFirstPage ? 'disabled' : ''}>Previous</button>
        <span class="text-sm" style="color:var(--text-muted)">Page ${pageNum}</span>
        <button class="btn btn-outline btn-compact" onclick="${callbackName}('next')" ${!hasNextPage ? 'disabled' : ''}>Next</button>
    `;
}

async function renderAppointments(action = null) {
    if (action === 'next') paginationState.myApp.skip += paginationState.myApp.limit;
    else if (action === 'prev') paginationState.myApp.skip = Math.max(0, paginationState.myApp.skip - paginationState.myApp.limit);
    else if (action === 'reset') paginationState.myApp.skip = 0;

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

    listEl.innerHTML = '<tr><td colspan="6" class="text-center">Loading...</td></tr>';
    tableContainer.classList.remove('hidden');
    getEl('appointments-empty').classList.add('hidden');

    try {
        const date = getEl('filter-my-app-date')?.value || '';
        const status = getEl('filter-my-app-status')?.value || '';
        const docId = getEl('filter-my-app-doctor')?.value || '';

        let url = `/appointments?skip=${paginationState.myApp.skip}&limit=${paginationState.myApp.limit}`;
        if (date) url += `&date=${date}`;
        if (status) url += `&status=${status}`;
        if (docId) url += `&doctor_id=${docId}`;

        const rawData = await apiRequest(url);
        const myApps = normalizeAppointments(rawData);
        appState.appointments = myApps;

        if (myApps.length === 0 && paginationState.myApp.skip === 0) {
            tableContainer.classList.add('hidden');
            getEl('appointments-empty').classList.remove('hidden');
            getEl('my-app-pagination').innerHTML = '';
            return;
        }
        
        tableContainer.classList.remove('hidden');
        getEl('appointments-empty').classList.add('hidden');

        listEl.innerHTML = sortAppointments(myApps).map(app => {
        const canCancel = canCancelSerial(app);
        const firstCol = role === ROLES.DOCTOR
            ? `<strong>${escapeHTML(app.patientName)}</strong><div class="row-subtle">${escapeHTML(app.patientPhone)}</div>${appointmentPatientDetailsMeta(app)}${appointmentSourceMeta(app)}${app.reason ? `<div class="row-note">${escapeHTML(app.reason)}</div>` : ''}`
            : (role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR)
                ? `<strong>${escapeHTML(app.patientName)}</strong><div class="row-subtle">${escapeHTML(app.patientPhone)}</div>${appointmentPatientDetailsMeta(app)}<div class="row-subtle">Doctor: ${escapeHTML(app.docName)}</div>${appointmentSourceMeta(app)}${app.reason ? `<div class="row-note">${escapeHTML(app.reason)}</div>` : ''}`
                : `<strong>${escapeHTML(app.docName)}</strong><div class="row-subtle">Patient: ${escapeHTML(app.patientName)}</div><div class="row-subtle">Number: ${escapeHTML(app.patientPhone)}</div>${appointmentPatientDetailsMeta(app)}${appointmentSourceMeta(app)}${app.reason ? `<div class="row-note">${escapeHTML(app.reason)}</div>` : ''}`;

        const actionCol = role === ROLES.DOCTOR
            ? `
                <div class="table-actions">
                    <select class="compact-select" onchange="updateAppointmentStatus(${Number(app.id)}, this.value)">
                        <option value="Booked" ${app.status === 'Booked' ? 'selected' : ''}>Booked</option>
                        <option value="Completed" ${app.status === 'Completed' ? 'selected' : ''}>Completed</option>
                        <option value="Cancelled" ${app.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                    </select>
                    ${appointmentPdfActions(app.id)}
                </div>
            `
            : `
                <div class="table-actions">
                    ${appointmentPdfActions(app.id)}
                    ${canCancel
                        ? `<button class="btn btn-outline btn-compact btn-danger-ghost" onclick="cancelAppointment(${Number(app.id)})">Cancel</button>`
                        : ''}
                </div>
            `;

        return `
            <tr>
                <td data-label="${role === ROLES.DOCTOR || role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR ? 'Patient' : 'Doctor'}">${firstCol}</td>
                <td data-label="Date">${formatDate(app.date)}</td>
                <td data-label="Serial">${app.serial_number ? `#${app.serial_number}` : '-'}</td>
                <td data-label="Room">${escapeHTML(app.room)}</td>
                <td data-label="Status"><span class="badge ${statusBadgeClass(app.status)}">${escapeHTML(app.status)}</span></td>
                <td data-label="Action">
                    ${actionCol}
                </td>
            </tr>
        `;
    }).join('');
        renderPaginationControls('my-app-pagination', paginationState.myApp, myApps.length, 'renderAppointments');
    } catch (e) {
        listEl.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Failed to load appointments</td></tr>';
        getEl('my-app-pagination').innerHTML = '';
    }
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
    bookingDatePickerState.docId = doc.id;
    setText('modal-doc-name', doc.name);
    setText('modal-doc-cat', doc.categoryLabel);
    setText('modal-doc-time', doc.workingScheduleLabel || doc.time || 'Schedule not set');
    setText('modal-doc-days', doc.workingScheduleLabel || 'Schedule not set');
    setText('modal-doc-room', doc.room);
    setText('modal-doc-initial', initial);
    getEl('booking-patient-fields')?.classList.remove('hidden');
    getEl('booking-patient-name').value = appState.currentUser?.name || '';
    getEl('booking-patient-age').value = appState.currentUser?.age || '';
    getEl('booking-patient-address').value = '';
    getEl('booking-patient-phone').value = appState.currentUser?.phone || '';
    setText('booking-reason-label', 'Note');
    getEl('booking-reason').placeholder = 'Write a note for this appointment';

    const hasAvailableDate = setupBookingDateInput(doc);
    if (!hasAvailableDate) {
        showToast('No valid booking days available for this doctor right now', 'error');
        return;
    }
    getEl('booking-reason').value = '';
    
    getEl('btn-confirm-booking').disabled = false;
    getEl('booking-modal').classList.add('active');
    openBookingDatePicker();
}

function setupBookingDateInput(doc) {
    const input = getEl('booking-date');
    const helper = getEl('booking-date-helper');
    if (!input) return false;

    const allowedDates = getAllowedBookingDates(doc);
    bookingDatePickerState.docId = doc.id;
    bookingDatePickerState.allowedDates = new Set(allowedDates);
    bookingDatePickerState.selectedDate = allowedDates[0] || '';
    bookingDatePickerState.visibleMonth = bookingDatePickerState.selectedDate
        ? getMonthStart(parseLocalDate(bookingDatePickerState.selectedDate))
        : getMonthStart(new Date());
    input.value = bookingDatePickerState.selectedDate;
    renderBookingDatePicker();

    if (helper) {
        helper.textContent = allowedDates.length
            ? 'Next available date is selected automatically so booking stays quick and simple.'
            : 'No upcoming dates are available for this doctor.';
    }

    return !!allowedDates.length;
}

function renderBookingTimeSlots() {
    const docId = parseInt(getEl('booking-doc-id')?.value || '', 10);
    const date = getEl('booking-date')?.value;
    const helper = getEl('booking-date-helper');
    const confirmBtn = getEl('btn-confirm-booking');
    if (!helper || !confirmBtn) return;

    if (!docId || !date) {
        helper.textContent = 'Select an available date to continue.';
        confirmBtn.disabled = true;
        return;
    }

    const doc = appState.doctors.find(d => d.id === Number(docId));
    const nextDate = getNextAvailableBookingDate(doc);
    if (!doc || date !== nextDate || !isAllowedBookingDate(doc, date)) {
        const fallbackDate = getFirstValidBookingDate(doc);
        if (fallbackDate && getEl('booking-date')) getEl('booking-date').value = fallbackDate;
        helper.textContent = 'Choose the next available date from the calendar.';
        confirmBtn.disabled = !fallbackDate;
        return;
    }

    helper.textContent = `${formatDate(date)} is available for booking.`;
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
    const patientAgeRaw = getEl('booking-patient-age')?.value.trim() || '';
    const patientAge = patientAgeRaw === '' ? null : Number(patientAgeRaw);
    const patientAddress = getEl('booking-patient-address')?.value.trim() || '';
    const patientPhone = normalizePhone(getEl('booking-patient-phone')?.value || '');
    const doc = appState.doctors.find(d => d.id === docId);

    if (!doc || !date) {
        showToast('Please select a date', 'error');
        return;
    }
    const nextDate = getNextAvailableBookingDate(doc);
    if (date !== nextDate) {
        showToast('Choose the next available appointment date', 'error');
        return;
    }
    if (!isAllowedBookingDate(doc, date)) {
        const weekday = getWeekdayNameFromISO(date);
        showToast(`Doctor is not available on ${weekday || 'that day'}`, 'error');
        return;
    }
    if (getScheduleEntryForDate(doc, date) && isTodayBookingCutoffPassed(doc, date)) {
        showToast('Today booking is closed after doctor start time. Choose another date.', 'error');
        return;
    }
    if (patientName.length < 2) {
        showToast('Patient name is required', 'error');
        return;
    }
    if (!Number.isInteger(patientAge) || patientAge < 0 || patientAge > 120) {
        showToast('Enter a valid patient age', 'error');
        return;
    }
    if (patientAddress.length < 3) {
        showToast('Patient address is required', 'error');
        return;
    }
    if (!isValidPhone(patientPhone)) {
        showToast('Enter a valid patient number', 'error');
        return;
    }

    setLoading('btn-confirm-booking', true, 'Booking...');
    try {
        const payload = { docId, date, reason, patientName, patientAge, patientAddress, patientPhone };
        const response = await apiRequest('/appointments', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        
        // Handle the queue response with serial number
        const appointment = response.details || response;
        const serialNumber = response.serial_number || appointment.serial_number;
        
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        closeModal('booking-modal');
        
        // Show success with queue position
        const message = response.message || 'Appointment booked successfully.';
        const queueMsg = response.queue_position ? `\n${response.queue_position}` : '';
        showToast(`${message}${queueMsg}`);
        navigate('appointments');
        showAppointmentSuccess(appointment);
        showToast('Appointment booked successfully');
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
        renderAppointments('reset');
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
    if (appState.currentView !== 'admin') {
        navigateSafe('admin');
    }

    getEl('nav-links')?.classList.remove('active');
    document.querySelector('.hamburger-btn')?.classList.remove('active');

    ['admin-users', 'admin-doctors', 'admin-marketing', 'admin-appointments', 'admin-today-serials'].forEach(t => {
        getEl(`tab-${t}`)?.classList.remove('active');
        getEl(`${t}-content`)?.classList.add('hidden');
    });
    getEl(`tab-${tabId}`)?.classList.add('active');
    getEl(`${tabId}-content`)?.classList.remove('hidden');

    if (tabId === 'admin-users') renderAdminUsers();
    if (tabId === 'admin-doctors') renderAdminDoctors();
    if (tabId === 'admin-marketing') renderAdminMarketing();
    if (tabId === 'admin-appointments') { 
        paginationState.adminApp.skip = 0; 
        renderAdminAppointments(); 
    }
    if (tabId === 'admin-today-serials') { 
        paginationState.todaySerials.skip = 0; 
        renderAdminTodaySerials(); 
    }
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
function buildTimeOptions(selectedValue = '') {
    const options = ['<option value="">Select</option>'];
    for (let h = 6; h <= 22; h += 1) {
        for (let m = 0; m < 60; m += SLOT_INTERVAL_MINUTES) {
            const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            options.push(`<option value="${value}" ${value === selectedValue ? 'selected' : ''}>${formatTime(value)}</option>`);
        }
    }
    return options.join('');
}

function renderWorkingScheduleForm(scheduleEntries = []) {
    const rowsEl = getEl('admin-doc-schedule-rows');
    if (!rowsEl) return;
    const normalized = normalizeScheduleEntries(scheduleEntries);
    rowsEl.innerHTML = WEEKDAY_NAMES.map(day => {
        const entry = normalized.find(item => item.day === day) || null;
        const checked = entry ? 'checked' : '';
        const startValue = entry?.startTime || '09:00';
        const endValue = entry?.endTime || '17:00';
        return `
            <div class="schedule-row" data-day="${day}">
                <label class="schedule-day"><input type="checkbox" class="schedule-day-check" ${checked}> <span>${day}</span></label>
                <select class="schedule-start">${buildTimeOptions(startValue)}</select>
                <select class="schedule-end">${buildTimeOptions(endValue)}</select>
            </div>
        `;
    }).join('');
}

function setWorkingScheduleForm(scheduleEntries = []) {
    renderWorkingScheduleForm(scheduleEntries);
}

function getWorkingScheduleForm() {
    const rows = Array.from(document.querySelectorAll('#admin-doc-schedule-rows .schedule-row'));
    return rows.flatMap(row => {
        const day = row.dataset.day;
        const checked = row.querySelector('.schedule-day-check')?.checked;
        const startTime = row.querySelector('.schedule-start')?.value;
        const endTime = row.querySelector('.schedule-end')?.value;
        if (!checked) return [];
        if (!day || !startTime || !endTime || timeToMinutes(endTime) <= timeToMinutes(startTime)) return [];
        return [{ day, startTime, endTime }];
    });
}

function renderAdminDoctors() {
    const tbody = getEl('admin-doctor-list');
    tbody.innerHTML = '';
    if (appState.doctors.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="color:var(--text-muted)">No doctors yet. Click "+ Add Doctor".</td></tr>';
        return;
    }
    tbody.innerHTML = appState.doctors.map(doc => {
        const statusLabel = doc.is_available ? '<span class="badge badge-success">Available</span>' : '<span class="badge badge-warning">Unavailable</span>';
        return `
        <tr>
            <td data-label="Name"><strong>${escapeHTML(doc.name)}</strong></td>
            <td data-label="Phone">${escapeHTML(doc.phone || '-')}</td>
            <td data-label="Category">${escapeHTML(doc.categoryLabel)}</td>
            <td data-label="Working Schedule">${escapeHTML(doc.workingScheduleLabel || 'Schedule not set')}</td>
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
        const schedule = normalizeScheduleEntries(doc.workingSchedule ?? doc.working_schedule);

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
        setWorkingScheduleForm(schedule);
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
        setWorkingScheduleForm([]);
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
    const room = getEl('admin-doc-room').value.trim();
    const password = getEl('admin-doc-password').value;
    const isAvailable = getEl('admin-doc-available').checked;

    const workingSchedule = getWorkingScheduleForm();

    if (name.length < 2 || !phone || !category || !room) {
        showToast('Please fill required fields', 'error');
        return;
    }
    if (!workingSchedule.length) {
        showToast('Add at least one working day and time range', 'error');
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
        const payload = {
            name,
            phone,
            email: email || null,
            category,
            workingDays: workingSchedule.map(item => item.day),
            workingSchedule,
            room
        };
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
async function renderAdminAppointments(action = null) {
    if (action === 'next') paginationState.adminApp.skip += paginationState.adminApp.limit;
    else if (action === 'prev') paginationState.adminApp.skip = Math.max(0, paginationState.adminApp.skip - paginationState.adminApp.limit);
    else if (action === 'reset') paginationState.adminApp.skip = 0;

    const tbody = getEl('admin-all-appointments-list');
    tbody.innerHTML = '<tr><td colspan="5" class="text-center">Loading...</td></tr>';
    
    try {
        const date = getEl('filter-admin-app-date')?.value || '';
        const status = getEl('filter-admin-app-status')?.value || '';
        const docId = getEl('filter-admin-app-doctor')?.value || '';

        let url = `/appointments?skip=${paginationState.adminApp.skip}&limit=${paginationState.adminApp.limit}`;
        if (date) url += `&date=${date}`;
        if (status) url += `&status=${status}`;
        if (docId) url += `&doctor_id=${docId}`;

        const rawData = await apiRequest(url);
        const data = normalizeAppointments(rawData);
        appState.appointments = data;

        if (data.length === 0 && paginationState.adminApp.skip === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="color:var(--text-muted)">No appointments found.</td></tr>';
            getEl('admin-app-pagination').innerHTML = '';
            return;
        }
        
        const sorted = sortAppointments(data);
        tbody.innerHTML = sorted.map(app => `
        <tr>
            <td data-label="Patient">
                <div><strong>${escapeHTML(app.patientName)}</strong></div>
                <div class="row-subtle">${escapeHTML(app.patientPhone)}</div>
                ${appointmentPatientDetailsMeta(app)}
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
        renderPaginationControls('admin-app-pagination', paginationState.adminApp, data.length, 'renderAdminAppointments');
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger">Failed to load appointments</td></tr>';
        getEl('admin-app-pagination').innerHTML = '';
    }
}

async function renderAdminTodaySerials(action = null) {
    if (action === 'next') paginationState.todaySerials.skip += paginationState.todaySerials.limit;
    else if (action === 'prev') paginationState.todaySerials.skip = Math.max(0, paginationState.todaySerials.skip - paginationState.todaySerials.limit);
    else if (action === 'reset') paginationState.todaySerials.skip = 0;

    const tbody = getEl('admin-today-serials-list');
    tbody.innerHTML = '<tr><td colspan="5" class="text-center">Loading...</td></tr>';

    try {
        const today = todayISO();
        const status = getEl('filter-admin-today-status')?.value || '';
        const docId = getEl('filter-admin-today-doctor')?.value || '';

        let url = `/appointments?skip=${paginationState.todaySerials.skip}&limit=${paginationState.todaySerials.limit}&date=${today}`;
        if (status) url += `&status=${status}`;
        if (docId) url += `&doctor_id=${docId}`;

        const rawData = await apiRequest(url);
        const data = normalizeAppointments(rawData);
        appState.appointments = data;

        if (data.length === 0 && paginationState.todaySerials.skip === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="color:var(--text-muted)">No serials found for today.</td></tr>';
            getEl('today-serials-pagination').innerHTML = '';
            return;
        }
        
        const sorted = sortAppointments(data);
        tbody.innerHTML = sorted.map(app => `
        <tr>
            <td data-label="Patient">
                <div><strong>${escapeHTML(app.patientName)}</strong></div>
                <div class="row-subtle">${escapeHTML(app.patientPhone)}</div>
                ${appointmentPatientDetailsMeta(app)}
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
        renderPaginationControls('today-serials-pagination', paginationState.todaySerials, data.length, 'renderAdminTodaySerials');
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger">Failed to load serials</td></tr>';
        getEl('today-serials-pagination').innerHTML = '';
    }
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
        
        const appToUpdate = appState.appointments.find(a => a.id === Number(id));
        if(appToUpdate) appToUpdate.status = newStatus;
        
        if (getEl('appointments-view') && !getEl('appointments-view').classList.contains('hidden')) renderAppointments();
        if (getEl('admin-appointments-content') && !getEl('admin-appointments-content').classList.contains('hidden')) renderAdminAppointments();
        if (getEl('admin-today-serials-content') && !getEl('admin-today-serials-content').classList.contains('hidden')) renderAdminTodaySerials();
        showToast(`Status updated to ${newStatus}`);
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not update status'), 'error');
        if (getEl('appointments-view') && !getEl('appointments-view').classList.contains('hidden')) renderAppointments();
        if (getEl('admin-appointments-content') && !getEl('admin-appointments-content').classList.contains('hidden')) renderAdminAppointments();
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
    getEl('booking-date-trigger')?.addEventListener('click', () => toggleBookingDatePicker());
    getEl('booking-date-prev')?.addEventListener('click', () => moveBookingDatePickerMonth(-1));
    getEl('booking-date-next')?.addEventListener('click', () => moveBookingDatePickerMonth(1));
    getEl('booking-date-grid')?.addEventListener('click', event => {
        const button = event.target.closest('.date-picker-day');
        if (!button || button.disabled) return;
        selectBookingDate(button.dataset.date);
    });

    getEl('booking-date')?.addEventListener('change', renderBookingTimeSlots);

    document.addEventListener('click', event => {
        const picker = getEl('booking-date-picker');
        if (picker && !picker.contains(event.target)) closeBookingDatePicker();
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        if (overlay.querySelector('form')) return;
        overlay.addEventListener('click', event => {
            if (event.target === overlay) {
                if (overlay.id === 'appointment-pdf-modal') closeAppointmentPdfModal();
                else if (overlay.id === 'appointment-success-modal') closeSuccessModal();
                else closeModal(overlay.id);
            }
        });
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active').forEach(modal => {
                if (modal.id === 'appointment-pdf-modal') closeAppointmentPdfModal();
                else if (modal.id === 'appointment-success-modal') closeSuccessModal();
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

    const headers = ['Appointment ID', 'Date', 'Time/Serial', 'Patient Name', 'Patient Age', 'Patient Address', 'Patient Number', 'Doctor', 'Room', 'Status', 'Note', 'Source'];
    const csvRows = [headers.join(',')];

    appointments.forEach(app => {
        const id = formatAppointmentId(app.id);
        const date = app.date || '-';
        const timeSerial = app.serial_number ? `Serial #${app.serial_number}` : (formatTime(app.time) || '-');
        const patientName = `"${(app.patientName || '').replace(/"/g, '""')}"`;
        const patientAge = app.patientAge ?? '-';
        const patientAddress = `"${(app.patientAddress || '').replace(/"/g, '""')}"`;
        const patientPhone = app.patientPhone || '-';
        const doctor = `"${(app.docName || '').replace(/"/g, '""')}"`;
        const room = app.room || '-';
        const status = app.status || '-';
        const reason = `"${(app.reason || '').replace(/"/g, '""')}"`;
        
        let source = 'Patient';
        if (app.commissionDoctorName) source = `Commission Doctor: ${app.commissionDoctorName}`;
        else if (app.marketingOfficerName) source = `Marketing Officer: ${app.marketingOfficerName}`;
        else if (app.bookedByName && (app.bookedByRole !== ROLES.USER || app.bookedByName !== app.patientName)) source = `${app.bookedByName} (${roleLabel(app.bookedByRole)})`;
        source = `"${source.replace(/"/g, '""')}"`;

        csvRows.push([id, date, timeSerial, patientName, patientAge, patientAddress, patientPhone, doctor, room, status, reason, source].join(','));
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
    renderAppointments('reset');
}

function clearAdminAppFilters() {
    if(getEl('filter-admin-app-date')) getEl('filter-admin-app-date').value = '';
    if(getEl('filter-admin-app-status')) getEl('filter-admin-app-status').value = '';
    if(getEl('filter-admin-app-doctor')) getEl('filter-admin-app-doctor').value = '';
    renderAdminAppointments('reset');
}

function clearTodaySerialsFilters() {
    if(getEl('filter-admin-today-status')) getEl('filter-admin-today-status').value = '';
    if(getEl('filter-admin-today-doctor')) getEl('filter-admin-today-doctor').value = '';
    renderAdminTodaySerials('reset');
}

async function exportAppointmentsHelper(date, status, docId, filename) {
    let url = `/appointments?skip=0&limit=1000`;
    if (date) url += `&date=${date}`;
    if (status) url += `&status=${status}`;
    if (docId) url += `&doctor_id=${docId}`;
    try {
        const rawData = await apiRequest(url);
        exportToCSV(sortAppointments(normalizeAppointments(rawData)), filename);
    } catch(e) {
        showToast('Export failed', 'error');
    }
}

function exportMyAppointments() { 
    exportAppointmentsHelper(getEl('filter-my-app-date')?.value, getEl('filter-my-app-status')?.value, getEl('filter-my-app-doctor')?.value, 'my-appointments.csv'); 
}
function exportAdminAppointments() { 
    exportAppointmentsHelper(getEl('filter-admin-app-date')?.value, getEl('filter-admin-app-status')?.value, getEl('filter-admin-app-doctor')?.value, 'all-appointments.csv'); 
}
function exportTodaySerials() { 
    exportAppointmentsHelper(todayISO(), getEl('filter-admin-today-status')?.value, getEl('filter-admin-today-doctor')?.value, 'today-serials.csv'); 
}

// Boot
generateTimeOptions('admin-doc-start-time');
generateTimeOptions('admin-doc-end-time');
bindUIEvents();
loadData();
