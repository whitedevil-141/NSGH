from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
import jwt
from api.database import get_db
from api.models import AppointmentUser, User
from api.utils.jwt_handler import JWT_SECRET, JWT_ALGORITHM

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")

def decode_access_token(token: str) -> dict:
    """Validate the same token requirements for every protected router."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(
            token, JWT_SECRET, algorithms=[JWT_ALGORITHM],
            options={"require": ["exp", "user_id", "role"]},
        )
        if not isinstance(payload.get("user_id"), str) or not payload["user_id"]:
            raise credentials_exception
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.PyJWTError:
        raise credentials_exception


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    """Resolve the account in its token scope and use its current permissions."""
    payload = decode_access_token(token)
    scope = payload.get("scope")
    if scope == "appointment":
        user = db.get(AppointmentUser, payload["user_id"])
    elif scope in (None, "dashboard"):
        # Tokens issued before dashboard scope was added remain valid until expiry.
        user = db.get(User, payload["user_id"])
    else:
        user = None
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if user.role == "commission_sms":
        raise HTTPException(status_code=403, detail="Use the commission SMS panel for this account")
    return {**payload, "role": user.role}


def get_current_admin(current_user: dict = Depends(get_current_user)):
    if current_user["role"] != "admin":
        raise HTTPException(status_code=403, detail="You do not have permission for this action")
    return current_user
