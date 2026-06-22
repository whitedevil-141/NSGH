const API_BASE = window.NSGH_API_BASE || 'https://api.nsghbd.com';

document.getElementById('logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem('token');
    window.location.href = 'login.html';
});

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

const perPage = 8;
let currentPage = 1;
let currentCategory = 'all';
let doctors = [];
let categoriesList = [];

const container = document.getElementById('doctorsContainer');
const filter = document.getElementById('doctorFilter');

const editModalEl = document.getElementById('editDoctorModal');
const editModal = new bootstrap.Modal(editModalEl);

const staffPerPage = 8;
let staffCurrentPage = 1;
let staffs = [];

const staffContainer = document.getElementById('staffsContainer');
const staffPagination = document.getElementById('staffsPagination');

const editStaffModalEl = document.getElementById('editStaffModal');
const editStaffModal = new bootstrap.Modal(editStaffModalEl);

async function loadDoctors() {
    try {
        const res = await fetch(API_BASE + '/public/doctors/data');
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        doctors = data.doctors;
        renderDoctors();
    } catch (err) {
        console.error("Fetch error:", err);
        alert("Failed to fetch doctors: Network or server error");
    }
}

async function loadStaffs() {
    try {
        const res = await fetch(API_BASE + '/public/staffs/data');
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        staffs = data.staffs || [];
        renderStaffs();
    } catch (err) {
        console.error("Fetch error:", err);
        alert("Failed to fetch staffs: Network or server error");
    }
}

function loadFilterOptions() {
    const filter = document.getElementById('doctorFilter');
    if (!filter) return;
    filter.innerHTML = '<option value="all">All Categories</option>';
    categoriesList.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = c.name;
        filter.appendChild(opt);
    });
}

filter.addEventListener('change', e => {
    currentCategory = e.target.value;
    currentPage = 1;
    renderDoctors();
});

function renderDoctors() {
    const filtered = doctors.filter(d => 
        currentCategory === 'all' || (d.category && d.category.includes(currentCategory))
    );

    const start = (currentPage - 1) * perPage;
    const paginated = filtered.slice(start, start + perPage);
    container.innerHTML = '';

    paginated.forEach(d => {
        const div = document.createElement('div');
        div.className = 'col-md-3 doctor-card mb-3';
        const imgSrc = d.photo_url;
        let specs = [];
        try {
            specs = Array.isArray(d.specialization)
                ? d.specialization
                : JSON.parse(d.specialization || '[]');
        } catch (err) {
            console.warn("Invalid specialization JSON:", d.specialization);
            specs = [];
        }
        const specializationStr = specs.length ? specs.join(', ') : '-';
        div.innerHTML = `
            <img src="${escapeHTML(imgSrc || '')}" alt="Not Available" class="img-fluid rounded-circle mb-2">
            <h5>${escapeHTML(d.name)}</h5>
            <p><strong>Specialties:</strong> ${escapeHTML(specializationStr)}<br>
               <strong>Phone:</strong> ${escapeHTML(d.phone || '-')}</p>
            <button class="btn btn-warning btn-sm me-1" onclick="editDoctor(${Number(d.id)})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteDoctor(${Number(d.id)})">Delete</button>
        `;
        container.appendChild(div);
    });

    renderPagination(filtered.length);
}

function renderPagination(total) {
    const totalPages = Math.ceil(total / perPage);
    const ul = document.getElementById('pagination');
    ul.innerHTML = '';
    for (let i = 1; i <= totalPages; i++) {
        const li = document.createElement('li');
        li.className = 'page-item ' + (i === currentPage ? 'active' : '');
        li.innerHTML = '<a href="#" class="page-link">' + i + '</a>';
        li.addEventListener('click', e => {
            e.preventDefault();
            currentPage = i;
            renderDoctors();
        });
        ul.appendChild(li);
    }
}

function addQualificationField(containerId, value) {
    containerId = containerId || 'qualificationsContainer';
    const container = document.getElementById(containerId);
    const div = document.createElement('div');
    div.className = 'd-flex mb-1';

    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'qualifications[]';
    input.className = 'form-control form-control-sm me-2';
    input.value = value || '';
    input.placeholder = 'Qualification';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-outline-danger';
    btn.textContent = 'Remove';
    btn.onclick = () => div.remove();

    div.appendChild(input);
    div.appendChild(btn);
    container.appendChild(div);
}

