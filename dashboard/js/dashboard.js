// Logout
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

// Load doctors from API
async function loadDoctors() {
    try {
        const res = await fetch('http://www.api.nsghbd.com/public/doctors/data');

        if (!res.ok) {
            // Handle non-200 responses gracefully
            const text = await res.text();
            console.error(`Error fetching doctors: ${res.status} ${res.statusText}`, text);
            alert(`Failed to fetch doctors: ${res.status} ${res.statusText}. Please try again after few minutes`);
            return;
        }

        data = await res.json();
        doctors = data.doctors
        
        categories = data.categories;
        loadFilterOptions();
        renderDoctors();
    } catch (err) {
        console.error("Fetch error:", err);
        alert("Failed to fetch doctors: Network or server error");
    }
}


function loadFilterOptions() {
    filter.innerHTML = `<option value="all">All Categories</option>`;
    categories.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = c;
        filter.appendChild(opt);
    });
}

function renderDoctors() {
    const filtered = doctors.filter(d => currentCategory === 'all' || d.category === currentCategory);
    const start = (currentPage - 1) * perPage;
    const paginated = filtered.slice(start, start + perPage);
    container.innerHTML = '';

    paginated.forEach(d => {
        const div = document.createElement('div');
        div.className = 'col-md-3 doctor-card';
        const imgSrc = d.photo_url || '../img/team/team02.png';

        div.innerHTML = `
            <img src="${imgSrc}" alt="${d.name}" onerror="this.src='../img/team/team02.png'" class="img-fluid rounded-circle mb-2">
            <h5>${d.name}</h5>
            <p><strong>Specialization:</strong> ${d.specialization}<br>
              <strong>Exp:</strong> ${d.experience_yr} yrs<br>
              <strong>Phone:</strong> ${d.phone || '-'}</p>
            <button class="btn btn-warning btn-sm me-1" onclick="editDoctor('${d.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteDoctor('${d.id}')">Delete</button>
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

filter.addEventListener('change', e => {
    currentCategory = e.target.value;
    currentPage = 1;
    renderDoctors();
});

// Wait for DOM to load
document.addEventListener('DOMContentLoaded', () => {
    const addForm = document.getElementById('addDoctorForm');
    if (!addForm) return; // safety check

    addForm.addEventListener('submit', async e => {
        e.preventDefault();
        const formData = new FormData(addForm);

        try {
            const res = await fetch('http://www.api.nsghbd.com/doctors/add', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(errText);
            }

            alert("Doctor added!");
            addForm.reset();

            // Hide modal
            const addModalEl = document.getElementById('addDoctorModal');
            const addModal = bootstrap.Modal.getInstance(addModalEl);
            addModal.hide();

            loadDoctors();
        } catch (err) {
            console.error(err);
            alert("Failed to add doctor: " + err.message);
        }
    });
});

document.getElementById('editDoctorForm').addEventListener('submit', async e => {
    e.preventDefault();

    const id = document.getElementById('editDoctorId').value;
    const formData = new FormData();
    formData.append('name', document.getElementById('editName').value);
    formData.append('specialization', document.getElementById('editSpecialization').value);
    formData.append('category', document.getElementById('editCategory').value);
    formData.append('experience', document.getElementById('editExperience').value);
    formData.append('description', document.getElementById('editDescription').value);
    formData.append('phone', document.getElementById('editPhone').value);

    const photoInput = document.getElementById('editPhoto');
    if (photoInput.files.length > 0) {
        formData.append('photo', photoInput.files[0]);
    }

    try {
        const res = await fetch(`http://www.api.nsghbd.com/doctors/update/${id}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText);
        }

        alert("Doctor updated!");
        editModal.hide();
        loadDoctors();
    } catch (err) {
        console.error(err);
        alert("Failed to update doctor: " + err.message);
    }
});



// Delete Doctor
async function deleteDoctor(id) {
    if (!confirm("Delete this doctor?")) return;
    try {
        await fetch(`http://www.api.nsghbd.com/doctors/${id}`, {
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

// Edit Doctor
function editDoctor(id) {
    const d = doctors.find(x => x.id == id);
    if (!d) return;

    document.getElementById('editDoctorId').value = d.id;
    document.getElementById('editName').value = d.name;
    document.getElementById('editSpecialization').value = d.specialization;
    document.getElementById('editCategory').value = d.category;
    document.getElementById('editExperience').value = d.experience_yr;
    document.getElementById('editPhone').value = d.phone || '';
    document.getElementById('editDescription').value = d.description || '';

    editModal.show();
}

// Initial load
loadDoctors();