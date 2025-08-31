# doctors_public.py
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from api.models import Doctor
from api.database import get_db
from api.schemas import DoctorPublic, DoctorsDataResponse, DoctorOut
from api.limiter import limiter, Request
import json

router = APIRouter(
    tags=["Public"]
)


@router.get("/doctors/get/{doctor_id}", response_model=DoctorOut)
async def get_doctor(doctor_id: int, db: Session = Depends(get_db)):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")

    # Convert JSON strings -> Python lists/dicts
    return {
        "id": doctor.id,
        "name": doctor.name,
        "description": doctor.description,
        "qualifications": json.loads(doctor.qualifications) if doctor.qualifications else [],
        "conditions": json.loads(doctor.conditions) if doctor.conditions else [],
        "phone": doctor.phone,
        "specialization": json.loads(doctor.specialization) if doctor.specialization else [],
        "hospital": doctor.hospital,
        "room": doctor.room,
        "timing": doctor.timing
    }


@router.get("/doctors/data", response_model=DoctorsDataResponse)
@limiter.limit("15/minute")
def fetch_public_data(request: Request, db: Session = Depends(get_db)):
    doctors = db.query(Doctor).all()
    doctors_data = []
    all_categories = set()

    for d in doctors:
        # Parse JSON fields
        qualifications = json.loads(d.qualifications) if d.qualifications else []
        conditions = json.loads(d.conditions) if d.conditions else []

        # Parse specialization safely
        try:
            category_list = json.loads(d.specialization) if d.specialization else []
            if not isinstance(category_list, list):
                category_list = [str(category_list)]
        except Exception:
            category_list = [s.strip() for s in d.specialization.split(",")] if d.specialization else []

        all_categories.update(category_list)

        doctors_data.append(
            DoctorPublic(
                id=d.id,
                name=d.name,
                specialization=d.specialization,  # can keep raw string for display
                description=d.description,
                category=category_list,           # now a proper list
                phone=d.phone,
                photo_url=d.photo_url,
                qualifications=qualifications,
                conditions=conditions,
                hospital=d.hospital,
                room=d.room,
                timing=d.timing
            )
        )

    return DoctorsDataResponse(
        doctors=doctors_data,
        categories=sorted(all_categories)
    )