function addConditionField(containerId, condition) {
    containerId = containerId || 'conditionsContainer';
    condition = condition || {};
    const container = document.getElementById(containerId);
    const div = document.createElement('div');
    div.className = 'row g-1 mb-1 align-items-center';
    div.innerHTML =
        '<div class="col-1"><input type="text" name="condition_icon[]" class="form-control form-control-sm" placeholder="Icon" value="' + escapeHTML(condition.icon || '') + '"></div>' +
        '<div class="col-4"><input type="text" name="condition_title[]" class="form-control form-control-sm" placeholder="Title" value="' + escapeHTML(condition.title || '') + '"></div>' +
        '<div class="col-6"><input type="text" name="condition_description[]" class="form-control form-control-sm" placeholder="Description" value="' + escapeHTML(condition.description || '') + '"></div>' +
        '<div class="col-1"><button type="button" class="btn btn-sm btn-outline-danger" onclick="this.closest(\'.row\').remove()">X</button></div>';
    container.appendChild(div);
}

document.addEventListener('DOMContentLoaded', () => {
    addQualificationField();
    addConditionField();
    loadDoctors();
});

const addForm = document.getElementById('addDoctorForm');
if (addForm) {
    addForm.addEventListener('submit', async e => {
        e.preventDefault();

        const form = new FormData(addForm);

        const category = form.get('category_id') || '';
        const specialties = category ? [category] : [];

        const qualifications = form.getAll('qualifications[]')
            .map(q => q.trim())
            .filter(Boolean);

        const icons = form.getAll('condition_icon[]');
        const titles = form.getAll('condition_title[]');
        const descriptions = form.getAll('condition_description[]');
        const conditions = [];
        for (let i = 0; i < icons.length; i++) {
            if (icons[i] || titles[i] || descriptions[i]) {
                conditions.push({
                    icon: icons[i] || '',
                    title: titles[i] || '',
                    description: descriptions[i] || ''
                });
            }
        }
        
        const uploadData = new FormData();
        uploadData.append('name', form.get('name') || '');
        uploadData.append('description', form.get('description') || '');
        uploadData.append('hospital', form.get('hospital') || '');
        uploadData.append('room', form.get('room') || '');
        uploadData.append('timing', form.get('timing') || '');
        uploadData.append('phone', form.get('phone') || '');
        uploadData.append('specialization', specialties.join(', '));
        uploadData.append('qualifications', JSON.stringify(qualifications));
        uploadData.append('conditions', JSON.stringify(conditions));

        const photoFile = form.get('photo');
        if (photoFile && photoFile.size > 0) {
            uploadData.append('photo', photoFile);
        }

        try {
            const res = await fetch(API_BASE + '/doctors/add', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                body: uploadData
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(errText);
            }

            alert("Doctor added!");
            addForm.reset();
            bootstrap.Modal.getInstance(document.getElementById('addDoctorModal')).hide();
            loadDoctors();
        } catch (err) {
            console.error(err);
            alert("Failed to add doctor: " + err.message);
        }
    });
}

function editDoctor(id) {
    const d = doctors.find(x => x.id == id);
    if (!d) return;

    document.getElementById('editDoctorId').value = d.id;
    document.getElementById('editHospital').value = d.hospital;
    document.getElementById('editName').value = d.name;
    document.getElementById('editRoom').value = d.room || '';
    document.getElementById('editTiming').value = d.timing || '';
    document.getElementById('editPhone').value = d.phone || '';
    document.getElementById('editDescription').value = d.description || '';
    let specs = [];
    try {
        specs = Array.isArray(d.specialization)
            ? d.specialization
            : JSON.parse(d.specialization || '[]');
    } catch (err) {
        console.warn("Invalid specialization JSON:", d.specialization);
        specs = [];
    }

    document.getElementById('editSpecialties').value = specs.length ? specs[0] : '';

    const qualContainer = document.getElementById('editQualificationsContainer');
    qualContainer.innerHTML = '';
    (d.qualifications || []).forEach(q => addQualificationField('editQualificationsContainer', q));

    const condContainer = document.getElementById('editConditionsContainer');
    condContainer.innerHTML = '';
    (d.conditions || []).forEach(c => addConditionField('editConditionsContainer', c));

    editModal.show();
}

