// Example dynamic JSON from backend
const doctorData = {
    name: "Prof. Dr. M. S. Zahidul Haque Chowdhury",
    speciality: "Neurology Specialist",
    qualifications: [
        "MBBS, BCS (Health), MD (Neurology, BSMMU)",
        "Fellowship (Epilepsy, USA), Training in Movement Disorder & Neuromuscular (India)"
    ],
    hospital: "Ibn Sina Diagnostic & Consultation Center, Dhanmondi",
    room: "147",
    timing: "Friday (6:00 PM – 9:00 PM)",
    photo_url: "img/team01.png",
    phone: "+8801711902062"
};

const conditions = [
    { icon: "🧠", title: "Headache / Migraine", description: "Chronic headache, migraine, cluster headache." },
    { icon: "⚡", title: "Seizures / Epilepsy", description: "Epileptic seizures and post-seizure care." },
    { icon: "💤", title: "Sleep Disorders", description: "Insomnia, excessive sleep, and other sleep-related problems." },
    { icon: "🧓", title: "Dementia / Memory Loss", description: "Alzheimer’s disease, dementia, memory-related issues." },
    { icon: "🦵", title: "Stroke / Paralysis", description: "Stroke management and rehabilitation." },
    { icon: "🦠", title: "Neurological Disorders", description: "Parkinson’s, movement disorders, neuromuscular diseases." },
    { icon: "🧓", title: "Dementia / Memory Loss", description: "Alzheimer’s disease, dementia, memory-related issues." },
    { icon: "🦵", title: "Stroke / Paralysis", description: "Stroke management and rehabilitation." },
    { icon: "🦠", title: "Neurological Disorders", description: "Parkinson’s, movement disorders, neuromuscular diseases." }
];

// Render Doctor Info
const doctorContainer = document.getElementById('doctor-card-container');
doctorContainer.innerHTML = `
<div class="doctor-card row align-items-center">
    <div class="col-md-4 text-center">
        <img src="${doctorData.photo_url}" alt="Doctor Photo" class="doctor-photo img-fluid">
    </div>
    <div class="col-md-8">
        <h2 class="doctor-name">${doctorData.name}</h2>
        <p class="doctor-speciality">${doctorData.speciality}</p>
        <p>${doctorData.qualifications.map(q => `${q}</br>`).join('')}</p>
        <div class="info-list mt-3">
            <p><i class="fas fa-hospital"></i> ${doctorData.hospital}</p>
            <p><i class="fas fa-door-open"></i> Room No: ${doctorData.room}</p>
            <p><i class="fas fa-clock"></i> ${doctorData.timing}</p>
        </div>
        <a  href="tel:${doctorData.phone}"  class="btn ss-btn mt-3">
            📞 Call Now
        </a>
    </div>
</div>`;

// Render Conditions Dynamically
const conditionsContainer = document.getElementById('conditions-container');
conditions.forEach(cond => {
    const card = document.createElement('div');
    card.className = 'col-md-4 col-sm-6 col-12';
    card.innerHTML = `
        <div class="card condition-card h-100 text-center">
            <div class="card-body">
                <h5>${cond.icon} ${cond.title}</h5>
                <p>${cond.description}</p>
            </div>
        </div>`;
    conditionsContainer.appendChild(card);
});


