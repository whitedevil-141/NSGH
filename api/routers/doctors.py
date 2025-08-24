from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from api.database import SessionLocal
from api.models import Doctor
from api.schemas import DoctorBase, DoctorOut
from api.utils.deps import get_current_user
from api.limiter import limiter, Request

router = APIRouter(
    prefix="/doctors",
    tags=["Doctors"],
    dependencies=[Depends(get_current_user)]  # ✅ protect all routes
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# -------------------- ROUTES --------------------

@router.get("/", response_model=List[DoctorOut])
@limiter.limit("10/minute")
def get_doctors(request: Request, db: Session = Depends(get_db)):
    return db.query(Doctor).all()

@router.get("/{doctor_id}", response_model=DoctorOut)
@limiter.limit("15/minute")
def get_doctor(request: Request, doctor_id: int, db: Session = Depends(get_db)):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    return doctor

@router.post("/", response_model=DoctorOut, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
def create_doctor(request: Request, data: DoctorBase, db: Session = Depends(get_db)):
    new_doc = Doctor(**data.model_dump())
    db.add(new_doc)
    db.commit()
    db.refresh(new_doc)
    return new_doc

@router.put("/{doctor_id}", response_model=DoctorOut)
@limiter.limit("5/minute")
def update_doctor(
    request: Request,
    doctor_id: int,
    data: DoctorBase,
    db: Session = Depends(get_db)
):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")

    # ✅ update only fields provided
    for key, value in data.model_dump().items():
        setattr(doctor, key, value)

    db.commit()
    db.refresh(doctor)
    return doctor

@router.delete("/{doctor_id}")
@limiter.limit("3/minute")
def delete_doctor(request: Request, doctor_id: int, db: Session = Depends(get_db)):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    db.delete(doctor)
    db.commit()
    return {"message": "Doctor deleted successfully"}
