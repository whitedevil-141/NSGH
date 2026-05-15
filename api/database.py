import sys
import os

from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

if __package__ is None or __package__ == "":
    sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from api.utils.config import get_env


DATABASE_URL = get_env("DATABASE_URL")


_engine_kwargs = dict(
    pool_size=5,              # enough for one API process
    max_overflow=10,          # temporary extra connections
    pool_recycle=3600,        # reconnect every hour just in case
    pool_pre_ping=True,       # test & reconnect dropped connections automatically
)

# Force utf8mb4 on the MySQL connection so Bangla (and other multibyte) characters
# aren't replaced with "?" at write time. Safe to set even if the table charset is
# already utf8mb4. Without this, pymysql may negotiate latin1 and lossy-encode the
# text before it ever reaches the column.
if DATABASE_URL.startswith("mysql"):
    _engine_kwargs["connect_args"] = {"charset": "utf8mb4"}

engine = create_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
