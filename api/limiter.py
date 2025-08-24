from slowapi import Limiter
from slowapi.util import get_remote_address
from fastapi import Request

# Rate limiter (IP-based)
limiter = Limiter(key_func=get_remote_address)
