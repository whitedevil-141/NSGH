async function loadDoctor() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (!id) {
        document.getElementById("doctor-card-container").innerHTML = "<p>Doctor not found</p>";
        return;
    }

    try {
        // fetch doctor info
        const res = await fetch(`https://api.nsghbd.com/public/doctors/get/${id}`);

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(errText);
            }

        const doc = await res.json();
        let specs = [];
        try {
            specs = Array.isArray(doc.specialization)
                ? doc.specialization
                : JSON.parse(doc.specialization || '[]'); // parse JSON string
        } catch (err) {
            console.warn("Invalid specialization JSON:", doc.specialization);
            specs = [];
        }
        const specializationStr = specs.length ? specs.join(', ') : '-';
        // normalize qualifications
        const qualifications = Array.isArray(doc.qualifications) ? doc.qualifications : [];


        document.getElementById('doctor-card-container').innerHTML = `
            <div class="doctor-card row align-items-center">
                <div class="col-md-4 text-center">
                    <img src="${doc.photo_url}" alt="Not Available" class="doctor-photo img-fluid">
                </div>
                <div class="col-md-8">
                    <h2 class="doctor-name">${doc.name}</h2>
                    <p class="doctor-speciality">${specializationStr}</p>
                    <p class="doctor-description">${doc.description}</p>
                    <p>${qualifications.map(q => `${q}<br>`).join('')}</p>
                    <div class="info-list mt-3">
                        <p><i class="fas fa-hospital"></i> ${doc.hospital}</p>
                        <p><i class="fas fa-door-open"></i>Room No: ${doc.room}</p>
                        <p><i class="fas fa-clock"></i> ${doc.timing}</p>
                    </div>
                    <a href="tel:${doc.phone}" class="btn ss-btn mt-3">📞 Call Now</a>
                </div>
            </div>`;
        
        // render conditions
        renderConditions(doc.conditions || []);
    } catch (err) {
        console.error("Error loading doctor:", err);
        document.getElementById("doctor-card-container").innerHTML = "<p>Failed to load doctor data.</p>";
    }
}

function renderConditions(conditions) {
    const container = document.getElementById("conditions-container");
    container.innerHTML = ""; // clear previous

    conditions.forEach(cond => {
        const card = document.createElement("div");
        card.className = "col-md-4 col-sm-6 col-12";
        card.innerHTML = `
            <div class="card condition-card h-100 text-center">
                <div class="card-body">
                    <h5>${cond.icon || "🩺"} ${cond.title}</h5>
                    <p>${cond.description}</p>
                </div>
            </div>`;
        container.appendChild(card);
    });
}

loadDoctor();
