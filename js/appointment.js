// NSGH Care client-side appointment portal.
const STORAGE_SESSION = 'medicare_session';
const STORAGE_API_TOKEN = 'medicare_api_token';
const STORAGE_VIEW = 'medicare_last_view';
const API_BASE = (window.NSGH_APPOINTMENT_API || (window.NSGH_API_BASE + '/appointment'));
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

const ROLES = { USER: 'user', DOCTOR: 'doctor', ADMIN: 'admin', MARKETING: 'marketing', COMMISSION_DOCTOR: 'commission_doctor', RECEPTIONIST: 'receptionist' };
const VALID_APPOINTMENT_STATUSES = ['Booked', 'Completed', 'Cancelled'];

const PERMISSIONS = {
    user: { dashboard: true, viewDoctors: true, viewAppointments: true, createAppointments: true },
    doctor: { doctorDashboard: true, viewAppointments: true },
    admin: { adminPanel: true, manageUsers: true, manageDoctors: true, manageAppointments: true, manageMarketing: true, manageReceptionists: true },
    marketing: { marketingDashboard: true, viewDoctors: true, viewAppointments: true, createAppointments: true, cancelAppointments: true, changeOwnPassword: true },
    commission_doctor: { marketingDashboard: true, viewDoctors: true, viewAppointments: true, createAppointments: true, cancelAppointments: true },
    receptionist: { receptionistDashboard: true, viewDoctors: true, viewAppointments: true, createAppointments: true, cancelAppointments: true }
};

let appState = {
    currentUser: null,
    currentView: 'auth',
    authToken: localStorage.getItem(STORAGE_API_TOKEN),
    users: [],
    doctors: [],
    appointments: [],
    pendingStatusChange: null
};

let authState = {
    mode: 'login',
    pendingRegistration: null,
    pendingReset: null
};

// PDF preview/download removed

