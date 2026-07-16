import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from sqlmodel import SQLModel

from config import settings
from database import engine
from jenkins import JenkinsClient
from routers import auth as auth_router
from routers import clusters as clusters_router
from routers import agents as agents_router
from routers import names as names_router
from routers import jobs as jobs_router
from routers import workloads as workloads_router
from routers import rlocker as rlocker_router
from routers.jobs import _build_catalog, _catalog, _catalog_ts
import routers.jobs as jobs_module


async def _warm_catalog():
    """Build the job catalog at startup using a minimal service account."""
    # We need a JenkinsClient but have no user session at startup.
    # Use the server's configured Jenkins URL and a dummy client — the catalog
    # only needs unauthenticated read access to job lists/params.
    # If Jenkins requires auth for params, this silently skips; the first real
    # user request will build it instead.
    try:
        print("[startup] Warming job catalog in background…", flush=True)
        # Import the module-level token from env if available
        import os
        token = os.environ.get("JENKINS_WARM_TOKEN", "")
        username = os.environ.get("JENKINS_WARM_USER", "")
        if not token or not username:
            print("[startup] No JENKINS_WARM_TOKEN/USER set — catalog will build on first Deploy visit", flush=True)
            return
        jenkins = JenkinsClient(username, token)
        catalog = await _build_catalog(jenkins)
        jobs_module._catalog = catalog
        jobs_module._catalog_ts = __import__('time').time()
        print(f"[startup] Catalog ready: {len(catalog)} jobs", flush=True)
    except Exception as e:
        print(f"[startup] Catalog warm failed (will build on first visit): {e}", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    SQLModel.metadata.create_all(engine)
    # Kick off catalog build in background — doesn't block startup
    asyncio.create_task(_warm_catalog())
    yield


app = FastAPI(title="Jenease", lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5199"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router)
app.include_router(clusters_router.router)
app.include_router(agents_router.router)
app.include_router(names_router.router)
app.include_router(jobs_router.router)
app.include_router(workloads_router.router)
app.include_router(rlocker_router.router)


@app.get("/api/health")
async def health():
    catalog_size = len(jobs_module._catalog)
    return {"status": "ok", "catalog_jobs": catalog_size}
