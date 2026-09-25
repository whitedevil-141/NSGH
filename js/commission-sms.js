// Uses the appointment portal's authenticated API, navigation and visual language.
const commissionState = { owner: null, doctors: [], templates: [], loading: null, loaded: false, sending: false, attempt: null, historySkip: 0, historyVersion: 0 };
const COMMISSION_API = '/commission-sms';

function clearCommissionWorkspace() {
    Object.assign(commissionState, { owner: null, doctors: [], templates: [], loaded: false, loading: null, attempt: null, historySkip: 0 });
    commissionState.historyVersion++;
    ['commission-doctor-list', 'commission-template-list', 'commission-history-list', 'commission-send-result', 'commission-editor-fields', 'commission-user-list'].forEach(id => getEl(id)?.replaceChildren());
    getEl('commission-send-form')?.reset();
    getEl('commission-editor')?.close();
    populateCommissionSelects();
}

function commissionToday() {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = type => parts.find(p => p.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}

function commissionError(error) {
    if (error.status === 401) {
        logout();
        return 'Your session expired. Please log in again.';
    }
    if (error.isNetworkError) return 'Could not connect. Check your connection and try again.';
    const detail = error.payload?.detail;
    if (Array.isArray(detail)) return detail.map(item => `${item.loc.at(-1)}: ${item.msg}`).join('. ');
    return error.message || 'The request could not be completed.';
}

async function commissionRequest(path, options) {
    return apiRequest(COMMISSION_API + path, options);
}

function initCommissionPortal() {
    if (!canAccess('commission-sms-panel')) return;
    if (commissionState.owner !== appState.currentUser.id) {
        clearCommissionWorkspace();
        commissionState.owner = appState.currentUser.id;
    }
    getEl('commission-today').textContent = `Today · ${commissionToday()}`;
    if (!getEl('commission-date').value) getEl('commission-date').value = commissionToday();
    switchCommissionTab('commission-send');
}

function switchCommissionTab(tabId) {
    if (!canAccess('commission-sms-panel')) return;
    hideCommissionDoctorSuggestions();
    if (!Object.values(COMMISSION_SUB_HASH_MAP).includes(tabId)) tabId = 'commission-send';
    if (appState.currentView !== 'commission-sms-panel') navigateSafe('commission-sms-panel');
    Object.values(COMMISSION_SUB_HASH_MAP).forEach(id => getEl(`${id}-content`).classList.toggle('hidden', id !== tabId));
    document.querySelectorAll('.sidebar-nav .sidebar-item').forEach(el => el.classList.toggle('active', el.id === `tab-${tabId}`));
    getEl('main-sidebar')?.classList.remove('open');
    getEl('sidebar-overlay')?.classList.remove('active');
    localStorage.setItem(STORAGE_SUB_VIEW, tabId);
    setUrlHash(`commission-sms-panel/${Object.keys(COMMISSION_SUB_HASH_MAP).find(key => COMMISSION_SUB_HASH_MAP[key] === tabId)}`);
    if (tabId === 'commission-history') renderCommissionHistory(0);
    else refreshCommissionWorkspace();
}

async function refreshCommissionWorkspace() {
    if (commissionState.loading) return commissionState.loading;
    const owner = commissionState.owner;
    getEl('commission-send-button').disabled = true;
    commissionState.loaded = false;
    getEl('commission-load-error').classList.add('hidden');
    commissionState.loading = (async () => {
        try {
            const results = await Promise.allSettled([commissionRequest('/doctors'), commissionRequest('/templates')]);
            const error = results.find(result => result.status === 'rejected');
            if (error) throw error.reason;
            if (owner !== appState.currentUser?.id) return;
            commissionState.doctors = results[0].value;
            commissionState.templates = results[1].value;
            commissionState.loaded = true;
            renderCommissionDoctors();
            renderCommissionTemplates();
            populateCommissionSelects();
        } catch (error) {
            if (owner !== appState.currentUser?.id) return;
            getEl('commission-load-error').textContent = commissionError(error) + ' Open a panel section to retry.';
            getEl('commission-load-error').classList.remove('hidden');
        } finally {
            if (owner === commissionState.owner) commissionState.loading = null;
        }
    })();
    return commissionState.loading;
}

function populateCommissionSelects() {
    const templates = getEl('commission-template-select');
    const oldTemplate = templates.value;
    templates.innerHTML = `<option value="">${commissionState.templates.length ? 'Select a template' : 'Add an SMS template first'}</option>` + commissionState.templates.map(t => `<option value="${t.id}">${escapeHTML(t.name)}</option>`).join('');
    templates.value = commissionState.templates.some(t => String(t.id) === oldTemplate) ? oldTemplate : String(commissionState.templates[0]?.id || '');
    filterCommissionDoctorSelect();
}

function filterCommissionDoctorSelect() {
    const select = getEl('commission-doctor-select');
    const selected = select.value;
    const query = getEl('commission-recipient-search').value.trim().toLowerCase();
    const doctors = commissionState.doctors.filter(d => [d.doctor_id, d.name, d.address, d.phone].some(value => value.toLowerCase().includes(query)));
    const placeholder = !commissionState.doctors.length ? 'Add a doctor in the Doctors section first' : doctors.length ? 'Select a doctor' : 'No doctors match your search';
    select.innerHTML = `<option value="">${placeholder}</option>` + doctors.map(d => `<option value="${d.id}">${escapeHTML(d.doctor_id)} · ${escapeHTML(d.name)}</option>`).join('');
    select.value = doctors.some(d => String(d.id) === selected) ? selected : '';
    hideCommissionDoctorSuggestions();
    const suggestions = getEl('commission-doctor-suggestions');
    suggestions.replaceChildren();
    if (query && document.activeElement === getEl('commission-recipient-search') && !commissionState.sending) {
        suggestions.innerHTML = doctors.map(d => `<button type="button" class="commission-doctor-option" id="commission-doctor-option-${d.id}" role="option" aria-selected="false" tabindex="-1" data-doctor-id="${d.id}"><strong>${escapeHTML(d.name)} · ${escapeHTML(d.doctor_id)}</strong><small>${escapeHTML(d.phone)}</small><small>${escapeHTML(d.address)}</small></button>`).join('');
        getEl('commission-doctor-search-empty').classList.toggle('hidden', doctors.length > 0);
        getEl('commission-doctor-search-results').classList.remove('hidden');
        getEl('commission-recipient-search').setAttribute('aria-expanded', 'true');
    }
    previewCommissionSms();
}

function hideCommissionDoctorSuggestions() {
    getEl('commission-doctor-search-results').classList.add('hidden');
    const search = getEl('commission-recipient-search');
    search.setAttribute('aria-expanded', 'false');
    search.removeAttribute('aria-activedescendant');
    getEl('commission-doctor-suggestions').querySelectorAll('[aria-selected="true"]').forEach(option => option.setAttribute('aria-selected', 'false'));
}

function selectCommissionDoctorSuggestion(id) {
    const select = getEl('commission-doctor-select');
    if (commissionState.sending || ![...select.options].some(option => option.value === String(id))) return;
    select.value = String(id);
    getEl('commission-recipient-search').focus({ preventScroll: true });
    hideCommissionDoctorSuggestions();
    previewCommissionSms();
}

function handleCommissionDoctorSearchKey(event) {
    // Enter in this field must never submit the SMS form, including during IME composition.
    if (event.key === 'Enter') event.preventDefault();
    if (event.isComposing) return;
    const search = getEl('commission-recipient-search');
    if (event.key === 'Escape') {
        event.preventDefault();
        hideCommissionDoctorSuggestions();
        return;
    }
    if (event.key === 'Enter') {
        const active = getEl(search.getAttribute('aria-activedescendant'));
        if (search.getAttribute('aria-expanded') === 'true' && active) selectCommissionDoctorSuggestion(active.dataset.doctorId);
        return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    if (search.getAttribute('aria-expanded') !== 'true') filterCommissionDoctorSelect();
    const options = [...getEl('commission-doctor-suggestions').querySelectorAll('[role="option"]')];
    if (!options.length) return;
    const current = options.findIndex(option => option.id === search.getAttribute('aria-activedescendant'));
    const next = current === -1 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options.forEach((option, index) => option.setAttribute('aria-selected', String(index === next)));
    search.setAttribute('aria-activedescendant', options[next].id);
    options[next].scrollIntoView({ block: 'nearest' });
}

function renderCommissionText(body, values) {
    // Mirrors Python format's allowed placeholders and escaped literal braces.
    return body.replace(/\{\{|\}\}|\{(name|amount|date)\}/g, (match, key) => match === '{{' ? '{' : match === '}}' ? '}' : values[key]);
}

function previewCommissionSms() {
    const doctor = commissionState.doctors.find(d => d.id === Number(getEl('commission-doctor-select').value));
    const template = commissionState.templates.find(t => t.id === Number(getEl('commission-template-select').value));
    const amount = getEl('commission-amount').value;
    const date = getEl('commission-date').value;
    getEl('commission-doctor-detail').textContent = doctor ? `${doctor.doctor_id} · ${doctor.name}\n${doctor.address}\n${doctor.phone}` : 'Select a doctor to see their details.';
    const message = template ? renderCommissionText(template.body, { name: doctor?.name || '{name}', amount: amount && Number.isFinite(Number(amount)) ? Number(amount).toFixed(2) : '{amount}', date: date || '{date}' }) : '';
    getEl('commission-preview').textContent = message || 'Choose a doctor and template to preview your SMS.';
    getEl('commission-character-count').textContent = message ? `${Array.from(message).length} characters` : '';
    getEl('commission-send-button').disabled = commissionState.sending || !commissionState.loaded || !doctor || !template || !amount || Number(amount) <= 0 || !date;
}

async function sendCommissionSms() {
    if (commissionState.sending || !commissionState.loaded || !getEl('commission-send-form').reportValidity()) return;
    const payload = { doctor_id: Number(getEl('commission-doctor-select').value), template_id: Number(getEl('commission-template-select').value), amount: Number(getEl('commission-amount').value).toFixed(2), date: getEl('commission-date').value };
    const signature = JSON.stringify(payload);
    const owner = appState.currentUser.id;
    // Retain this ID after a network error so the retry can retrieve the original attempt.
    if (!commissionState.attempt || commissionState.attempt.signature !== signature) commissionState.attempt = { signature, id: crypto.randomUUID() };
    commissionState.sending = true;
    hideCommissionDoctorSuggestions();
    getEl('commission-send-button').disabled = true;
    getEl('commission-send-button').textContent = 'Submitting…';
    const inputs = [...getEl('commission-send-form').querySelectorAll('input, select')];
    inputs.forEach(input => { input.disabled = true; });
    try {
        const record = await commissionRequest('/send', { method: 'POST', body: JSON.stringify({ ...payload, request_id: commissionState.attempt.id }) });
        if (owner !== appState.currentUser?.id) return;
        getEl('commission-send-result').textContent = `SMS #${record.id} · ${record.status}. ${record.status_detail}`;
        showToast(record.status === 'submitted' ? 'SMS submitted. You can review it in SMS history.' : record.status_detail, record.status === 'submitted' ? 'success' : 'warning');
        // Keep the attempt key for failed, pending or uncertain sends to avoid blind resubmission.
        if (record.status === 'submitted') {
            commissionState.attempt = null;
            getEl('commission-amount').value = '';
        }
    } catch (error) {
        if (owner !== appState.currentUser?.id) return;
        getEl('commission-send-result').textContent = commissionError(error) + ' Retry with the same details to check the original request without sending it twice.';
        showToast(commissionError(error), 'error');
    } finally {
        commissionState.sending = false;
        inputs.forEach(input => { input.disabled = false; });
        getEl('commission-send-button').textContent = 'Send commission SMS';
        previewCommissionSms();
    }
}

function renderCommissionDoctors() {
    const query = getEl('commission-doctor-search').value.trim().toLowerCase();
    const doctors = commissionState.doctors.filter(d => [d.doctor_id, d.name, d.address, d.phone].some(value => value.toLowerCase().includes(query)));
    getEl('commission-doctor-list').innerHTML = doctors.map(d => `<tr><td data-label="Doctor ID">${escapeHTML(d.doctor_id)}</td><td data-label="Doctor name"><strong>${escapeHTML(d.name)}</strong></td><td data-label="Doctor address">${escapeHTML(d.address)}</td><td data-label="Phone">${escapeHTML(d.phone)}</td><td data-label="Actions"><div class="table-actions"><button class="btn btn-outline btn-compact" onclick="editCommissionDoctor(${d.id})">Edit</button><button class="btn btn-danger btn-compact" onclick="deleteCommissionRecord('doctors', ${d.id})">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="commission-empty">No doctors found. Add a doctor to start sending commission updates.</td></tr>';
}

function renderCommissionTemplates() {
    getEl('commission-template-list').innerHTML = commissionState.templates.map(t => `<article class="commission-template"><h4>${escapeHTML(t.name)}</h4><p class="commission-message">${escapeHTML(t.body)}</p><div class="table-actions"><button class="btn btn-outline btn-compact" onclick="editCommissionTemplate(${t.id})">Edit template</button><button class="btn btn-danger btn-compact" onclick="deleteCommissionRecord('templates', ${t.id})">Delete</button></div></article>`).join('') || '<p class="commission-empty">No templates yet. Add a template using {name}, {amount} and {date}.</p>';
}

function commissionField(name, label, value = '', options = {}) {
    const id = `commission-edit-${name}`;
    const attrs = `id="${id}" name="${name}" ${options.optional ? '' : 'required'} maxlength="${options.max || 100}"`;
    const input = options.multiline ? `<textarea ${attrs} rows="5">${escapeHTML(value)}</textarea>` : `<input ${attrs} type="${options.type || 'text'}" value="${escapeHTML(value)}" ${options.min ? `minlength="${options.min}"` : ''} ${options.type === 'password' ? 'autocomplete="new-password"' : ''}>`;
    return `<div class="input-group"><label for="${id}">${escapeHTML(label)}</label>${input}</div>`;
}

function openCommissionEditor(title, fields, onSave) {
    const dialog = getEl('commission-editor');
    getEl('commission-editor-title').textContent = title;
    getEl('commission-editor-fields').innerHTML = fields;
    getEl('commission-editor-error').textContent = '';
    const form = getEl('commission-editor-form');
    form.onsubmit = async event => {
        event.preventDefault();
        const button = getEl('commission-editor-save');
        if (button.disabled) return;
        button.disabled = true;
        button.textContent = 'Saving…';
        try {
            await onSave(Object.fromEntries(new FormData(form)));
            dialog.close();
            showToast('Changes saved.');
        } catch (error) {
            getEl('commission-editor-error').textContent = commissionError(error);
        } finally {
            button.disabled = false;
            button.textContent = 'Save';
        }
    };
    dialog.showModal();
}

function editCommissionDoctor(id) {
    const doctor = commissionState.doctors.find(d => d.id === id) || {};
    openCommissionEditor(id ? 'Edit doctor' : 'Add doctor',
        commissionField('doctor_id', 'Doctor ID', doctor.doctor_id, { max: 50 }) + '<p class="commission-muted">Use letters, numbers, hyphens or underscores.</p>' +
        commissionField('name', 'Doctor name', doctor.name, { min: 2 }) +
        commissionField('address', 'Doctor address', doctor.address, { multiline: true, max: 500 }) +
        commissionField('phone', 'Mobile number for SMS', doctor.phone, { type: 'tel', max: 20 }), async values => {
            await commissionRequest(`/doctors${id ? '/' + id : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(values) });
            await refreshCommissionWorkspace();
        });
}

