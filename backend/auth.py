from fastapi import Cookie, HTTPException, Request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from config import settings

_serializer = URLSafeTimedSerializer(settings.secret_key)

COOKIE_NAME = "jenease_session"


def sign_session(username: str, token: str) -> str:
    return _serializer.dumps({"username": username, "token": token})


def unsign_session(value: str) -> dict:
    try:
        return _serializer.loads(value, max_age=settings.session_max_age)
    except SignatureExpired:
        raise HTTPException(status_code=401, detail="Session expired")
    except BadSignature:
        raise HTTPException(status_code=401, detail="Invalid session")


def get_session(request: Request) -> dict:
    cookie = request.cookies.get(COOKIE_NAME)
    if not cookie:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return unsign_session(cookie)
