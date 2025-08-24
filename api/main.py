from fastapi import FastAPI, Response
from api.database import engine, Base
from api.routers import auth,doctors, gallery, machineries, departments, about
from api.limiter import limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

# Create all tables
Base.metadata.create_all(bind=engine)

app = FastAPI(title="NSGH Hospital Backend API")


# attach limiter
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, lambda request, exc: Response(
    "Too Many Requests", status_code=429
))
app.add_middleware(SlowAPIMiddleware)


# Register routers
app.include_router(auth.router)
app.include_router(doctors.router)
# app.include_router(gallery.router)
# app.include_router(machineries.router)
# app.include_router(departments.router)
# app.include_router(about.router)