const editForm = document.getElementById('editDoctorForm');
if (editForm) {
    editForm.addEventListener('submit', async e => {
        e.preventDefault();
        const form = new FormData(editForm);
        const id = form.get('editDoctorId');

        const category = (form.get('editSpecialties') || '').trim();
        const specialties = category ? [category] : [];

        const qualifications = form.getAll('qualifications[]')
            .map(q => q.trim())
            .filter(Boolean);

        const icons = form.getAll('condition_icon[]');
        const titles = form.getAll('condition_title[]');
        const descriptions = form.getAll('condition_description[]');
        const conditions = [];
        for (let i = 0; i < icons.length; i++) {
            if (icons[i] || titles[i] || descriptions[i]) {
                conditions.push({
                    icon: icons[i] || '',
                    title: titles[i] || '',
                    description: descriptions[i] || ''
                });
            }
        }

        const uploadData = new FormData();
        uploadData.append('name', form.get('editName') || '');
        uploadData.append('hospital', form.get('editHospital') || '');
        uploadData.append('room', form.get('editRoom') || '');
        uploadData.append('timing', form.get('editTiming') || '');
        uploadData.append('phone', form.get('editPhone') || '');
        uploadData.append('description', form.get('editDescription') || '');
        uploadData.append('specialization', specialties.join(', '));
        uploadData.append('qualifications', JSON.stringify(qualifications));
        uploadData.append('conditions', JSON.stringify(conditions));

        const photoFile = form.get('editPhoto');
        if (photoFile && photoFile.size > 0) {
            uploadData.append('photo', photoFile);
        }

        try {
            const res = await fetch(API_BASE + '/doctors/update/' + id, {
                method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + token },
                body: uploadData
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(errText);
            }

            alert("Doctor updated!");
            bootstrap.Modal.getInstance(document.getElementById('editDoctorModal')).hide();
            loadDoctors();
        } catch (err) {
            console.error(err);
            alert("Failed to update doctor: " + err.message);
        }
    });
}

async function deleteDoctor(id) {
    if (!confirm("Delete this doctor?")) return;
    try {
        await fetch(API_BASE + '/doctors/' + id, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token }
        });
        alert("Deleted");
        loadDoctors();
    } catch (err) {
        console.error(err);
        alert("Failed to delete");
    }
}

function renderStaffs() {
    const start = (staffCurrentPage - 1) * staffPerPage;
    const paginated = staffs.slice(start, start + staffPerPage);

    staffContainer.innerHTML = '';
    paginated.forEach(s => {
        const div = document.createElement('div');
        div.className = 'col-md-3 staff-card mb-3 text-center';
        div.innerHTML = `
            <img src="${escapeHTML(s.photo_url || 'placeholder.png')}" alt="Not Available" class="img-fluid rounded-circle mb-2" style="width:100px;height:100px;">
            <h5>${escapeHTML(s.name)}</h5>
            <p><strong>Designation:</strong> ${escapeHTML(s.designation || '-')}</p>
            <p><strong>Phone:</strong> ${escapeHTML(s.phone || '-')}</p>
            <button class="btn btn-warning btn-sm me-1" onclick="editStaff(${Number(s.id)})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteStaff(${Number(s.id)})">Delete</button>
        `;
        staffContainer.appendChild(div);
    });

    renderStaffPagination();
}

function renderStaffPagination() {
    const totalPages = Math.ceil(staffs.length / staffPerPage);
    staffPagination.innerHTML = '';
    for (let i = 1; i <= totalPages; i++) {
        const li = document.createElement('li');
        li.className = 'page-item ' + (i === staffCurrentPage ? 'active' : '');
        li.innerHTML = '<a href="#" class="page-link">' + i + '</a>';
        li.addEventListener('click', e => {
            e.preventDefault();
            staffCurrentPage = i;
            renderStaffs();
        });
        staffPagination.appendChild(li);
    }
}

const addStaffForm = document.getElementById('addStaffForm');
if (addStaffForm) {
    addStaffForm.addEventListener('submit', async e => {
        e.preventDefault();
        const form = new FormData(addStaffForm);

        try {
            const res = await fetch(API_BASE + '/staffs/add', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                body: form
            });

            if (!res.ok) {
                const errMsg = await res.text();
                throw new Error(errMsg || "Failed to add staff");
            }

            alert("Staff added!");
            addStaffForm.reset();
            bootstrap.Modal.getInstance(document.getElementById('addStaffModal'))?.hide();
            loadStaffs();
        } catch (err) {
            console.error(err);
            alert("Failed to add staff: " + err.message);
        }
    });
}

function editStaff(id) {
    const s = staffs.find(x => x.id == id);
    if (!s) return;

    document.getElementById('editStaffId').value = s.id;
    document.getElementById('editStaffName').value = s.name;
    document.getElementById('editStaffDesignation').value = s.designation || '';
    document.getElementById('editStaffPhone').value = s.phone || '';

    editStaffModal.show();
}

