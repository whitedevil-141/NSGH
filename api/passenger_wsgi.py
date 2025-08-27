import sys
import os

# Add the API folder to the Python path
sys.path.insert(0, os.path.dirname(__file__))

# Import your FastAPI app
from main import app  # assuming main.py has `app = FastAPI()`

# Use Mangum ASGI → WSGI adapter for Passenger
try:
    from mangum import Mangum
    application = Mangum(app)
except ImportError:
    # fallback: in case Mangum is not installed, Passenger will attempt to run app directly
    application = app
