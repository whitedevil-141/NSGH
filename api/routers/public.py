# doctors_public.py
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from typing import List
from api.models import Doctor
from api.database import get_db
from api.schemas import DoctorPublic
from api.limiter import limiter, Request

router = APIRouter(
    tags=["Public"]
)

@router.get("/doctors/data", response_model=dict)
@limiter.limit("15/minute")
def fetch_public_data(request: Request, db: Session = Depends(get_db)):
    doctors = db.query(Doctor).all()

    doctors_data = [
        {
            "id": d.id,
            "name": d.name,
            "specialization": d.specialization,
            "description":d.description,
            "category": d.category,
            "phone":d.phone,
            "experience_yr": d.experience_yr,
            "photo_url": d.photo_url,
        }
        for d in doctors
    ]
    
    categories = sorted({d['category'] for d in doctors_data})


    return {
        "doctors": doctors_data,
        "categories": categories
    }