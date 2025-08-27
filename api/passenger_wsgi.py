import sys, os

# Add the bundled dependencies to sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'python'))

from fastapi import FastAPI
from fastapi.middleware.wsgi import WSGIMiddleware

# Import your FastAPI app (assume it's in main.py as `app`)
from main import app as fastapi_app

# Wrap FastAPI in WSGI for Passenger
app = WSGIMiddleware(fastapi_app)
