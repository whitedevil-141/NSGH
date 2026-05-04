import uuid
from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm, OAuth2PasswordBearer
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

import crud, models, database
from utils.jwt_handler import create_access_token
from utils.security import hash_password, verify_password
from schemas import RegisterRequest
from limiter import limiter, Request

router = APIRouter()


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")
# ==========================
# LOGIN ENDPOINT
# ==========================
@limiter.limit("5/minute")
@router.post("/login", tags=["Auth"])
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends()):
    with database.SessionLocal() as db:
        user = crud.get_user_by_username(db, form_data.username)
        if not user or not verify_password(form_data.password, user.password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect username or password",
                headers={"WWW-Authenticate": "Bearer"},
            )

        expires_delta = timedelta(hours=1)
        token = create_access_token(
            data={
                "sub": user.username,
                "user_id": user.user_id,
                "role": user.role,  # optional: for admin/doctor separation
            },
            expires_delta=expires_delta,
        )
        return {
            "access_token": token,
            "token_type": "bearer",
            "expires_in": int(expires_delta.total_seconds()),
        }

# ==========================
# REGISTER ENDPOINT
# ==========================
@limiter.limit("3/minute")
@router.post("/register", status_code=status.HTTP_201_CREATED, tags=["Auth"])
def register_user(request: Request, data: RegisterRequest):
    with database.SessionLocal() as db:
        # check if username already exists
        existing = crud.get_user_by_username(db, data.username)
        if existing:
            raise HTTPException(status_code=400, detail="Username already registered")

        user_id = uuid.uuid4().hex[:5]

        new_user = models.User(
            user_id=user_id,
            username=data.username,
            password=hash_password(data.password),
            role=data.role if hasattr(data, "role") else "user",  # default role
        )

        try:
            db.add(new_user)
            db.commit()
            db.refresh(new_user)
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=400, detail="Username already exists")
        except SQLAlchemyError:
            db.rollback()
            raise HTTPException(status_code=500, detail="Database error occurred")
        except Exception:
            db.rollback()
            raise HTTPException(status_code=500, detail="Unexpected error occurred")

        return {
            "message": f"User '{data.username}' registered successfully!",
            "user_id": user_id,
        }
