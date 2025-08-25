from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

DATABASE_URL = "mysql+pymysql://admin:Admin%401234@localhost/hospital_db"

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_engine(db_url: str):
    """Create a SQLAlchemy engine"""
    return create_engine(db_url, pool_pre_ping=True)

def get_session(db_url: str):
    """Return a session factory bound to the engine"""
    engine = get_engine(db_url)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()