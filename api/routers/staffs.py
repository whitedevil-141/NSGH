from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session
from typing import Optional
from api.database import get_db
from api.models import Staff
from api.schemas import StaffPublic
from api.utils.deps import get_current_user
from api.limiter import limiter
from fastapi import Request
from api.utils.image_handler import upload_to_hosting, delete_from_hosting


router = APIRouter(
    tags=["Staffs"],
    dependencies=[Depends(get_current_user)]
)


@router.post("/add")
async def add_staff(
    name: str = Form(...),
    designation: str = Form(None),
    phone: str = Form(None),
    photo: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db)
):
    photo_url = None
    if photo:
        try:
            photo_url = upload_to_hosting(photo)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Photo upload failed: {e}")

    new_staff = Staff(
        name=name,
        designation=designation,
        phone=phone,
        photo_url=photo_url
    )

    try:
        db.add(new_staff)
        db.commit()
        db.refresh(new_staff)
        return {"success": True, "staff_id": new_staff.id}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/update/{staff_id}", response_model=StaffPublic)
@limiter.limit("5/minute")
async def update_staff(
    request: Request,
    staff_id: int,
    name: str = Form(...),
    designation: str = Form(None),
    phone: str = Form(None),
    photo: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db)
):
    staff = db.query(Staff).filter(Staff.id == staff_id).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff not found")

    # ---------------- Handle photo ----------------
    
    if photo:
        staff.photo_url = upload_to_hosting(photo)
    # ---------------- Update staff ----------------
    staff.name = name
    staff.designation = designation
    staff.phone = phone

    try:
        db.commit()
        db.refresh(staff)

        return {
            "id": staff.id,
            "name": staff.name,
            "designation": staff.designation,
            "phone": staff.phone,
            "photo_url": staff.photo_url,
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{staff_id}")
@limiter.limit("3/minute")
def delete_staff(request: Request, staff_id: int, db: Session = Depends(get_db)):
    staff = db.query(Staff).filter(Staff.id == staff_id).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff not found")

    if staff.photo_url:
        delete_from_hosting(staff.photo_url)

    # Delete the database record
    db.delete(staff)
    db.commit()

    return {"message": "Staff deleted successfully"}
