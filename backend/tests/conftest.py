"""Shared pytest fixtures for JenEase backend tests."""
import os
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlmodel import SQLModel, create_engine, Session

# Point at in-memory SQLite before importing anything that touches the DB
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-testing-only")
os.environ.setdefault("JENKINS_URL", "https://jenkins-csb-odf-qe-stage.dno.corp.redhat.com")

from auth import COOKIE_NAME, sign_session
from database import engine as _prod_engine
from main import app
import database


TEST_ENGINE = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})

TEST_USERNAME = os.environ.get("JENKINS_TEST_USER", "srozen")
TEST_TOKEN    = os.environ.get("JENKINS_TEST_TOKEN", "")


@pytest.fixture(autouse=True)
def use_test_db(monkeypatch):
    """Replace the prod DB engine with an in-memory SQLite for every test."""
    SQLModel.metadata.create_all(TEST_ENGINE)
    monkeypatch.setattr(database, "engine", TEST_ENGINE)
    yield
    SQLModel.metadata.drop_all(TEST_ENGINE)


def make_session_cookie(username: str = TEST_USERNAME, token: str = "fake-token") -> str:
    return sign_session(username, token)


@pytest_asyncio.fixture
async def client():
    """Unauthenticated test client."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def authed_client():
    """Test client with a valid session cookie pre-injected (fake token — no Jenkins calls)."""
    cookie = make_session_cookie()
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        cookies={COOKIE_NAME: cookie},
    ) as c:
        yield c


needs_jenkins = pytest.mark.skipif(
    not os.environ.get("JENKINS_TEST_TOKEN"),
    reason="set JENKINS_TEST_TOKEN and JENKINS_TEST_USER to run Jenkins integration tests",
)


@pytest_asyncio.fixture
async def jenkins_client():
    """Test client with REAL Jenkins credentials — hits actual Jenkins API.
    Skip any test using this fixture if JENKINS_TEST_TOKEN is not set.
    """
    if not TEST_TOKEN:
        pytest.skip("JENKINS_TEST_TOKEN not set")
    cookie = make_session_cookie(username=TEST_USERNAME, token=TEST_TOKEN)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        cookies={COOKIE_NAME: cookie},
    ) as c:
        yield c
