import os
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session
from typing import List
from api.database import get_db
from api.models import Doctor
from api.schemas import DoctorBase, DoctorOut
from api.utils.deps import get_current_user
from api.limiter import limiter, Request

router = APIRouter(
    tags=["Doctors"],
    dependencies=[Depends(get_current_user)]  # ✅ protect all routes
)

# -------------------- ROUTES --------------------

@router.get("/get/{doctor_id}", response_model=DoctorOut)
@limiter.limit("15/minute")
def get_doctor(request: Request, doctor_id: int, db: Session = Depends(get_db)):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    return doctor


UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "img")
os.makedirs(UPLOAD_DIR, exist_ok=True) # path relative to dashboard.html
@router.post("/add", response_model=DoctorOut, status_code=status.HTTP_201_CREATED)
def create_doctor(
    request: Request,
    name: str = Form(...),
    specialization: str = Form(...),
    category: str = Form(...),
    experience: int = Form(...),
    description: str = Form(None),
    phone: str = Form(None),
    photo: UploadFile = File(...),
    db: Session = Depends(get_db)
):
    # Save the uploaded file
    file_location = os.path.join(UPLOAD_DIR, photo.filename)
    with open(file_location, "wb") as f:
        f.write(photo.file.read())
    try:
        # Create DB entry
        new_doc = Doctor(
            name=name,
            specialization=specialization,
            category=category,
            experience_yr=experience,
            description=description,
            phone=phone,
            photo_url=f"../img/{photo.filename}"  # relative path for frontend
        )
        db.add(new_doc)
        db.commit()
        db.refresh(new_doc)
        return new_doc
    except Exception as e:
        db.rollback()
        print(e)
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/update/{doctor_id}", response_model=DoctorOut)
@limiter.limit("5/minute")
def update_doctor(
    request: Request,
    doctor_id: int,
    name: str = Form(...),
    specialization: str = Form(...),
    category: str = Form(...),
    experience: int = Form(...),
    description: str = Form(None),
    phone: str = Form(None),
    photo: UploadFile = File(None),  # Optional
    db: Session = Depends(get_db)
):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    try:
        # Update fields
        doctor.name = name
        doctor.specialization = specialization
        doctor.category = category
        doctor.experience_yr = experience
        doctor.description = description
        doctor.phone = phone

        # Handle photo if provided
        if photo:
            file_location = os.path.join(UPLOAD_DIR, photo.filename)
            with open(file_location, "wb") as f:
                f.write(photo.file.read())
            doctor.photo_url = f"../img/{photo.filename}"

        db.commit()
        db.refresh(doctor)
        return doctor
    except Exception as e:
        db.rollback()
        print(e)
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{doctor_id}")
@limiter.limit("3/minute")
def delete_doctor(request: Request, doctor_id: int, db: Session = Depends(get_db)):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    db.delete(doctor)
    db.commit()
    return {"message": "Doctor deleted successfully"}