const editStaffForm = document.getElementById('editStaffForm');
if (editStaffForm) {
    editStaffForm.addEventListener('submit', async e => {
        e.preventDefault();
        const form = new FormData();

        const id = document.getElementById('editStaffId').value;
        const name = document.getElementById('editStaffName').value;
        const designation = document.getElementById('editStaffDesignation').value;
        const phone = document.getElementById('editStaffPhone').value;

        form.append('name', name);
        form.append('designation', designation);
        form.append('phone', phone);

        const photoInput = document.getElementById('editStaffPhoto');
        if (photoInput.files.length > 0) {
            form.append('photo', photoInput.files[0]);
        }

        try {
            const res = await fetch(API_BASE + '/staffs/update/' + id, {
                method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + token },
                body: form
            });

            if (!res.ok) {
                const errMsg = await res.text();
                throw new Error(errMsg || "Failed to update staff");
            }

            alert("Staff updated!");
            editStaffForm.reset();
            editStaffModal.hide();
            loadStaffs();
        } catch (err) {
            console.error(err);
            alert("Failed to update staff: " + err.message);
        }
    });
}

async function deleteStaff(id) {
    if (!confirm("Delete this staff?")) return;
    try {
        await fetch(API_BASE + '/staffs/' + id, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token }
        });
        alert("Deleted");
        loadStaffs();
    } catch (err) {
        console.error(err);
        alert("Failed to delete staff: " + err.message);
    }
}

function loadCategoryDropdowns() {
    const selects = ['add-doc-category', 'editSpecialties'];
    selects.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const currentVal = el.value;
        el.innerHTML = '<option value="">Select Category</option>';
        categoriesList.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name;
            if (c.name === currentVal) opt.selected = true;
            el.appendChild(opt);
        });
    });
}

function renderCategories() {
    const container = document.getElementById('categoriesContainer');
    container.innerHTML = '';
    if (!categoriesList.length) {
        container.innerHTML = '<p class="text-muted">No categories yet.</p>';
        return;
    }
    categoriesList.forEach(c => {
        const div = document.createElement('div');
        div.className = 'col-md-3 mb-3';
        div.innerHTML =
            '<div class="card p-3 text-center">' +
            '<h5>' + escapeHTML(c.name) + '</h5>' +
            '<div class="mt-2">' +
            '<button class="btn btn-warning btn-sm me-1" onclick="editCategory(' + c.id + ', \'' + escapeHTML(c.name) + '\')">Edit</button> ' +
            '<button class="btn btn-danger btn-sm" onclick="deleteCategory(' + c.id + ')">Delete</button>' +
            '</div></div>';
        container.appendChild(div);
    });
}

function openAddCategoryModal() {
    document.getElementById('addCategoryForm').reset();
    new bootstrap.Modal(document.getElementById('addCategoryModal')).show();
}

document.getElementById('addCategoryForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = e.target.categoryName.value.trim();
    if (!name) return alert('Category name is required');
    try {
        const res = await fetch(API_BASE + '/doctors/categories', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Failed to add category');
        }
        alert('Category added!');
        bootstrap.Modal.getInstance(document.getElementById('addCategoryModal')).hide();
        loadCategories();
        loadDoctors();
    } catch (err) {
        alert(err.message);
    }
});

function editCategory(id, name) {
    document.getElementById('editCategoryId').value = id;
    document.getElementById('editCategoryName').value = name;
    new bootstrap.Modal(document.getElementById('editCategoryModal')).show();
}

document.getElementById('editCategoryForm').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('editCategoryId').value;
    const name = document.getElementById('editCategoryName').value.trim();
    if (!name) return alert('Category name is required');
    try {
        const res = await fetch(API_BASE + '/doctors/categories/' + id, {
            method: 'PUT',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Failed to update category');
        }
        alert('Category updated!');
        bootstrap.Modal.getInstance(document.getElementById('editCategoryModal')).hide();
        loadCategories();
        loadDoctors();
    } catch (err) {
        alert(err.message);
    }
});

async function deleteCategory(id) {
    if (!confirm('Delete this category?')) return;
    try {
        const res = await fetch(API_BASE + '/doctors/categories/' + id, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) throw new Error('Failed to delete');
        alert('Category deleted');
        loadCategories();
        loadDoctors();
    } catch (err) {
        alert(err.message);
    }
}

async function loadCategories() {
    try {
        const res = await fetch(API_BASE + '/doctors/categories', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) throw new Error(await res.text());
        categoriesList = await res.json();
        renderCategories();
        loadCategoryDropdowns();
        loadFilterOptions();
    } catch (err) {
        console.error("Fetch error:", err);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadStaffs();
    loadCategories();
});
