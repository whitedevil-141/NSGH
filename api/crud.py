from sqlalchemy.orm import Session
from . import models

# --------------------------
# User CRUD
# --------------------------

def get_user_by_username(db: Session, username: str):
    """Fetch a user by username"""
    return db.query(models.User).filter(models.User.username == username).first()

def create_user(db: Session, username: str, hashed_password: str, role: str = "user"):
    from uuid import uuid4
    user_id = uuid4().hex
    new_user = models.User(
        user_id=user_id,
        username=username,
        password=hashed_password,
        role=role
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user
