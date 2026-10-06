import uuid
from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm, OAuth2PasswordBearer
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from api import crud, models, database
from api.utils.jwt_handler import create_access_token
from api.utils.security import hash_password, verify_password
from api.utils.deps import get_current_admin, get_current_user
from api.schemas import RegisterRequest
from api.limiter import limiter
from fastapi import Request

router = APIRouter()


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")
# ==========================
# LOGIN ENDPOINT
# ==========================
@router.post("/login", tags=["Auth"])
@limiter.limit("5/minute")
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
                "scope": "dashboard",
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
@router.get("/me", tags=["Auth"])
def current_account(current_user: dict = Depends(get_current_user)):
    return {key: current_user.get(key) for key in ("user_id", "sub", "role", "scope")}


@router.post("/register", status_code=status.HTTP_201_CREATED, tags=["Auth"])
@limiter.limit("3/minute")
def register_user(request: Request, data: RegisterRequest, current_user=Depends(get_current_admin)):
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
