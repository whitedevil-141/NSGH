# doctors_public.py
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from typing import List
from api.models import Doctor
from api.database import get_db
from api.schemas import DoctorPublic, DoctorsDataResponse
from api.limiter import limiter, Request
import json

router = APIRouter(
    tags=["Public"]
)

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
                experience_yr=d.experience_yr,
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