let paginationState = {
    myApp: { skip: 0, limit: 10, total: 0, page: 1 },
    adminApp: { skip: 0, limit: 10, total: 0, page: 1 },
    todaySerials: { skip: 0, limit: 10, total: 0, page: 1 }
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

function toggleSidebar() {
    const sidebar = getEl('main-sidebar');
    const overlay = getEl('sidebar-overlay');
    if (!sidebar) return;
    sidebar.classList.toggle('open');
    if (overlay) overlay.classList.toggle('active');
}

function toggleSidebarCollapse() {
    const sidebar = getEl('main-sidebar');
    if (!sidebar) return;
    const isCollapsed = sidebar.classList.toggle('collapsed');
    localStorage.setItem('sidebar_collapsed', isCollapsed ? '1' : '0');
}

function restoreSidebarState() {
    const sidebar = getEl('main-sidebar');
    if (!sidebar) return;
    if (window.innerWidth > 720 && localStorage.getItem('sidebar_collapsed') === '1') {
        sidebar.classList.add('collapsed');
    }
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
        commission_doctor: 'Commission Doctor',
        receptionist: 'Receptionist'
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

const BN_DIGIT_MAP = { '0':'০','1':'১','2':'২','3':'৩','4':'৪','5':'৫','6':'৬','7':'৭','8':'৮','9':'৯' };
const BN_DAY_SHORT = {
    Monday: 'সোম', Tuesday: 'মঙ্গল', Wednesday: 'বুধ', Thursday: 'বৃহঃ',
    Friday: 'শুক্র', Saturday: 'শনি', Sunday: 'রবি'
};

function toBnDigits(value) {
    return String(value ?? '').replace(/[0-9]/g, d => BN_DIGIT_MAP[d]);
}

function bnPeriod(hour24) {
    if (hour24 >= 4 && hour24 < 6) return 'ভোর';
    if (hour24 >= 6 && hour24 < 12) return 'সকাল';
    if (hour24 >= 12 && hour24 < 15) return 'দুপুর';
    if (hour24 >= 15 && hour24 < 18) return 'বিকাল';
    if (hour24 >= 18 && hour24 < 20) return 'সন্ধ্যা';
    return 'রাত';
}

function formatTimeBn(value) {
    const minutes = timeToMinutes(value);
    if (minutes === null) return '';
    const hour24 = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const hour12 = (hour24 % 12) || 12;
    const period = bnPeriod(hour24);
    return minute
        ? `${period} ${toBnDigits(hour12)}টা ${toBnDigits(minute)} মিনিট`
        : `${period} ${toBnDigits(hour12)}টা`;
}

function formatScheduleEntriesLabel(entries) {
    const normalized = normalizeScheduleEntries(entries);
    if (!normalized.length) return 'সময়সূচি নির্ধারিত নেই';
    return normalized
        .map(item => `${BN_DAY_SHORT[item.day] || item.day.slice(0, 3)} ${formatTimeBn(item.startTime)} - ${formatTimeBn(item.endTime)}`)
        .join(', ');
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

// appointmentPdfFileName removed

// PDF-related functions removed

function showAppointmentSuccess(app) {
    setText('success-patient-name', app.patientName);
    setText('success-patient-number', app.patientPhone);
    setText('success-doctor-name', app.docName);
    setText('success-date', formatDateLike(app.date, app.time));
    setText('success-serial', app.serial_number ? `#${app.serial_number}` : '-');
    getEl('appointment-success-modal')?.classList.add('active');
}

function formatDateLike(dateStr, timeStr) {
    if (!dateStr) return '-';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const day = parseInt(parts[2], 10);
    const month = months[parseInt(parts[1], 10) - 1] || parts[1];
    const year = parts[0];
    let result = `${day} ${month} ${year}`;
    if (timeStr) {
        const mins = timeToMinutes(timeStr);
        if (mins !== null) {
            const hours = Math.floor(mins / 60);
            const minutes = mins % 60;
            const period = hours >= 12 ? 'pm' : 'am';
            const displayHours = hours === 0 ? 12 : (hours > 12 ? hours - 12 : hours);
            result += ` at ${String(displayHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${period}`;
        }
    }
    return result;
}

function closeSuccessModal() {
    closeModal('appointment-success-modal');
    navigate('appointments');
}

// PDF actions removed

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
    return ((list && list.items) || list || []).map(app => {
        const minutes = timeToMinutes(app.time);
        return {
            ...app,
            id: Number(app.id),
            docId: Number(app.docId),
            time: minutes === null ? app.time : minutesToTimeValue(minutes),
            status: VALID_APPOINTMENT_STATUSES.includes(app.status) ? app.status : 'Booked',
            reason: app.reason || '',
            patientAge: app.patientAge ?? null,
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
        case 'receptionist-dashboard': return role === ROLES.RECEPTIONIST;
        case 'admin': return role === ROLES.ADMIN;
        case 'doctors': return role === ROLES.USER || role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR || role === ROLES.RECEPTIONIST;
        case 'appointments': return role === ROLES.USER || role === ROLES.DOCTOR || role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR || role === ROLES.RECEPTIONIST;
        default: return false;
    }
}

function defaultViewFor(user) {
    const role = getRole(user);
    if (role === ROLES.ADMIN) return 'admin';
    if (role === ROLES.DOCTOR) return 'doctor-dashboard';
    if (role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR) return 'marketing-dashboard';
    if (role === ROLES.RECEPTIONIST) return 'receptionist-dashboard';
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
    ['auth-view', 'dashboard-view', 'doctor-dashboard-view', 'marketing-dashboard-view', 'receptionist-dashboard-view', 'doctors-view', 'appointments-view', 'admin-view']
        .forEach(v => getEl(v)?.classList.add('hidden'));
    getEl(`${view}-view`)?.classList.remove('hidden');

    // Close mobile sidebar
    const overlay = getEl('sidebar-overlay');
    const hamburger = getEl('mobile-hamburger');
    if (overlay) overlay.classList.remove('active');

    const sidebar = getEl('main-sidebar');
    const topNav = getEl('top-navbar');
    if (view === 'auth') {
        sidebar?.classList.add('hidden');
        sidebar?.classList.remove('open');
        topNav?.classList.add('hidden');
        if (hamburger) hamburger.classList.add('hidden');
    } else {
        sidebar?.classList.remove('hidden');
        topNav?.classList.remove('hidden');
        updateSidebar();
        if (window.innerWidth > 720) {
            restoreSidebarState();
            if (hamburger) hamburger.classList.add('hidden');
        } else {
            sidebar.classList.remove('open');
            if (hamburger) hamburger.classList.remove('hidden');
        }
    }

    if (view === 'dashboard') initDashboard();
    if (view === 'doctor-dashboard') initDoctorDashboard();
    if (view === 'marketing-dashboard') initMarketingDashboard();
    if (view === 'receptionist-dashboard') initReceptionistDashboard();
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

function updateSidebar() {
    if (!appState.currentUser) return;
    const role = getRole(appState.currentUser);
    setText('navbar-user-name', `${appState.currentUser.name}`);
    setText('navbar-role-badge', roleLabel(role));
    buildSidebarNav(role);
}

function buildSidebarNav(role) {
    const nav = getEl('sidebar-nav');
    if (!nav) return;
    const navItems = [];

    if (role === ROLES.ADMIN) {
        navItems.push({ type: 'label', text: 'Admin Panel' });
        navItems.push({ type: 'item', id: 'admin-users', text: 'Manage Users', icon: '#users-icon' });
        navItems.push({ type: 'item', id: 'admin-doctors', text: 'Manage Doctors', icon: '#doctor-icon' });
        navItems.push({ type: 'item', id: 'admin-marketing', text: 'Marketing Officers', icon: '#marketing-icon' });
        navItems.push({ type: 'item', id: 'admin-receptionists', text: 'Receptionists', icon: '#receptionist-icon' });
        navItems.push({ type: 'item', id: 'admin-appointments', text: 'All Appointments', icon: '#appointments-icon' });
        navItems.push({ type: 'item', id: 'admin-today-serials', text: "Today's Serials", icon: '#serials-icon' });
        navItems.push({ type: 'item', id: 'admin-notices', text: 'Notices', icon: '#notices-icon' });
        navItems.push({ type: 'item', id: 'admin-categories', text: 'Categories', icon: '#categories-icon' });
    }

    if (role === ROLES.USER) {
        navItems.push({ type: 'label', text: 'Patient' });
        navItems.push({ type: 'item', id: 'dashboard', text: 'Dashboard', icon: '#dashboard-icon' });
    }

    if (role === ROLES.DOCTOR) {
        navItems.push({ type: 'label', text: 'Doctor' });
        navItems.push({ type: 'item', id: 'doctor-dashboard', text: 'Doctor Dashboard', icon: '#doctor-icon' });
    }

    if (role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR) {
        navItems.push({ type: 'label', text: 'Marketing' });
        navItems.push({ type: 'item', id: 'marketing-dashboard', text: 'Marketing Dashboard', icon: '#marketing-icon' });
    }

    if (role === ROLES.RECEPTIONIST) {
        navItems.push({ type: 'label', text: 'Reception' });
        navItems.push({ type: 'item', id: 'receptionist-dashboard', text: 'Reception Dashboard', icon: '#receptionist-icon' });
    }

    if (role === ROLES.USER || role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR || role === ROLES.RECEPTIONIST) {
        navItems.push({ type: 'label', text: 'General' });
        navItems.push({ type: 'item', id: 'doctors', text: 'View Doctors', icon: '#doctor-icon' });
        navItems.push({ type: 'item', id: 'appointments', text: 'My Appointments', icon: '#appointments-icon' });
    }

    nav.innerHTML = navItems.map(item => {
        if (item.type === 'label') {
            return `<div class="sidebar-label">${escapeHTML(item.text)}</div>`;
        }
        return `<div class="sidebar-item" id="tab-${item.id}" onclick="switchSidebarItem('${item.id}')">
            <span class="sidebar-item-icon">${getIconFor(item.icon)}</span>
            <span class="sidebar-item-text">${escapeHTML(item.text)}</span>
        </div>`;
    }).join('');
}

function switchSidebarItem(id) {
    if (id === 'dashboard') { navigateSafe('dashboard'); initDashboard(); return; }
    if (id === 'doctor-dashboard') { navigateSafe('doctor-dashboard'); initDoctorDashboard(); return; }
    if (id === 'marketing-dashboard') { navigateSafe('marketing-dashboard'); initMarketingDashboard(); return; }
    if (id === 'receptionist-dashboard') { navigateSafe('receptionist-dashboard'); initReceptionistDashboard(); return; }
    if (id === 'doctors') { navigateSafe('doctors'); renderDoctors(); return; }
    if (id === 'appointments') { navigateSafe('appointments'); paginationState.myApp.skip = 0; renderAppointments(); return; }
    switchAdminTab(id);
    // Close sidebar on mobile
    if (window.innerWidth <= 720) toggleSidebar();
}

function getIconFor(type) {
    const icons = {
        '#users-icon': '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
        '#doctor-icon': '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.3.3 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/></svg>',
        '#marketing-icon': '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-5v12L3 13Z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>',
        '#receptionist-icon': '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
        '#appointments-icon': '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>',
        '#serials-icon': '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
        '#notices-icon': '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
        '#categories-icon': '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6v6H4z"></path><path d="M14 4h6v6h-6z"></path><path d="M4 14h6v6H4z"></path><path d="M14 14h6v6h-6z"></path></svg>',
        '#dashboard-icon': '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    };
    return icons[type] || '';
}

// --- Bulk selection for tables ---
const bulkState = {};

function getBulkState(tableId) {
    if (!bulkState[tableId]) bulkState[tableId] = new Set();
    return bulkState[tableId];
}

function toggleSelectAll(tableId) {
    const tbody = getEl(tableId);
    if (!tbody) return;
    const checkboxes = tbody.querySelectorAll('input[type="checkbox"]');
    const tableEl = tbody.closest('table');
    const masterCb = tableEl?.querySelector('thead input[type="checkbox"]');
    const isChecked = masterCb?.checked ?? false;

    const state = getBulkState(tableId);
    state.clear();

    checkboxes.forEach(cb => {
        cb.checked = isChecked;
        const tr = cb.closest('tr');
        if (isChecked && cb.value) {
            state.add(cb.value);
            tr?.classList.add('selected');
        } else {
            tr?.classList.remove('selected');
        }
    });

    updateBulkToolbar(tableId);
}

function toggleRowSelect(tableId, el) {
    const state = getBulkState(tableId);
    const id = el.value;
    const tr = el.closest('tr');

    if (el.checked) {
        state.add(id);
        tr?.classList.add('selected');
    } else {
        state.delete(id);
        tr?.classList.remove('selected');
        const tableEl = tr?.closest('table');
        const masterCb = tableEl?.querySelector('thead input[type="checkbox"]');
        if (masterCb) masterCb.checked = false;
    }

    updateBulkToolbar(tableId);
}

function updateBulkToolbar(tableId) {
    const state = getBulkState(tableId);
    const count = state.size;
    const toolbar = getEl('bulk-toolbar-' + tableId);
    if (!toolbar) return;

    if (count > 0) {
        toolbar.classList.remove('hidden');
        const countEl = toolbar.querySelector('.bulk-count-num');
        if (countEl) countEl.textContent = count;
        const actionBtns = toolbar.querySelectorAll('.bulk-actions button, .bulk-actions a');
        actionBtns.forEach(b => b.disabled = false);
    } else {
        toolbar.classList.add('hidden');
        const actionBtns = toolbar.querySelectorAll('.bulk-actions button, .bulk-actions a');
        actionBtns.forEach(b => b.disabled = true);
    }
}

function clearBulkSelection(tableId) {
    const state = getBulkState(tableId);
    state.clear();
    const tbody = getEl(tableId);
    if (tbody) {
        tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
            cb.closest('tr')?.classList.remove('selected');
        });
        const tableEl = tbody.closest('table');
        const masterCb = tableEl?.querySelector('thead input[type="checkbox"]');
        if (masterCb) masterCb.checked = false;
    }
    updateBulkToolbar(tableId);
}

const bulkDeleteConfig = {
    'admin-user-list': { path: '/users', idKey: 'id', label: 'patient', needsUserRefresh: true },
    'admin-marketing-list': { path: '/marketing-officers', idKey: 'id', label: 'marketing officer', needsUserRefresh: true },
    'admin-receptionist-list': { path: '/receptionists', idKey: 'id', label: 'receptionist', needsUserRefresh: true },
    'admin-doctor-list': { path: '/doctors', idKey: 'id', label: 'doctor', needsUserRefresh: true },
    'admin-all-appointments-list': { path: '/appointments', idKey: 'id', label: 'appointment', needsUserRefresh: false },
    'admin-today-serials-list': { path: '/appointments', idKey: 'id', label: 'serial', needsUserRefresh: false },
    'admin-notice-list': { path: '/notices', idKey: 'id', label: 'notice', needsUserRefresh: false },
    'admin-category-list': { path: '/categories', idKey: 'id', label: 'category', needsUserRefresh: false },
};

async function bulkDeleteSelected(tableId) {
    const state = getBulkState(tableId);
    if (state.size === 0) return;

    const cfg = bulkDeleteConfig[tableId];
    const label = cfg?.label || 'item';
    if (!confirm(`Delete ${state.size} selected ${label}${state.size > 1 ? 's' : ''}? This action cannot be undone.`)) return;

    const ids = [...state];
    let successCount = 0;
    let failCount = 0;

    for (const id of ids) {
        try {
            await apiRequest(`${cfg.path}/${encodeURIComponent(id)}`, { method: 'DELETE' });
            successCount++;
        } catch (e) {
            failCount++;
        }
    }

    if (successCount > 0 && cfg.needsUserRefresh) {
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
    }
    if (successCount > 0 && tableId === 'admin-notice-list') {
        adminNoticesCache = [];
    }
    if (successCount > 0 && tableId === 'admin-category-list') {
        await loadAdminCategories();
        populateCategoryDropdown();
    }

    state.clear();

    const renderMap = {
        'admin-user-list': renderAdminUsers,
        'admin-marketing-list': renderAdminMarketing,
        'admin-receptionist-list': renderAdminReceptionists,
        'admin-doctor-list': renderAdminDoctors,
        'admin-all-appointments-list': () => renderAdminAppointments(),
        'admin-today-serials-list': () => renderAdminTodaySerials(),
        'admin-notice-list': renderAdminNotices,
        'admin-category-list': renderAdminCategories,
    };
    const renderFn = renderMap[tableId];
    if (renderFn) renderFn();

    updateBulkToolbar(tableId);

    const msg = failCount > 0
        ? `Deleted ${successCount} ${label}${successCount > 1 ? 's' : ''}. ${failCount} failed.`
        : `Deleted ${successCount} ${label}${successCount > 1 ? 's' : ''}.`;
    showToast(msg, failCount > 0 ? 'warning' : 'success');
}

function bulkExportTable(tableId) {
    const state = getBulkState(tableId);
    const tbody = getEl(tableId);
    if (!tbody) return;

    const exportMap = {
        'admin-user-list': exportUsersCSV,
        'admin-marketing-list': exportMarketingCSV,
        'admin-receptionist-list': exportReceptionistsCSV,
        'admin-doctor-list': exportDoctorsCSV,
        'admin-all-appointments-list': (items) => {
            const data = collectAppointmentRows(items);
            if (data.length) exportToCSV(data, todayISO() + '_Selected_Appointments.csv');
        },
        'admin-today-serials-list': (items) => {
            const data = collectAppointmentRows(items);
            if (data.length) exportToCSV(data, todayISO() + '_Selected_Serials.csv');
        },
        'appointments-list': (items) => {
            const data = collectAppointmentRows(items);
            if (data.length) exportToCSV(data, todayISO() + '_Appointments.csv');
        },
        'admin-notice-list': exportNoticesCSV,
        'admin-category-list': exportCategoriesCSV,
    };

    const fn = exportMap[tableId];
    if (fn) fn(state.size > 0 ? [...state] : null);
}

function collectAppointmentRows(selectedIds) {
    if (!appState.appointments || !appState.appointments.length) return [];
    if (!selectedIds || !selectedIds.length) return appState.appointments;
    return appState.appointments.filter(a => selectedIds.includes(String(a.id)));
}

// --- Per-table CSV exports ---
function exportUsersCSV(selectedIds) {
    let data = appState.users.filter(u => getRole(u) === ROLES.USER);
    if (selectedIds && selectedIds.length) data = data.filter(u => selectedIds.includes(u.id));
    if (!data.length) { showToast('No data to export', 'error'); return; }

    const headers = ['Name', 'Phone', 'Age', 'Gender', 'Email'];
    const rows = [headers.join(',')];
    data.forEach(u => {
        rows.push([
            `"${(u.name || '').replace(/"/g, '""')}"`,
            u.phone || '',
            u.age ?? '',
            u.gender || '',
            u.email || ''
        ].join(','));
    });
    downloadCSV(rows.join('\n'), todayISO() + '_Patients.csv');
}

function exportMarketingCSV(selectedIds) {
    let data = appState.users.filter(u => getRole(u) === ROLES.MARKETING);
    if (selectedIds && selectedIds.length) data = data.filter(u => selectedIds.includes(u.id));
    if (!data.length) { showToast('No data to export', 'error'); return; }

    const headers = ['Name', 'Phone', 'Email', 'Role'];
    const rows = [headers.join(',')];
    data.forEach(u => {
        rows.push([
            `"${(u.name || '').replace(/"/g, '""')}"`,
            u.phone || '',
            u.email || '',
            'Marketing Officer'
        ].join(','));
    });
    downloadCSV(rows.join('\n'), todayISO() + '_Marketing_Officers.csv');
}

function exportReceptionistsCSV(selectedIds) {
    let data = appState.users.filter(u => getRole(u) === ROLES.RECEPTIONIST);
    if (selectedIds && selectedIds.length) data = data.filter(u => selectedIds.includes(u.id));
    if (!data.length) { showToast('No data to export', 'error'); return; }

    const headers = ['Name', 'Phone', 'Email', 'Role'];
    const rows = [headers.join(',')];
    data.forEach(u => {
        rows.push([
            `"${(u.name || '').replace(/"/g, '""')}"`,
            u.phone || '',
            u.email || '',
            'Receptionist'
        ].join(','));
    });
    downloadCSV(rows.join('\n'), todayISO() + '_Receptionists.csv');
}

function exportDoctorsCSV(selectedIds) {
    let data = appState.doctors;
    if (selectedIds && selectedIds.length) data = data.filter(d => selectedIds.includes(String(d.id)));
    if (!data.length) { showToast('No data to export', 'error'); return; }

    const headers = ['Name', 'Phone', 'Category', 'Room', 'Schedule', 'Status'];
    const rows = [headers.join(',')];
    data.forEach(d => {
        rows.push([
            `"${(d.name || '').replace(/"/g, '""')}"`,
            d.phone || '',
            `"${(d.categoryLabel || '').replace(/"/g, '""')}"`,
            d.room || '',
            `"${(d.workingScheduleLabel || '').replace(/"/g, '""')}"`,
            d.is_available ? 'Available' : 'Unavailable'
        ].join(','));
    });
    downloadCSV(rows.join('\n'), todayISO() + '_Doctors.csv');
}

function exportNoticesCSV(selectedIds) {
    let data = adminNoticesCache;
    if (selectedIds && selectedIds.length) data = data.filter(n => selectedIds.includes(String(n.id)));
    if (!data.length) { showToast('No data to export', 'error'); return; }

    const headers = ['Title', 'Content', 'Status', 'Created At'];
    const rows = [headers.join(',')];
    data.forEach(n => {
        rows.push([
            `"${(n.title || '').replace(/"/g, '""')}"`,
            `"${(n.content || '').replace(/"/g, '""')}"`,
            n.is_active ? 'Active' : 'Inactive',
            n.created_at || '-'
        ].join(','));
    });
    downloadCSV(rows.join('\n'), todayISO() + '_Notices.csv');
}

function exportCategoriesCSV(selectedIds) {
    let data = adminCategories;
    if (selectedIds && selectedIds.length) data = data.filter(c => selectedIds.includes(String(c.id)));
    if (!data.length) { showToast('No data to export', 'error'); return; }

    const headers = ['ID', 'Name'];
    const rows = [headers.join(',')];
    data.forEach(c => {
        rows.push([
            c.id,
            `"${(c.name || '').replace(/"/g, '""')}"`
        ].join(','));
    });
    downloadCSV(rows.join('\n'), todayISO() + '_Categories.csv');
}

function downloadCSV(content, filename) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
    const email = getEl('reg-email').value.trim();

    if (name.length < 2 || !age || age < 1 || age > 120 || !gender) {
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
    
    // Fetch and display active notices
    const noticesEl = getEl('dash-notices');
    const bannerInner = getEl('notice-banner-inner');
    fetch(window.NSGH_API_BASE + '/public/notices')
        .then(res => res.json())
        .then(notices => {
            if (notices && notices.length) {
                bannerInner.innerHTML = notices.map(n => `<div class="notice-banner-item" title="${escapeHTML(n.title)}: ${escapeHTML(n.content)}"><strong>${escapeHTML(n.title)}</strong><span>${escapeHTML(n.content)}</span></div>`).join('');
                noticesEl.classList.remove('hidden');
            }
        })
        .catch(() => {});
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

function initReceptionistDashboard() {
    const u = appState.currentUser;
    setText('recep-dash-name', u.name);
    setText('recep-dash-phone', u.phone);
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

    const rc = getEl('doctors-result-count');
    if (rc) rc.textContent = filtered.length ? `Showing ${filtered.length} doctor${filtered.length !== 1 ? 's' : ''}` : '';

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
    return lines.map(line => `<div class="row-subtle">${escapeHTML(line)}</div>`).join('');
}

function canCancelSerial(app) {
    const role = getRole(appState.currentUser);
    if (app.status !== 'Booked' || isPastAppointment(app)) return false;
    if (role === ROLES.MARKETING) return app.marketingOfficerId === appState.currentUser.id || app.bookedById === appState.currentUser.id;
    if (role === ROLES.COMMISSION_DOCTOR) return app.commissionDoctorId === appState.currentUser.id || app.bookedById === appState.currentUser.id;
    if (role === ROLES.RECEPTIONIST) return app.bookedById === appState.currentUser.id;
    return false;
}

function handlePaginationAction(action, pagState) {
    if (action === 'first') pagState.skip = 0;
    else if (action === 'last') pagState.skip = Math.max(0, (Math.ceil(pagState.total / pagState.limit) - 1) * pagState.limit);
    else if (action === 'next') pagState.skip = Math.min(pagState.skip + pagState.limit, Math.max(0, pagState.total - pagState.limit));
    else if (action === 'prev') pagState.skip = Math.max(0, pagState.skip - pagState.limit);
    else if (typeof action === 'number') pagState.skip = (action - 1) * pagState.limit;
}

function renderPaginationControls(containerId, pagState, callbackName, pagKey) {
    const container = getEl(containerId);
    if (!container) return;

    const totalPages = Math.max(1, Math.ceil(pagState.total / pagState.limit));
    const currentPage = Math.floor(pagState.skip / pagState.limit) + 1;

    if (totalPages <= 1 && pagState.total === 0) {
        container.innerHTML = '';
        return;
    }

    const maxVisible = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage + 1 < maxVisible) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }

    const startResult = pagState.total === 0 ? 0 : pagState.skip + 1;
    const endResult = Math.min(pagState.skip + pagState.limit, pagState.total);

    let html = '<div class="pagination-controls">';

    html += `<div class="pagination-top">`;
    html += `<span class="result-summary">Showing ${startResult}–${endResult} of ${pagState.total} results</span>`;
    if (pagKey) {
        html += `<span class="page-size-selector"><label>Rows per page:</label> <select onchange="changePageSize('${pagKey}', this.value)">
            <option value="10" ${pagState.limit === 10 ? 'selected' : ''}>10</option>
            <option value="25" ${pagState.limit === 25 ? 'selected' : ''}>25</option>
            <option value="50" ${pagState.limit === 50 ? 'selected' : ''}>50</option>
            <option value="100" ${pagState.limit === 100 ? 'selected' : ''}>100</option>
        </select></span>`;
    }
    html += `</div>`;

    html += `<div class="pagination-nav">`;
    html += `<button class="page-btn" onclick="${callbackName}('first')" ${currentPage === 1 ? 'disabled' : ''} title="First Page">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>
    </button>`;
    html += `<button class="page-btn" onclick="${callbackName}('prev')" ${currentPage === 1 ? 'disabled' : ''} title="Previous">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
    </button>`;

    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="${callbackName}(${i})">${i}</button>`;
    }

    html += `<button class="page-btn" onclick="${callbackName}('next')" ${currentPage === totalPages ? 'disabled' : ''} title="Next">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </button>`;
    html += `<button class="page-btn" onclick="${callbackName}('last')" ${currentPage === totalPages ? 'disabled' : ''} title="Last Page">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
    </button>`;
    html += `<span class="page-info">Page ${currentPage} of ${totalPages}</span>`;
    html += `</div>`;
    html += '</div>';

    container.innerHTML = html;
}

function changePageSize(pagKey, newLimit) {
    const pagState = paginationState[pagKey];
    if (!pagState) return;
    pagState.limit = parseInt(newLimit, 10);
    pagState.skip = 0;
    if (pagKey === 'myApp') renderAppointments();
    else if (pagKey === 'adminApp') renderAdminAppointments();
    else if (pagKey === 'todaySerials') renderAdminTodaySerials();
}

async function renderAppointments(action = null) {
    if (action !== null && action !== 'reset') handlePaginationAction(action, paginationState.myApp);
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
    } else if (role === ROLES.RECEPTIONIST) {
        setText('appointments-heading', 'Serial List');
        setText('appointments-th-1', 'Patient / Source');
        getEl('appointments-back-btn').setAttribute('onclick', "navigate('receptionist-dashboard')");
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

    listEl.innerHTML = '<tr><td colspan="7" class="text-center">Loading...</td></tr>';
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
        paginationState.myApp.total = rawData.total || 0;
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

        const selected = getBulkState('appointments-list');
        listEl.innerHTML = sortAppointments(myApps).map(app => {
        const canCancel = canCancelSerial(app);
        const firstCol = role === ROLES.DOCTOR
            ? `<strong>${escapeHTML(app.patientName)}</strong><div class="row-subtle">${escapeHTML(app.patientPhone)}</div>${appointmentPatientDetailsMeta(app)}${appointmentSourceMeta(app)}${app.reason ? `<div class="row-note">${escapeHTML(app.reason)}</div>` : ''}`
            : (role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR || role === ROLES.RECEPTIONIST)
                ? `<strong>${escapeHTML(app.patientName)}</strong><div class="row-subtle">${escapeHTML(app.patientPhone)}</div>${appointmentPatientDetailsMeta(app)}<div class="row-subtle">Doctor: ${escapeHTML(app.docName)}</div>${appointmentSourceMeta(app)}${app.reason ? `<div class="row-note">${escapeHTML(app.reason)}</div>` : ''}`
                : `<strong>${escapeHTML(app.docName)}</strong><div class="row-subtle">Patient: ${escapeHTML(app.patientName)}</div><div class="row-subtle">Number: ${escapeHTML(app.patientPhone)}</div>${appointmentPatientDetailsMeta(app)}${appointmentSourceMeta(app)}${app.reason ? `<div class="row-note">${escapeHTML(app.reason)}</div>` : ''}`;

        const pdfBtn = `<button class="btn btn-outline btn-compact" onclick="viewAppointmentPdf(${Number(app.id)})">View Slip</button>`;
        const actionCol = role === ROLES.DOCTOR
            ? `
                <div class="table-actions">
                    <select class="compact-select" onchange="updateAppointmentStatus(${Number(app.id)}, this.value)">
                        <option value="Booked" ${app.status === 'Booked' ? 'selected' : ''}>Booked</option>
                        <option value="Completed" ${app.status === 'Completed' ? 'selected' : ''}>Completed</option>
                        <option value="Cancelled" ${app.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                    </select>
                    ${pdfBtn}
                </div>
            `
            : `
                <div class="table-actions">
                    ${pdfBtn}
                    ${canCancel
                        ? `<button class="btn btn-outline btn-compact btn-danger-ghost" onclick="cancelAppointment(${Number(app.id)})">Cancel</button>`
                        : ''}
                </div>
            `;

        return `
            <tr${selected.has(String(app.id)) ? ' class="selected"' : ''}>
                <td class="checkbox-col" data-label=""><input type="checkbox" value="${app.id}" ${selected.has(String(app.id)) ? 'checked' : ''} onchange="toggleRowSelect('appointments-list', this)"></td>
                <td data-label="${role === ROLES.DOCTOR || role === ROLES.MARKETING || role === ROLES.COMMISSION_DOCTOR || role === ROLES.RECEPTIONIST ? 'Patient' : 'Doctor'}">${firstCol}</td>
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
        renderPaginationControls('my-app-pagination', paginationState.myApp, 'renderAppointments', 'myApp');
        updateBulkToolbar('appointments-list');
    } catch (e) {
        listEl.innerHTML = '<tr><td colspan="7" class="text-center text-danger">Failed to load appointments</td></tr>';
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
    getEl('booking-patient-name').value = '';
    getEl('booking-patient-age').value = '';
    getEl('booking-patient-phone').value = '';
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
    if (patientPhone && !isValidPhone(patientPhone)) {
        showToast('Enter a valid patient number', 'error');
        return;
    }
    
    // Spam prevention: check for obviously invalid patterns (repeated digits)
    if (patientPhone && /^(0+|1+|2+|3+|4+|5+|6+|7+|8+|9+)$/.test(patientPhone.replace(/\D/g, ''))) {
        showToast('Invalid phone number format. Please enter a real number', 'error');
        return;
    }

    setLoading('btn-confirm-booking', true, 'Booking...');
    try {
        const payload = { docId, date, reason, patientName, patientAge, patientPhone };
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
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not book appointment'), 'error');
    } finally {
        setLoading('btn-confirm-booking', false);
    }
}

async function viewAppointmentPdf(appId) {
    if (!appState.authToken) {
        showToast('Please sign in to view the appointment slip', 'error');
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/appointments/${Number(appId)}/pdf`, {
            headers: { Authorization: `Bearer ${appState.authToken}` }
        });
        if (!response.ok) {
            let detail = 'Could not load appointment slip';
            try { detail = (await response.json())?.detail || detail; } catch {}
            showToast(detail, 'error');
            return;
        }
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, '_blank');
    } catch (error) {
        showToast(error?.message || 'Could not load appointment slip', 'error');
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
        showToast('Appointment cancelled.');
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
    loadAdminCategories().then(populateCategoryDropdown);
    switchAdminTab('admin-users');
}

function switchAdminTab(tabId) {
    if (appState.currentView !== 'admin') {
        navigateSafe('admin');
    }

    // Update sidebar item active states
    document.querySelectorAll('.sidebar-nav .sidebar-item').forEach(el => el.classList.remove('active'));
    const activeTab = getEl(`tab-${tabId}`);
    if (activeTab) activeTab.classList.add('active');

    ['admin-users', 'admin-doctors', 'admin-marketing', 'admin-receptionists', 'admin-appointments', 'admin-today-serials', 'admin-notices', 'admin-categories'].forEach(t => {
        getEl(`${t}-content`)?.classList.add('hidden');
    });
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
    if (tabId === 'admin-notices') renderAdminNotices();
    if (tabId === 'admin-receptionists') renderAdminReceptionists();
    if (tabId === 'admin-categories') renderAdminCategories();
}

function renderAdminUsers() {
    const tbody = getEl('admin-user-list');
    tbody.innerHTML = '';
    const query = (getEl('search-admin-users')?.value || '').trim().toLowerCase();
    const patients = appState.users.filter(u => getRole(u) === ROLES.USER);
    const filtered = query
        ? patients.filter(u =>
            (u.name || '').toLowerCase().includes(query) ||
            (u.phone || '').toLowerCase().includes(query) ||
            (u.email || '').toLowerCase().includes(query) ||
            (u.age || '').toString().includes(query) ||
            (u.gender || '').toLowerCase().includes(query)
          )
        : patients;
    const rc = getEl('admin-users-result-count');
    if (rc) rc.textContent = filtered.length ? `Showing ${filtered.length} patient${filtered.length !== 1 ? 's' : ''}` : '';
    const selected = getBulkState('admin-user-list');
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="color:var(--text-muted)">' + (query ? 'No patients found matching your search.' : 'No patients have registered yet.') + '</td></tr>';
        return;
    }
    tbody.innerHTML = filtered.map(user => `
        <tr${selected.has(user.id) ? ' class="selected"' : ''}>
            <td class="checkbox-col" data-label=""><input type="checkbox" value="${escapeHTML(user.id)}" ${selected.has(user.id) ? 'checked' : ''} onchange="toggleRowSelect('admin-user-list', this)"></td>
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
    updateBulkToolbar('admin-user-list');
}

function filterAdminUsers() { renderAdminUsers(); }

function clearAdminUsersFilters() {
    const input = getEl('search-admin-users');
    if (input) input.value = '';
    renderAdminUsers();
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
                gender: gender || null
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
        showToast('Patient deleted.');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not delete patient'), 'error');
    }
}

// --- Admin marketing officers ---
function renderAdminMarketing() {
    const tbody = getEl('admin-marketing-list');
    if (!tbody) return;
    const query = (getEl('search-admin-marketing')?.value || '').trim().toLowerCase();
    const officers = appState.users.filter(u => getRole(u) === ROLES.MARKETING);
    const filtered = query
        ? officers.filter(u =>
            (u.name || '').toLowerCase().includes(query) ||
            (u.phone || '').toLowerCase().includes(query) ||
            (u.email || '').toLowerCase().includes(query)
          )
        : officers;
    const rc = getEl('admin-marketing-result-count');
    if (rc) rc.textContent = filtered.length ? `Showing ${filtered.length} marketing officer${filtered.length !== 1 ? 's' : ''}` : '';
    const selected = getBulkState('admin-marketing-list');
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="color:var(--text-muted)">' + (query ? 'No marketing officers found matching your search.' : 'No marketing officers yet.') + '</td></tr>';
        return;
    }
    tbody.innerHTML = filtered.map(user => `
            <tr${selected.has(user.id) ? ' class="selected"' : ''}>
                <td class="checkbox-col" data-label=""><input type="checkbox" value="${escapeHTML(user.id)}" ${selected.has(user.id) ? 'checked' : ''} onchange="toggleRowSelect('admin-marketing-list', this)"></td>
                <td data-label="Name"><strong>${escapeHTML(user.name)}</strong></td>
                <td data-label="Phone">${escapeHTML(user.phone)}</td>
                <td data-label="Email">${escapeHTML(user.email || '-')}</td>
                <td data-label="Role"><span class="badge badge-info">Marketing Officer</span></td>
                <td data-label="Actions">
                    <div class="table-actions">
                        <button class="btn btn-outline btn-compact" onclick="editMarketingOfficer('${escapeHTML(user.id)}')">Edit</button>
                        <button class="btn btn-danger btn-compact" onclick="deleteMarketingOfficer('${escapeHTML(user.id)}')">Delete</button>
                    </div>
                </td>
            </tr>
    `).join('');
    updateBulkToolbar('admin-marketing-list');
}

function filterAdminMarketing() { renderAdminMarketing(); }

function clearAdminMarketingFilters() {
    const input = getEl('search-admin-marketing');
    if (input) input.value = '';
    renderAdminMarketing();
}

function editMarketingOfficer(userId) {
    const officer = appState.users.find(u => u.id === userId);
    if (!officer || getRole(officer) !== ROLES.MARKETING) return;
    getEl('edit-marketing-id').value = officer.id;
    getEl('edit-marketing-name').value = officer.name || '';
    getEl('edit-marketing-phone').value = officer.phone || '';
    getEl('edit-marketing-email').value = officer.email || '';
    getEl('admin-edit-marketing-modal')?.classList.add('active');
}

async function saveEditedMarketingOfficer() {
    const userId = getEl('edit-marketing-id').value;
    const officer = appState.users.find(u => u.id === userId);
    if (!officer) return;

    const name = getEl('edit-marketing-name').value.trim();
    const email = getEl('edit-marketing-email').value.trim();

    if (name.length < 2) {
        showToast('Marketing officer name is required', 'error');
        return;
    }
    if (email && !isValidEmail(email)) {
        showToast('Enter a valid email address', 'error');
        return;
    }

    setLoading('btn-save-edited-marketing', true, 'Saving...');
    try {
        await apiRequest(`/marketing-officers/${encodeURIComponent(userId)}`, {
            method: 'PUT',
            body: JSON.stringify({ name, email: email || null })
        });
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        showToast('Marketing officer updated successfully');
        closeModal('admin-edit-marketing-modal');
        renderAdminMarketing();
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not update marketing officer'), 'error');
    } finally {
        setLoading('btn-save-edited-marketing', false);
    }
}

async function deleteMarketingOfficer(userId) {
    const officer = appState.users.find(u => u.id === userId);
    if (!officer || getRole(officer) !== ROLES.MARKETING) return;
    if (!confirm(`Delete marketing officer "${officer.name}"? Linked serials will keep their history but lose this officer reference.`)) return;

    try {
        await apiRequest(`/marketing-officers/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        renderAdminMarketing();
        showToast('Marketing officer deleted.');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not delete marketing officer'), 'error');
    }
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

// --- Admin receptionists ---
function renderAdminReceptionists() {
    const tbody = getEl('admin-receptionist-list');
    if (!tbody) return;
    const query = (getEl('search-admin-receptionists')?.value || '').trim().toLowerCase();
    const receptionists = appState.users.filter(u => getRole(u) === ROLES.RECEPTIONIST);
    const filtered = query
        ? receptionists.filter(u =>
            (u.name || '').toLowerCase().includes(query) ||
            (u.phone || '').toLowerCase().includes(query) ||
            (u.email || '').toLowerCase().includes(query)
          )
        : receptionists;
    const rc = getEl('admin-receptionists-result-count');
    if (rc) rc.textContent = filtered.length ? `Showing ${filtered.length} receptionist${filtered.length !== 1 ? 's' : ''}` : '';
    const selected = getBulkState('admin-receptionist-list');
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="color:var(--text-muted)">' + (query ? 'No receptionists found matching your search.' : 'No receptionists yet.') + '</td></tr>';
        return;
    }
    tbody.innerHTML = filtered.map(user => `
            <tr${selected.has(user.id) ? ' class="selected"' : ''}>
                <td class="checkbox-col" data-label=""><input type="checkbox" value="${escapeHTML(user.id)}" ${selected.has(user.id) ? 'checked' : ''} onchange="toggleRowSelect('admin-receptionist-list', this)"></td>
                <td data-label="Name"><strong>${escapeHTML(user.name)}</strong></td>
                <td data-label="Phone">${escapeHTML(user.phone)}</td>
                <td data-label="Email">${escapeHTML(user.email || '-')}</td>
                <td data-label="Role"><span class="badge badge-info">Receptionist</span></td>
                <td data-label="Actions">
                    <div class="table-actions">
                        <button class="btn btn-outline btn-compact" onclick="editReceptionist('${escapeHTML(user.id)}')">Edit</button>
                        <button class="btn btn-danger btn-compact" onclick="deleteReceptionist('${escapeHTML(user.id)}')">Delete</button>
                    </div>
                </td>
            </tr>
    `).join('');
    updateBulkToolbar('admin-receptionist-list');
}

function filterAdminReceptionists() { renderAdminReceptionists(); }

function clearAdminReceptionistsFilters() {
    const input = getEl('search-admin-receptionists');
    if (input) input.value = '';
    renderAdminReceptionists();
}

function editReceptionist(userId) {
    const officer = appState.users.find(u => u.id === userId);
    if (!officer || getRole(officer) !== ROLES.RECEPTIONIST) return;
    getEl('edit-receptionist-id').value = officer.id;
    getEl('edit-receptionist-name').value = officer.name || '';
    getEl('edit-receptionist-phone').value = officer.phone || '';
    getEl('edit-receptionist-email').value = officer.email || '';
    getEl('admin-edit-receptionist-modal')?.classList.add('active');
}

async function saveEditedReceptionist() {
    const userId = getEl('edit-receptionist-id').value;
    const officer = appState.users.find(u => u.id === userId);
    if (!officer) return;

    const name = getEl('edit-receptionist-name').value.trim();
    const email = getEl('edit-receptionist-email').value.trim();

    if (name.length < 2) {
        showToast('Receptionist name is required', 'error');
        return;
    }
    if (email && !isValidEmail(email)) {
        showToast('Enter a valid email address', 'error');
        return;
    }

    setLoading('btn-save-edited-receptionist', true, 'Saving...');
    try {
        await apiRequest(`/receptionists/${encodeURIComponent(userId)}`, {
            method: 'PUT',
            body: JSON.stringify({ name, email: email || null })
        });
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        showToast('Receptionist updated successfully');
        closeModal('admin-edit-receptionist-modal');
        renderAdminReceptionists();
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect' : (error.message || 'Could not update receptionist'), 'error');
    } finally {
        setLoading('btn-save-edited-receptionist', false);
    }
}

async function deleteReceptionist(userId) {
    const officer = appState.users.find(u => u.id === userId);
    if (!officer || getRole(officer) !== ROLES.RECEPTIONIST) return;
    if (!confirm(`Delete receptionist "${officer.name}"?`)) return;

    try {
        await apiRequest(`/receptionists/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        renderAdminReceptionists();
        showToast('Receptionist deleted.');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect' : (error.message || 'Could not delete receptionist'), 'error');
    }
}

function openAdminReceptionistModal() {
    getEl('admin-receptionist-form')?.reset();
    getEl('admin-receptionist-modal')?.classList.add('active');
}

async function saveReceptionist() {
    const name = getEl('admin-receptionist-name').value.trim();
    const phone = normalizePhone(getEl('admin-receptionist-phone').value);
    const email = getEl('admin-receptionist-email').value.trim();
    const password = getEl('admin-receptionist-password').value;

    if (name.length < 2 || !isValidPhone(phone)) {
        showToast('Enter receptionist name and valid phone', 'error');
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

    setLoading('btn-save-receptionist', true, 'Creating...');
    try {
        await apiRequest('/receptionists', {
            method: 'POST',
            body: JSON.stringify({ name, phone, email: email || null, password, specialty: 'Receptionist' })
        });
        await refreshDataFromApi();
        appState.currentUser = appState.users.find(u => u.id === appState.currentUser.id) || appState.currentUser;
        persistSession();
        closeModal('admin-receptionist-modal');
        renderAdminReceptionists();
        showToast('Receptionist ID created');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect' : (error.message || 'Could not create receptionist'), 'error');
    } finally {
        setLoading('btn-save-receptionist', false);
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
    const query = (getEl('search-admin-doctors')?.value || '').trim().toLowerCase();
    const categoryFilter = getEl('filter-admin-doctors-category')?.value || '';
    const statusFilter = getEl('filter-admin-doctors-status')?.value || '';
    let filtered = appState.doctors;
    if (query) {
        filtered = filtered.filter(d =>
            (d.name || '').toLowerCase().includes(query) ||
            (d.phone || '').toLowerCase().includes(query) ||
            (d.categoryLabel || '').toLowerCase().includes(query) ||
            (d.room || '').toLowerCase().includes(query)
        );
    }
    if (categoryFilter) {
        filtered = filtered.filter(d =>
            Array.isArray(d.category) ? d.category.includes(categoryFilter) : d.category === categoryFilter
        );
    }
    if (statusFilter === 'available') filtered = filtered.filter(d => d.is_available);
    else if (statusFilter === 'unavailable') filtered = filtered.filter(d => !d.is_available);
    const rc = getEl('admin-doctors-result-count');
    if (rc) rc.textContent = filtered.length ? `Showing ${filtered.length} doctor${filtered.length !== 1 ? 's' : ''}` : '';
    const selected = getBulkState('admin-doctor-list');
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="color:var(--text-muted)">' + (query || categoryFilter || statusFilter ? 'No doctors found matching your filters.' : 'No doctors yet. Click "+ Add Doctor".') + '</td></tr>';
        return;
    }
    tbody.innerHTML = filtered.map(doc => {
        const statusLabel = doc.is_available ? '<span class="badge badge-success">Available</span>' : '<span class="badge badge-warning">Unavailable</span>';
        return `
        <tr${selected.has(String(doc.id)) ? ' class="selected"' : ''}>
            <td class="checkbox-col" data-label=""><input type="checkbox" value="${doc.id}" ${selected.has(String(doc.id)) ? 'checked' : ''} onchange="toggleRowSelect('admin-doctor-list', this)"></td>
            <td data-label="Name"><strong>${escapeHTML(doc.name)}</strong></td>
            <td data-label="Phone">${escapeHTML(doc.phone || '-')}</td>
            <td data-label="Category">${escapeHTML(doc.categoryLabel)}</td>
            <td data-label="Working Schedule">${escapeHTML(doc.workingScheduleLabel || 'Schedule not set')}</td>
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
    updateBulkToolbar('admin-doctor-list');
}

function filterAdminDoctors() { renderAdminDoctors(); }

function clearAdminDoctorsFilters() {
    const search = getEl('search-admin-doctors');
    const cat = getEl('filter-admin-doctors-category');
    const status = getEl('filter-admin-doctors-status');
    if (search) search.value = '';
    if (cat) cat.value = '';
    if (status) status.value = '';
    renderAdminDoctors();
}

function openAdminDoctorModal(docId = null) {
    // Ensure time options are available before setting values
    generateTimeOptions('admin-doc-start-time');
    generateTimeOptions('admin-doc-end-time');
    populateCategoryDropdown();
    
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
        showToast('Doctor removed and active appointments cancelled.');
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
    if (action !== null && action !== 'reset') handlePaginationAction(action, paginationState.adminApp);
    else if (action === 'reset') paginationState.adminApp.skip = 0;

    const tbody = getEl('admin-all-appointments-list');
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">Loading...</td></tr>';
    
    try {
        const date = getEl('filter-admin-app-date')?.value || '';
        const status = getEl('filter-admin-app-status')?.value || '';
        const docId = getEl('filter-admin-app-doctor')?.value || '';

        let url = `/appointments?skip=${paginationState.adminApp.skip}&limit=${paginationState.adminApp.limit}`;
        if (date) url += `&date=${date}`;
        if (status) url += `&status=${status}`;
        if (docId) url += `&doctor_id=${docId}`;

        const rawData = await apiRequest(url);
        paginationState.adminApp.total = rawData.total || 0;
        const data = normalizeAppointments(rawData);
        appState.appointments = data;

        if (data.length === 0 && paginationState.adminApp.skip === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="color:var(--text-muted)">No appointments found.</td></tr>';
            getEl('admin-app-pagination').innerHTML = '';
            return;
        }
        
        const selected = getBulkState('admin-all-appointments-list');
        const sorted = sortAppointments(data);
        tbody.innerHTML = sorted.map(app => `
        <tr${selected.has(String(app.id)) ? ' class="selected"' : ''}>
            <td class="checkbox-col" data-label=""><input type="checkbox" value="${app.id}" ${selected.has(String(app.id)) ? 'checked' : ''} onchange="toggleRowSelect('admin-all-appointments-list', this)"></td>
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
                    <button class="btn btn-outline btn-compact" onclick="viewAppointmentPdf(${Number(app.id)})">View Slip</button>
                </div>
            </td>
        </tr>
    `).join('');
        renderPaginationControls('admin-app-pagination', paginationState.adminApp, 'renderAdminAppointments', 'adminApp');
        updateBulkToolbar('admin-all-appointments-list');
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Failed to load appointments</td></tr>';
        getEl('admin-app-pagination').innerHTML = '';
    }
}

async function renderAdminTodaySerials(action = null) {
    if (action !== null && action !== 'reset') handlePaginationAction(action, paginationState.todaySerials);
    else if (action === 'reset') paginationState.todaySerials.skip = 0;

    const tbody = getEl('admin-today-serials-list');
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">Loading...</td></tr>';

    try {
        const today = todayISO();
        const status = getEl('filter-admin-today-status')?.value || '';
        const docId = getEl('filter-admin-today-doctor')?.value || '';

        let url = `/appointments?skip=${paginationState.todaySerials.skip}&limit=${paginationState.todaySerials.limit}&date=${today}`;
        if (status) url += `&status=${status}`;
        if (docId) url += `&doctor_id=${docId}`;

        const rawData = await apiRequest(url);
        paginationState.todaySerials.total = rawData.total || 0;
        const data = normalizeAppointments(rawData);
        appState.appointments = data;

        if (data.length === 0 && paginationState.todaySerials.skip === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="color:var(--text-muted)">No serials found for today.</td></tr>';
            getEl('today-serials-pagination').innerHTML = '';
            return;
        }
        
        const selected = getBulkState('admin-today-serials-list');
        const sorted = sortAppointments(data);
        tbody.innerHTML = sorted.map(app => `
        <tr${selected.has(String(app.id)) ? ' class="selected"' : ''}>
            <td class="checkbox-col" data-label=""><input type="checkbox" value="${app.id}" ${selected.has(String(app.id)) ? 'checked' : ''} onchange="toggleRowSelect('admin-today-serials-list', this)"></td>
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
                    <button class="btn btn-outline btn-compact" onclick="viewAppointmentPdf(${Number(app.id)})">View Slip</button>
                </div>
            </td>
        </tr>
    `).join('');
        renderPaginationControls('today-serials-pagination', paginationState.todaySerials, 'renderAdminTodaySerials', 'todaySerials');
        updateBulkToolbar('admin-today-serials-list');
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Failed to load serials</td></tr>';
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
    
    // Store the appointment details for confirmation modal
    appState.pendingStatusChange = {
        appointmentId: Number(id),
        newStatus: newStatus,
        appointment: app
    };
    
    // Show confirmation modal
    getEl('confirm-patient-name').textContent = app.patientName || '-';
    getEl('confirm-doctor-name').textContent = app.docName || '-';
    getEl('confirm-current-status').textContent = app.status || 'Booked';
    getEl('confirm-new-status').textContent = newStatus;
    
    getEl('status-change-modal').classList.add('active');
}

async function confirmStatusChange() {
    const pendingChange = appState.pendingStatusChange;
    if (!pendingChange) return;
    
    // Spam prevention: validate patient phone before status change
    const patientPhone = normalizePhone(pendingChange.appointment.patientPhone || '');
    if (!patientPhone || !isValidPhone(patientPhone)) {
        showToast('Invalid patient number. Cannot send SMS notification', 'error');
        appState.pendingStatusChange = null;
        return;
    }
    
    // Spam prevention: check for obviously invalid patterns (repeated digits)
    if (/^(0+|1+|2+|3+|4+|5+|6+|7+|8+|9+)$/.test(patientPhone.replace(/\D/g, ''))) {
        showToast('Invalid patient number. Cannot send SMS notification', 'error');
        appState.pendingStatusChange = null;
        return;
    }
    
    closeModal('status-change-modal');
    
    try {
        await apiRequest(`/appointments/${pendingChange.appointmentId}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: pendingChange.newStatus })
        });
        
        const appToUpdate = appState.appointments.find(a => a.id === pendingChange.appointmentId);
        if(appToUpdate) appToUpdate.status = pendingChange.newStatus;
        
        if (getEl('appointments-view') && !getEl('appointments-view').classList.contains('hidden')) renderAppointments();
        if (getEl('admin-appointments-content') && !getEl('admin-appointments-content').classList.contains('hidden')) renderAdminAppointments();
        if (getEl('admin-today-serials-content') && !getEl('admin-today-serials-content').classList.contains('hidden')) renderAdminTodaySerials();
        showToast(`Status updated to ${pendingChange.newStatus}`);
        
        // Clear pending change
        appState.pendingStatusChange = null;
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect to the appointment API' : (error.message || 'Could not update status'), 'error');
        if (getEl('appointments-view') && !getEl('appointments-view').classList.contains('hidden')) renderAppointments();
        if (getEl('admin-appointments-content') && !getEl('admin-appointments-content').classList.contains('hidden')) renderAdminAppointments();
        if (getEl('admin-today-serials-content') && !getEl('admin-today-serials-content').classList.contains('hidden')) renderAdminTodaySerials();
        
        // Clear pending change
        appState.pendingStatusChange = null;
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
                if (overlay.id === 'appointment-success-modal') closeSuccessModal();
                else closeModal(overlay.id);
            }
        });
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active').forEach(modal => {
                if (modal.id === 'appointment-success-modal') closeSuccessModal();
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

    const headers = ['Appointment ID', 'Date', 'Time/Serial', 'Patient Name', 'Patient Age', 'Patient Number', 'Doctor', 'Room', 'Status', 'Note', 'Source'];
    const csvRows = [headers.join(',')];

    appointments.forEach(app => {
        const id = formatAppointmentId(app.id);
        const date = app.date || '-';
        const timeSerial = app.serial_number ? `Serial #${app.serial_number}` : (formatTime(app.time) || '-');
        const patientName = `"${(app.patientName || '').replace(/"/g, '""')}"`;
        const patientAge = app.patientAge ?? '-';
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

        csvRows.push([id, date, timeSerial, patientName, patientAge, patientPhone, doctor, room, status, reason, source].join(','));
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

async function downloadSerialsPdf() {
    if (!appState.authToken) {
        showToast('Please sign in', 'error');
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/serials/pdf`, {
            headers: { Authorization: `Bearer ${appState.authToken}` }
        });
        if (!response.ok) {
            let detail = 'Could not generate PDF';
            try { detail = (await response.json())?.detail || detail; } catch {}
            showToast(detail, 'error');
            return;
        }
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, '_blank');
    } catch (error) {
        showToast(error?.message || 'Could not generate PDF', 'error');
    }
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
        exportToCSV(sortAppointments(normalizeAppointments(rawData.items || rawData)), filename);
    } catch(e) {
        showToast('Export failed', 'error');
    }
}

function exportAdminAppointments() { 
    exportAppointmentsHelper(getEl('filter-admin-app-date')?.value, getEl('filter-admin-app-status')?.value, getEl('filter-admin-app-doctor')?.value, todayISO() + '_All_Appointments.csv'); 
}
function exportTodaySerials() { 
    exportAppointmentsHelper(todayISO(), getEl('filter-admin-today-status')?.value, getEl('filter-admin-today-doctor')?.value, todayISO() + '_Serials.csv'); 
}

// --- Admin Notices ---
let adminNoticesCache = [];

function renderAdminNotices() {
    const tbody = getEl('admin-notice-list');
    tbody.innerHTML = '';

    const doRender = (notices) => {
        adminNoticesCache = notices || [];
        const query = (getEl('search-admin-notices')?.value || '').trim().toLowerCase();
        const statusFilter = getEl('filter-admin-notices-status')?.value || '';
        let filtered = adminNoticesCache;
        if (query) {
            filtered = filtered.filter(n =>
                (n.title || '').toLowerCase().includes(query) ||
                (n.content || '').toLowerCase().includes(query)
            );
        }
        if (statusFilter === 'active') filtered = filtered.filter(n => n.is_active);
        else if (statusFilter === 'inactive') filtered = filtered.filter(n => !n.is_active);
        const rc = getEl('admin-notices-result-count');
        if (rc) rc.textContent = filtered.length ? `Showing ${filtered.length} notice${filtered.length !== 1 ? 's' : ''}` : '';
        const selected = getBulkState('admin-notice-list');
        if (!filtered.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="color:var(--text-muted)">' + (query || statusFilter ? 'No notices found matching your filters.' : 'No notices yet.') + '</td></tr>';
            return;
        }
        tbody.innerHTML = filtered.map(n => `
            <tr${selected.has(String(n.id)) ? ' class="selected"' : ''}>
                <td class="checkbox-col" data-label=""><input type="checkbox" value="${n.id}" ${selected.has(String(n.id)) ? 'checked' : ''} onchange="toggleRowSelect('admin-notice-list', this)"></td>
                <td data-label="Title"><strong>${escapeHTML(n.title)}</strong></td>
                <td data-label="Content">${escapeHTML(n.content)}</td>
                <td data-label="Status"><span class="badge ${n.is_active ? 'badge-success' : 'badge-warning'}">${n.is_active ? 'Active' : 'Inactive'}</span></td>
                <td data-label="Created">${escapeHTML(n.created_at || '-')}</td>
                <td data-label="Actions">
                    <div class="table-actions">
                        <button class="btn btn-outline btn-compact" onclick="editNotice(${n.id})">Edit</button>
                        <button class="btn btn-danger btn-compact" onclick="deleteNotice(${n.id})">Delete</button>
                    </div>
                </td>
            </tr>
        `).join('');
        updateBulkToolbar('admin-notice-list');
    };

    try {
        const token = appState.authToken;
        if (adminNoticesCache.length > 0) {
            doRender(adminNoticesCache);
            return;
        }
        fetch(`${API_BASE}/notices`, {
            headers: { Authorization: `Bearer ${token}` }
        })
        .then(res => res.json())
        .then(notices => doRender(notices))
        .catch(() => {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Failed to load notices</td></tr>';
        });
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Failed to load notices</td></tr>';
    }
}

function filterAdminNotices() { renderAdminNotices(); }

function clearAdminNoticesFilters() {
    const search = getEl('search-admin-notices');
    const status = getEl('filter-admin-notices-status');
    if (search) search.value = '';
    if (status) status.value = '';
    renderAdminNotices();
}

function openAdminNoticeModal(noticeId = null) {
    if (noticeId) {
        const token = appState.authToken;
        fetch(`${API_BASE}/notices`, {
            headers: { Authorization: `Bearer ${token}` }
        })
        .then(res => res.json())
        .then(notices => {
            const n = notices.find(x => x.id === noticeId);
            if (!n) return;
            setText('admin-notice-modal-title', 'Edit Notice');
            getEl('admin-notice-id').value = n.id;
            getEl('admin-notice-title').value = n.title;
            getEl('admin-notice-content').value = n.content;
            getEl('admin-notice-active').checked = !!n.is_active;
            getEl('admin-notice-modal').classList.add('active');
        });
    } else {
        setText('admin-notice-modal-title', 'Add Notice');
        getEl('admin-notice-form').reset();
        getEl('admin-notice-id').value = '';
        getEl('admin-notice-active').checked = true;
        getEl('admin-notice-modal').classList.add('active');
    }
}

function editNotice(id) { openAdminNoticeModal(id); }

async function saveNotice() {
    const idVal = getEl('admin-notice-id').value;
    const title = getEl('admin-notice-title').value.trim();
    const content = getEl('admin-notice-content').value.trim();
    const isActive = getEl('admin-notice-active').checked;

    if (!title || !content) {
        showToast('Title and content are required', 'error');
        return;
    }

    setLoading('btn-save-notice', true, 'Saving...');
    try {
        const payload = { title, content, is_active: isActive };
        if (idVal) {
            await apiRequest(`/notices/${Number(idVal)}`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            showToast('Notice updated');
        } else {
            await apiRequest('/notices', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            showToast('Notice created');
        }
        closeModal('admin-notice-modal');
        adminNoticesCache = [];
        renderAdminNotices();
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect' : (error.message || 'Could not save notice'), 'error');
    } finally {
        setLoading('btn-save-notice', false);
    }
}

async function deleteNotice(id) {
    if (!confirm('Delete this notice?')) return;
    try {
        await apiRequest(`/notices/${Number(id)}`, { method: 'DELETE' });
        adminNoticesCache = [];
        renderAdminNotices();
        showToast('Notice deleted.');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect' : (error.message || 'Could not delete notice'), 'error');
    }
}

// --- Admin categories ---

let adminCategories = [];

async function loadAdminCategories() {
    try {
        const cats = await apiRequest('/categories');
        adminCategories = cats || [];
        populateAdminFilterCategoryDropdowns();
    } catch (err) {
        adminCategories = [];
    }
}

async function loadPublicCategories() {
    try {
        const url = (window.NSGH_API_BASE || 'https://api.nsghbd.com') + '/public/categories';
        const res = await fetch(url);
        if (res.ok) {
            const cats = await res.json();
            adminCategories = cats || [];
            populateAdminFilterCategoryDropdowns();
        }
    } catch (err) {
        // fallback
    }
}

function populateCategoryDropdown() {
    const sel = document.getElementById('admin-doc-category');
    if (!sel) return;
    const currentVal = sel.value;
    sel.innerHTML = '<option value="">Select Category</option>';
    adminCategories.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = c.name;
        if (c.name === currentVal) opt.selected = true;
        sel.appendChild(opt);
    });
}

function populateAdminFilterCategoryDropdowns() {
    const targets = ['filter-admin-doctors-category', 'filter-category'];
    targets.forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = id === 'filter-category'
            ? '<option value="all">All Categories</option>'
            : '<option value="">All Categories</option>';
        adminCategories.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name;
            sel.appendChild(opt);
        });
        sel.value = currentVal;
    });
}

function renderAdminCategories() {
    const tbody = document.getElementById('admin-category-list');
    if (!tbody) return;
    const query = (getEl('search-admin-categories')?.value || '').trim().toLowerCase();
    const filtered = query
        ? adminCategories.filter(c =>
            (c.name || '').toLowerCase().includes(query) ||
            String(c.id).includes(query)
          )
        : adminCategories;
    const rc = getEl('admin-categories-result-count');
    if (rc) rc.textContent = filtered.length ? `Showing ${filtered.length} categor${filtered.length !== 1 ? 'ies' : 'y'}` : '';
    const selected = getBulkState('admin-category-list');
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center" style="color:var(--text-muted)">' + (query ? 'No categories found matching your search.' : 'No categories yet.') + '</td></tr>';
        return;
    }
    tbody.innerHTML = filtered.map(c => `
        <tr${selected.has(String(c.id)) ? ' class="selected"' : ''}>
            <td class="checkbox-col" data-label=""><input type="checkbox" value="${c.id}" ${selected.has(String(c.id)) ? 'checked' : ''} onchange="toggleRowSelect('admin-category-list', this)"></td>
            <td data-label="ID">${c.id}</td>
            <td data-label="Name"><strong>${escapeHTML(c.name)}</strong></td>
            <td data-label="Actions">
                <div class="table-actions">
                    <button class="btn btn-outline btn-compact" onclick="openEditCategoryModal(${c.id})">Edit</button>
                    <button class="btn btn-danger btn-compact" onclick="deleteCategory(${c.id})">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
    updateBulkToolbar('admin-category-list');
}

function filterAdminCategories() { renderAdminCategories(); }

function clearAdminCategoriesFilters() {
    const input = getEl('search-admin-categories');
    if (input) input.value = '';
    renderAdminCategories();
}

function openAdminCategoryModal() {
    document.getElementById('admin-category-form').reset();
    document.getElementById('admin-category-modal').classList.add('active');
}

async function saveCategory() {
    const name = document.getElementById('admin-category-name').value.trim();
    if (!name) { showToast('Category name is required', 'error'); return; }
    setLoading('btn-save-category', true, 'Saving...');
    try {
        await apiRequest('/categories', {
            method: 'POST',
            body: JSON.stringify({ name })
        });
        closeModal('admin-category-modal');
        await loadAdminCategories();
        populateCategoryDropdown();
        renderAdminCategories();
        showToast('Category added');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect' : (error.message || 'Could not add category'), 'error');
    } finally {
        setLoading('btn-save-category', false);
    }
}

function openEditCategoryModal(id) {
    const cat = adminCategories.find(c => c.id === id);
    if (!cat) return;
    document.getElementById('edit-category-id').value = cat.id;
    document.getElementById('edit-category-name').value = cat.name;
    document.getElementById('admin-edit-category-modal').classList.add('active');
}

async function saveEditedCategory() {
    const id = Number(document.getElementById('edit-category-id').value);
    const name = document.getElementById('edit-category-name').value.trim();
    if (!name) { showToast('Category name is required', 'error'); return; }
    setLoading('btn-save-edited-category', true, 'Saving...');
    try {
        await apiRequest(`/categories/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ name })
        });
        closeModal('admin-edit-category-modal');
        await loadAdminCategories();
        populateCategoryDropdown();
        renderAdminCategories();
        showToast('Category updated');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect' : (error.message || 'Could not update category'), 'error');
    } finally {
        setLoading('btn-save-edited-category', false);
    }
}

async function deleteCategory(id) {
    const cat = adminCategories.find(c => c.id === id);
    if (!cat) return;
    if (!confirm(`Delete category "${cat.name}"?`)) return;
    try {
        await apiRequest(`/categories/${id}`, { method: 'DELETE' });
        await loadAdminCategories();
        populateCategoryDropdown();
        renderAdminCategories();
        showToast('Category deleted.');
    } catch (error) {
        showToast(error.isNetworkError ? 'Could not connect' : (error.message || 'Could not delete category'), 'error');
    }
}

// Handle sidebar on resize
window.addEventListener('resize', () => {
    const sidebar = getEl('main-sidebar');
    const hamburger = getEl('mobile-hamburger');
    if (!sidebar) return;
    if (window.innerWidth > 720) {
        sidebar.classList.remove('open');
        if (hamburger) hamburger.classList.add('hidden');
        restoreSidebarState();
    } else {
        if (!appState.currentUser && hamburger) hamburger.classList.add('hidden');
        else if (appState.currentUser && hamburger) hamburger.classList.remove('hidden');
    }
});

// Boot
generateTimeOptions('admin-doc-start-time');
generateTimeOptions('admin-doc-end-time');
bindUIEvents();
loadPublicCategories();
loadData();
