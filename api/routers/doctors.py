import os
import uuid
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session
from typing import List, Optional
from api.database import get_db
from api.models import Doctor
from api.schemas import DoctorBase, DoctorOut
from api.utils.deps import get_current_user
from api.limiter import limiter, Request
import paramiko
import logging
import json

logger = logging.getLogger("uvicorn")
logger.setLevel(logging.INFO)

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


def upload_to_hosting(file: UploadFile):
    logger.info(f"Uploading file: {file.filename}")
    host = "94.130.22.223"
    port = 22
    username = "nsghbdco"
    password = "r7T)Bth7dEC#16"  # or use key authentication
    ext = os.path.splitext(file.filename)[1]
    filename = f"{uuid.uuid4().hex}{ext}"
    remote_path = f"/home/nsghbdco/public_html/img/team/{filename}"
    try:
        transport = paramiko.Transport((host, port))
        transport.connect(username=username, password=password)
        
        sftp = paramiko.SFTPClient.from_transport(transport)

        with file.file as f:
            sftp.putfo(f, remote_path)  # Upload the file-like object

        sftp.close()
        transport.close()
        
        return f"https://www.nsghbd.com/img/team/{filename}"
    except paramiko.AuthenticationException:
        raise HTTPException(status_code=401, detail="Authentication failed")
    except paramiko.SSHException as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
def delete_from_hosting(file_url: str):
    """
    Deletes a file from the remote server using SFTP.
    Expects the full URL of the file (e.g., https://www.nsghbd.com/img/team/filename.jpg)
    """
    # Extract the path relative to the server root
    # Example: https://www.nsghbd.com/img/team/filename.jpg -> /home/nsghbdco/public_html/img/team/filename.jpg
    filename = file_url.split("/")[-1]
    remote_path = f"/home/nsghbdco/public_html/img/team/{filename}"

    host = "94.130.22.223"
    port = 22
    username = "nsghbdco"
    password = "r7T)Bth7dEC#16"

    try:
        transport = paramiko.Transport((host, port))
        transport.connect(username=username, password=password)
        sftp = paramiko.SFTPClient.from_transport(transport)

        # Delete the file
        sftp.remove(remote_path)

        sftp.close()
        transport.close()
    except FileNotFoundError:
        # File already missing, ignore
        pass
    except paramiko.AuthenticationException:
        raise HTTPException(status_code=401, detail="Authentication failed")
    except paramiko.SSHException as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

from fastapi import Form

@router.post("/add")
async def add_doctor(
    name: str = Form(...),
    description: str = Form(None),
    hospital: str = Form(...),
    experience_yr: int = Form(...),
    room: str = Form(...),
    timing: str = Form(...),
    phone: str = Form(None),
    specialization: str = Form(...),  # comma-separated
    qualifications: str = Form(...),  # JSON string
    conditions: str = Form(...),      # JSON string
    photo: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db)
):
    try:
        # Example: upload logic
        photo_url = "test_url"
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Photo upload failed: {e}")

    # Convert strings to Python objects
    qualifications_list = []
    conditions_list = []
    specialization_list = [s.strip() for s in specialization.split(',') if s.strip()]
    try:
        qualifications_list = json.loads(qualifications)
    except Exception:
        qualifications_list = []

    try:
        conditions_list = json.loads(conditions)
    except Exception:
        conditions_list = []

    new_doc = Doctor(
        name=name,
        description=description,
        hospital=hospital,
        experience_yr=experience_yr,
        room=room,
        timing=timing,
        phone=phone,
        specialization=json.dumps(specialization_list),
        qualifications=json.dumps(qualifications_list),
        conditions=json.dumps(conditions_list),
        category=json.dumps(specialization_list),
        photo_url=photo_url
    )

    try:
        db.add(new_doc)
        db.commit()
        db.refresh(new_doc)
        return {"success": True, "doctor_id": new_doc.id}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/update/{doctor_id}", response_model=DoctorOut)
@limiter.limit("5/minute")
async def update_doctor(
    request: Request,
    doctor_id: int,
    name: str = Form(...),
    description: str = Form(None),
    hospital: str = Form(...),
    experience_yr: int = Form(...),
    room: str = Form(...),
    timing: str = Form(...),
    phone: str = Form(None),
    specialization: str = Form(...),       # comma-separated
    qualifications: str = Form(...),       # JSON string
    conditions: str = Form(...),           # JSON string
    photo: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db)
):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")

    # ---------------- Parse fields ----------------
    specialization_list = [s.strip() for s in specialization.split(',') if s.strip()]

    try:
        qualifications_list = json.loads(qualifications)
    except Exception:
        qualifications_list = []

    try:
        conditions_list = json.loads(conditions)
    except Exception:
        conditions_list = []

    # ---------------- Handle photo ----------------
    if photo:
        photo_url = upload_to_hosting(photo)
        doctor.photo_url = photo_url

    # ---------------- Update doctor ----------------
    doctor.name = name
    doctor.description = description
    doctor.hospital = hospital
    doctor.experience_yr = experience_yr
    doctor.room = room
    doctor.timing = timing
    doctor.phone = phone
    doctor.specialization = json.dumps(specialization_list)
    doctor.category = json.dumps(specialization_list)  # for filtering
    doctor.qualifications = json.dumps(qualifications_list)
    doctor.conditions = json.dumps(conditions_list)

    try:
        db.commit()
        db.refresh(doctor)

        # Convert JSON strings back to Python lists for the response
        return {
            "id": doctor.id,
            "name": doctor.name,
            "hospital": doctor.hospital,
            "experience_yr": doctor.experience_yr,
            "room": doctor.room,
            "timing": doctor.timing,
            "phone": doctor.phone,
            "description": doctor.description or "",
            "specialization": json.loads(doctor.specialization) if doctor.specialization else [],
            "category": json.loads(doctor.category) if doctor.category else [],
            "qualifications": json.loads(doctor.qualifications) if doctor.qualifications else [],
            "conditions": json.loads(doctor.conditions) if doctor.conditions else [],
            "photo_url": doctor.photo_url,
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{doctor_id}")
@limiter.limit("3/minute")
def delete_doctor(request: Request, doctor_id: int, db: Session = Depends(get_db)):
    doctor = db.query(Doctor).filter(Doctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")

    # Delete the file from server first
    # if doctor.photo_url:
    #     delete_from_hosting(doctor.photo_url)

    # Delete the database record
    db.delete(doctor)
    db.commit()

    return {"message": "Doctor deleted successfully"}
