from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

DATABASE_URL = "mysql+pymysql://nsghbd_admin:U4p79y8Xq2@localhost/nsghbd_main"

engine = create_engine(
    DATABASE_URL,
    pool_size=5,              # enough for one API process
    max_overflow=10,          # temporary extra connections
    pool_recycle=3600,        # reconnect every hour just in case
    pool_pre_ping=True        # test & reconnect dropped connections automatically
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()