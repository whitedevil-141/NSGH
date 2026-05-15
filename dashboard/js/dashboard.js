// ---------------- Logout ----------------
document.getElementById('logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem('token');
    window.location.href = 'login.html';
});

// ---------------- Doctors Tab ----------------
const perPage = 8;
let currentPage = 1;
let currentCategory = 'all';
let doctors = [];
let categories = [];

const container = document.getElementById('doctorsContainer');
const filter = document.getElementById('doctorFilter');

// Initialize modal once
const editModalEl = document.getElementById('editDoctorModal');
const editModal = new bootstrap.Modal(editModalEl);

// ---------------- Staffs Tab ----------------
const staffPerPage = 8;
let staffCurrentPage = 1;
let staffs = [];

const staffContainer = document.getElementById('staffsContainer');
const staffPagination = document.getElementById('staffsPagination');

// Initialize modals
const editStaffModalEl = document.getElementById('editStaffModal');
const editStaffModal = new bootstrap.Modal(editStaffModalEl);


// ---------------- Load doctors from API ----------------
async function loadDoctors() {
    try {
        const res = await fetch('https://api.nsghbd.com/public/doctors/data');
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        doctors = data.doctors;
        categories = data.categories;
        loadFilterOptions();
        renderDoctors();
    } catch (err) {
        console.error("Fetch error:", err);
        alert("Failed to fetch doctors: Network or server error");
    }
}

// ---------------- Load staffs from API ----------------
async function loadStaffs() {
    try {
        const res = await fetch('https://api.nsghbd.com/public/staffs/data');
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        staffs = data.staffs || [];
        renderStaffs();
    } catch (err) {
        console.error("Fetch error:", err);
        alert("Failed to fetch staffs: Network or server error");
    }
}

// ---------------- Filter options ----------------
function loadFilterOptions() {
    filter.innerHTML = `<option value="all">All Categories</option>`;
    categories.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        filter.appendChild(opt);
    });
}

filter.addEventListener('change', e => {
    currentCategory = e.target.value;
    currentPage = 1;
    renderDoctors();
});

// ---------------- Render doctors ----------------
function renderDoctors() {
    // Filter doctors by category
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
                : JSON.parse(d.specialization || '[]'); // parse JSON string
        } catch (err) {
            console.warn("Invalid specialization JSON:", d.specialization);
            specs = [];
        }
        const specializationStr = specs.length ? specs.join(', ') : '-';
        div.innerHTML = `
            <img src="${imgSrc}" alt="Not Available" class="img-fluid rounded-circle mb-2">
            <h5>${d.name}</h5>
            <p><strong>Specialties:</strong> ${specializationStr}<br>
               <strong>Phone:</strong> ${d.phone || '-'}</p>
            <button class="btn btn-warning btn-sm me-1" onclick="editDoctor('${d.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteDoctor('${d.id}')">Delete</button>
        `;
        container.appendChild(div);
    });

    renderPagination(filtered.length);
}

// ---------------- Pagination ----------------
function renderPagination(total) {
    const totalPages = Math.ceil(total / perPage);
    const ul = document.getElementById('pagination');
    ul.innerHTML = '';
    for (let i = 1; i <= totalPages; i++) {
        const li = document.createElement('li');
        li.className = `page-item ${i === currentPage ? 'active' : ''}`;
        li.innerHTML = `<a href="#" class="page-link">${i}</a>`;
        li.addEventListener('click', e => {
            e.preventDefault();
            currentPage = i;
            renderDoctors();
        });
        ul.appendChild(li);
    }
}

