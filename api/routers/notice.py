from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from api.database import get_db
from api.models import Notice
from api.schemas import NoticeCreate, NoticeOut, NoticeUpdate
from api.utils.deps import get_current_user


router = APIRouter(tags=["Notice"])


@router.get("/notices", response_model=list[NoticeOut])
def list_notices(db: Session = Depends(get_db)):
    return db.query(Notice).order_by(Notice.id.desc()).all()


@router.get("/notices/active", response_model=list[NoticeOut])
def list_active_notices(db: Session = Depends(get_db)):
    return db.query(Notice).filter(Notice.is_active == 1).order_by(Notice.id.desc()).all()


@router.post("/notices", response_model=NoticeOut, status_code=status.HTTP_201_CREATED)
def create_notice(data: NoticeCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    notice = Notice(
        title=data.title,
        content=data.content,
        is_active=1 if data.is_active else 0,
        created_at=datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
    )
    db.add(notice)
    db.commit()
    db.refresh(notice)
    return notice


@router.put("/notices/{notice_id}", response_model=NoticeOut)
def update_notice(notice_id: int, data: NoticeUpdate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    notice = db.query(Notice).filter(Notice.id == notice_id).first()
    if not notice:
        raise HTTPException(status_code=404, detail="Notice not found")
    notice.title = data.title
    notice.content = data.content
    notice.is_active = 1 if data.is_active else 0
    db.commit()
    db.refresh(notice)
    return notice


@router.delete("/notices/{notice_id}")
def delete_notice(notice_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    notice = db.query(Notice).filter(Notice.id == notice_id).first()
    if not notice:
        raise HTTPException(status_code=404, detail="Notice not found")
    db.delete(notice)
    db.commit()
    return {"message": "Notice deleted successfully"}
