import asyncio
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from httpx import HTTPStatusError
from sqlmodel import Session, select

from auth import COOKIE_NAME, get_session, sign_session
from config import settings
from database import engine
from jenkins import JenkinsClient
from models import LoginRequest, User, UserInfo

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
async def login(body: LoginRequest, response: Response):
    client = JenkinsClient(body.username, body.token)
    try:
        user_data = await client.validate()
    except HTTPStatusError as e:
        if e.response.status_code in (401, 403):
            raise HTTPException(status_code=401, detail="Invalid Jenkins credentials")
        raise HTTPException(status_code=502, detail="Jenkins unreachable")
    except Exception:
        raise HTTPException(status_code=502, detail="Jenkins unreachable")

    # Warm the job catalog in the background using the authenticated user's token
    async def _warm():
        import routers.jobs as jobs_module
        import time
        try:
            catalog = await jobs_module._build_catalog(client)
            ts = time.time()
            jobs_module._catalog = catalog
            jobs_module._catalog_ts = ts
            jobs_module._save_catalog_to_disk(catalog, ts)
        except Exception:
            pass
    asyncio.create_task(_warm())

    # Upsert user record so share/notification features can find them
    full_name = user_data.get("fullName", body.username)
    with Session(engine) as db:
        existing = db.exec(select(User).where(User.username == body.username)).first()
        if existing:
            existing.full_name = full_name
            existing.last_seen = datetime.utcnow()
            db.add(existing)
        else:
            db.add(User(username=body.username, full_name=full_name))
        db.commit()

    session_value = sign_session(body.username, body.token)
    response.set_cookie(
        key=COOKIE_NAME,
        value=session_value,
        httponly=True,
        samesite="lax",
        max_age=settings.session_max_age if body.remember else None,
        secure=False,  # set True when behind HTTPS
    )
    return UserInfo(
        username=body.username,
        full_name=user_data.get("fullName", body.username),
    )


@router.get("/me")
async def me(session: dict = Depends(get_session)):
    return UserInfo(username=session["username"])


@router.post("/logout")
async def logout(request: Request, response: Response):
    try:
        session = get_session(request)
        from routers.clusters import clear_user_cache
        clear_user_cache(session["username"])
    except Exception:
        pass
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True}
