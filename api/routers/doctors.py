from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import SessionLocal
from models import Doctor
from schemas import DoctorBase, DoctorOut
from typing import List

router = APIRouter(prefix="/doctors", tags=["Doctors"])

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.get("/", response_model=List[DoctorOut])
def get_doctors(db: Session = Depends(get_db)):
    return db.query(Doctor).all()

@router.get("/{doctor_id}", response_model=DoctorOut)
def get_doctor(doctor_id: int, db: Session = Depends(get_db)):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    return doctor

@router.post("/", response_model=DoctorOut)
def create_doctor(data: DoctorBase, db: Session = Depends(get_db)):
    new_doc = Doctor(**data.dict())
    db.add(new_doc)
    db.commit()
    db.refresh(new_doc)
    return new_doc

@router.put("/{doctor_id}", response_model=DoctorOut)
def update_doctor(doctor_id: int, data: DoctorBase, db: Session = Depends(get_db)):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    for key, value in data.dict().items():
        setattr(doctor, key, value)
    db.commit()
    db.refresh(doctor)
    return doctor

@router.delete("/{doctor_id}")
def delete_doctor(doctor_id: int, db: Session = Depends(get_db)):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    db.delete(doctor)
    db.commit()
    return {"message": "Doctor deleted"}