function editCommissionTemplate(id) {
    const template = commissionState.templates.find(t => t.id === id) || {};
    openCommissionEditor(id ? 'Edit SMS template' : 'Add SMS template',
        commissionField('name', 'Template name', template.name) +
        commissionField('body', 'Message', template.body || 'Dear {name}, your commission payment of BDT {amount} for {date} has been sent. Thank you for your partnership.', { multiline: true, max: 1000 }) +
        '<p class="commission-muted">Available placeholders: {name}, {amount}, {date}. Use {{ and }} for literal braces.</p>', async values => {
            await commissionRequest(`/templates${id ? '/' + id : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(values) });
            await refreshCommissionWorkspace();
        });
}

async function deleteCommissionRecord(kind, id) {
    if (!['doctors', 'templates'].includes(kind)) return;
    const record = commissionState[kind].find(row => row.id === id);
    if (!record || !confirm(`Delete "${record.name}"? Existing SMS history will be kept.`)) return;
    try {
        await commissionRequest(`/${kind}/${id}`, { method: 'DELETE' });
        await refreshCommissionWorkspace();
        showToast('Deleted. SMS history retained.');
    } catch (error) { showToast(commissionError(error), 'error'); }
}

async function renderCommissionHistory(skip = commissionState.historySkip) {
    const version = ++commissionState.historyVersion;
    const owner = appState.currentUser?.id;
    commissionState.historySkip = Math.max(0, skip);
    const params = new URLSearchParams({ skip: commissionState.historySkip, limit: 20, search: getEl('commission-history-search').value.trim() });
    if (getEl('commission-history-date').value) params.set('payment_date', getEl('commission-history-date').value);
    getEl('commission-history-list').innerHTML = '<tr><td colspan="5" class="commission-empty">Loading SMS history…</td></tr>';
    getEl('commission-history-prev').disabled = true;
    getEl('commission-history-next').disabled = true;
    try {
        const page = await commissionRequest('/history?' + params);
        if (version !== commissionState.historyVersion || owner !== appState.currentUser?.id) return;
        getEl('commission-history-list').innerHTML = page.items.map(row => `<tr>
            <td data-label="Submitted at">${escapeHTML(row.created_at.replace('T', ' ').replace('+06:00', ''))}<small class="commission-muted">Bangladesh time · ${escapeHTML(row.sent_by_name)}</small></td>
            <td data-label="Doctor"><strong>${escapeHTML(row.doctor_name)}</strong><small>${escapeHTML(row.doctor_id)} · ${escapeHTML(row.phone)}</small><small class="commission-muted">${escapeHTML(row.doctor_address)}</small></td>
            <td data-label="Commission">BDT ${escapeHTML(Number(row.amount).toFixed(2))}<small>${escapeHTML(row.payment_date)}</small></td>
            <td data-label="Message"><details><summary>${escapeHTML(row.template_name)} · View SMS</summary><p class="commission-message">${escapeHTML(row.message)}</p></details></td>
            <td data-label="Status"><span class="badge ${row.status === 'submitted' ? 'badge-info' : 'badge-warning'}">${escapeHTML(row.status)}</span><small class="commission-muted">${escapeHTML(row.status_detail)}</small></td>
        </tr>`).join('') || '<tr><td colspan="5" class="commission-empty">No SMS history matches these filters.</td></tr>';
        getEl('commission-history-count').textContent = page.total ? `${commissionState.historySkip + 1}–${commissionState.historySkip + page.items.length} of ${page.total} messages` : '0 messages';
        getEl('commission-history-prev').disabled = commissionState.historySkip === 0;
        getEl('commission-history-next').disabled = commissionState.historySkip + page.items.length >= page.total;
    } catch (error) {
        if (version !== commissionState.historyVersion) return;
        getEl('commission-history-list').innerHTML = `<tr><td colspan="5" class="commission-error">${escapeHTML(commissionError(error))} Use Refresh to try again.</td></tr>`;
        getEl('commission-history-count').textContent = '';
    }
}

function renderCommissionUsers() {
    const query = getEl('commission-user-search').value.trim().toLowerCase();
    const users = appState.users.filter(user => user.role === ROLES.COMMISSION_SMS && [user.name, user.phone, user.email || ''].some(value => value.toLowerCase().includes(query)));
    getEl('commission-user-list').innerHTML = users.map(user => `<tr><td data-label="Name">${escapeHTML(user.name)}</td><td data-label="Phone">${escapeHTML(user.phone)}</td><td data-label="Email">${escapeHTML(user.email || '—')}</td><td data-label="Actions"><div class="table-actions"><button class="btn btn-outline btn-compact" data-edit-user="${escapeHTML(user.id)}">Edit</button><button class="btn btn-danger btn-compact" data-delete-user="${escapeHTML(user.id)}">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="4" class="commission-empty">No commission SMS users found.</td></tr>';
    getEl('commission-user-list').onclick = event => {
        const edit = event.target.closest('[data-edit-user]');
        const remove = event.target.closest('[data-delete-user]');
        if (edit) editCommissionUser(edit.dataset.editUser);
        if (remove) deleteCommissionUser(remove.dataset.deleteUser);
    };
}

function editCommissionUser(id) {
    if (getRole(appState.currentUser) !== ROLES.ADMIN) return;
    const user = appState.users.find(u => u.id === id && u.role === ROLES.COMMISSION_SMS) || {};
    openCommissionEditor(id ? 'Edit commission SMS user' : 'Add commission SMS user',
        commissionField('name', 'Full name', user.name, { min: 2 }) +
        commissionField('phone', 'Login phone number', user.phone, { type: 'tel', max: 20 }) +
        commissionField('email', 'Email (optional)', user.email, { type: 'email', optional: true, max: 120 }) +
        commissionField('password', id ? 'New password (leave blank to keep current)' : 'Initial password', '', { type: 'password', optional: !!id, min: 6, max: 72 }), async values => {
            if (!values.password) delete values.password;
            await commissionRequest(`/users${id ? '/' + encodeURIComponent(id) : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(values) });
            await refreshDataFromApi();
            renderCommissionUsers();
        });
}

async function deleteCommissionUser(id) {
    const user = appState.users.find(u => u.id === id && u.role === ROLES.COMMISSION_SMS);
    if (!user || !confirm(`Delete the commission SMS account for "${user.name}"? This removes their panel access.`)) return;
    try {
        await commissionRequest(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refreshDataFromApi();
        renderCommissionUsers();
        showToast('Commission SMS user deleted.');
    } catch (error) { showToast(commissionError(error), 'error'); }
}
