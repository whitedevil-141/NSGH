import os

import requests
from fastapi import HTTPException

from api.utils.config import load_env


AUTOMAS_SMS_URL = "https://api.automas.com.bd/smsapiv3"


def send_sms(number: str, message: str) -> dict:
    load_env()

    api_key = "6060a92efeb1296ea7722c9c3f6bd558"
    sender_id = "8809617640056"

    if not api_key or not sender_id:
        raise HTTPException(
            status_code=500,
            detail="SMS provider is not configured",
        )

    params = {
        "apikey": api_key,
        "sender": sender_id,
        "msisdn": number,
        "smstext": message,
    }

    try:
        response = requests.get(
            AUTOMAS_SMS_URL,
            params=params,
            timeout=10,
        )
        response.raise_for_status()
    except requests.RequestException:
        raise HTTPException(
            status_code=502,
            detail="SMS provider request failed",
        )

    # AutoMAS may return a plain-text response rather than JSON.
    try:
        provider_response = response.json()
    except ValueError:
        provider_response = {
            "raw": response.text,
            "status_code": response.status_code,
        }

    return provider_response