// ---------------- Dynamic Fields ----------------
function addQualificationField(containerId='qualificationsContainer', value='') {
    const container = document.getElementById(containerId);
    const div = document.createElement('div');
    div.className = 'd-flex mb-1';

    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'qualifications[]';
    input.className = 'form-control form-control-sm me-2';
    input.value = value;  // safer than innerHTML
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


function addConditionField(containerId='conditionsContainer', condition={icon:'',title:'',description:''}) {
    const container = document.getElementById(containerId);
    const div = document.createElement('div');
    div.className = 'row g-1 mb-1 align-items-center';
    div.innerHTML = `
        <div class="col-1"><input type="text" name="condition_icon[]" class="form-control form-control-sm" placeholder="Icon" value="${condition.icon}"></div>
        <div class="col-4"><input type="text" name="condition_title[]" class="form-control form-control-sm" placeholder="Title" value="${condition.title}"></div>
        <div class="col-6"><input type="text" name="condition_description[]" class="form-control form-control-sm" placeholder="Description" value="${condition.description}"></div>
        <div class="col-1"><button type="button" class="btn btn-sm btn-outline-danger" onclick="this.closest('.row').remove()">X</button></div>
    `;
    container.appendChild(div);
}

// ---------------- Initialize dynamic fields ----------------
document.addEventListener('DOMContentLoaded', () => {
    addQualificationField();
    addConditionField();
    loadDoctors(); // initial load
});


const addForm = document.getElementById('addDoctorForm');
if (addForm) {
    addForm.addEventListener('submit', async e => {
        e.preventDefault();

        const form = new FormData(addForm);

        // ---------------- Parse specialties ----------------
        const specialties = (form.get('specialties') || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

        // ---------------- Parse qualifications ----------------
        const qualifications = form.getAll('qualifications[]')
            .map(q => q.trim())
            .filter(Boolean);

        // ---------------- Parse conditions ----------------
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
        
        // ---------------- Build FormData ----------------
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

        // ---------------- Optional photo ----------------
        const photoFile = form.get('photo');
        if (photoFile && photoFile.size > 0) {
            uploadData.append('photo', photoFile);
        }

        // ---------------- Send to backend ----------------
        try {
            const res = await fetch('https://api.nsghbd.com/doctors/add', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }, // keep auth if needed
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



// ---------------- Edit Doctor Modal ----------------
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

    document.getElementById('editSpecialties').value = specs.join(', ');

    const qualContainer = document.getElementById('editQualificationsContainer');
    qualContainer.innerHTML = '';
    (d.qualifications || []).forEach(q => addQualificationField('editQualificationsContainer', q));

    const condContainer = document.getElementById('editConditionsContainer');
    condContainer.innerHTML = '';
    (d.conditions || []).forEach(c => addConditionField('editConditionsContainer', c));

    editModal.show();
}

// ---------------- Edit Doctor Submit ----------------
const editForm = document.getElementById('editDoctorForm');
if (editForm) {
    editForm.addEventListener('submit', async e => {
        e.preventDefault();
        const form = new FormData(editForm);
        const id = form.get('editDoctorId');

        // ---------------- Parse specialties ----------------
        const specialties = (form.get('editSpecialties') || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

        // ---------------- Parse qualifications ----------------
        const qualifications = form.getAll('qualifications[]')
            .map(q => q.trim())
            .filter(Boolean);

        // ---------------- Parse conditions ----------------
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

        // ---------------- Build FormData ----------------
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

        // ---------------- Optional photo ----------------
        const photoFile = form.get('editPhoto');
        if (photoFile && photoFile.size > 0) {
            uploadData.append('photo', photoFile);
        }

        // ---------------- Send to backend ----------------
        try {
            const res = await fetch(`https://api.nsghbd.com/doctors/update/${id}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}` }, 
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



// ---------------- Delete Doctor ----------------
async function deleteDoctor(id) {
    if (!confirm("Delete this doctor?")) return;
    try {
        await fetch(`https://api.nsghbd.com/doctors/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        alert("Deleted");
        loadDoctors();
    } catch (err) {
        console.error(err);
        alert("Failed to delete");
    }
}

// ---------------- Render staffs ----------------
function renderStaffs() {
    const start = (staffCurrentPage - 1) * staffPerPage;
    const paginated = staffs.slice(start, start + staffPerPage);

    staffContainer.innerHTML = '';
    paginated.forEach(s => {
        const div = document.createElement('div');
        div.className = 'col-md-3 staff-card mb-3 text-center';
        div.innerHTML = `
            <img src="${s.photo_url || 'placeholder.png'}" alt="Not Available" class="img-fluid rounded-circle mb-2" style="width:100px;height:100px;">
            <h5>${s.name}</h5>
            <p><strong>Designation:</strong> ${s.designation || '-'}</p>
            <p><strong>Phone:</strong> ${s.phone || '-'}</p>
            <button class="btn btn-warning btn-sm me-1" onclick="editStaff('${s.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteStaff('${s.id}')">Delete</button>
        `;
        staffContainer.appendChild(div);
    });

    renderStaffPagination();
}

// ---------------- Staff Pagination ----------------
function renderStaffPagination() {
    const totalPages = Math.ceil(staffs.length / staffPerPage);
    staffPagination.innerHTML = '';
    for (let i = 1; i <= totalPages; i++) {
        const li = document.createElement('li');
        li.className = `page-item ${i === staffCurrentPage ? 'active' : ''}`;
        li.innerHTML = `<a href="#" class="page-link">${i}</a>`;
        li.addEventListener('click', e => {
            e.preventDefault();
            staffCurrentPage = i;
            renderStaffs();
        });
        staffPagination.appendChild(li);
    }
}

// ---------------- Add Staff ----------------
const addStaffForm = document.getElementById('addStaffForm');
if (addStaffForm) {
    addStaffForm.addEventListener('submit', async e => {
        e.preventDefault();
        const form = new FormData(addStaffForm);

        try {
            const res = await fetch('https://api.nsghbd.com/staffs/add', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
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

// ---------------- Edit Staff ----------------
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

        // Only append photo if a file is selected
        const photoInput = document.getElementById('editStaffPhoto');
        if (photoInput.files.length > 0) {
            form.append('photo', photoInput.files[0]);
        }

        try {
            const res = await fetch(`https://api.nsghbd.com/staffs/update/${id}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}` },
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

// ---------------- Delete Staff ----------------
async function deleteStaff(id) {
    if (!confirm("Delete this staff?")) return;
    try {
        await fetch(`https://api.nsghbd.com/staffs/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        alert("Deleted");
        loadStaffs();
    } catch (err) {
        console.error(err);
        alert("Failed to delete staff: " + err.message);
    }
}

// ---------------- Initialize ----------------
document.addEventListener('DOMContentLoaded', loadStaffs);