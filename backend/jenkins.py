import re
from typing import Any

import httpx
from fastapi import HTTPException

from config import settings

# Jenkins uses self-signed certs on internal instances
_CLIENT_DEFAULTS = {"verify": False, "timeout": 30.0}


class JenkinsClient:
    def __init__(self, username: str, token: str):
        self.base = settings.jenkins_url.rstrip("/")
        self.auth = (username, token)

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(auth=self.auth, **_CLIENT_DEFAULTS)

    @staticmethod
    def _check_auth(response: httpx.Response) -> None:
        """Raise a clean 401 HTTPException if Jenkins rejects the credentials."""
        if response.status_code == 401:
            raise HTTPException(
                status_code=401,
                detail="Jenkins rejected your credentials — your token may be wrong for this Jenkins instance. Please log in again.",
            )

    async def validate(self) -> dict:
        username = self.auth[0]
        url = f"{self.base}/user/{username}/api/json"
        async with self._client() as c:
            r = await c.get(url)
            if r.status_code == 200:
                return r.json()
            # Some Jenkins instances (SSO-only) reject Basic Auth but allow anonymous reads.
            # Fall back to an unauthenticated check to confirm the user exists.
            if r.status_code in (401, 403):
                anon = httpx.AsyncClient(**_CLIENT_DEFAULTS)
                async with anon:
                    r2 = await anon.get(url)
                if r2.status_code == 200:
                    return r2.json()
            r.raise_for_status()
            return r.json()

    async def get_build(self, job: str, build_num: int) -> dict:
        async with self._client() as c:
            r = await c.get(f"{self.base}/job/{job}/{build_num}/api/json")
        if r.status_code in (401, 403):
            async with httpx.AsyncClient(**_CLIENT_DEFAULTS) as anon:
                r = await anon.get(f"{self.base}/job/{job}/{build_num}/api/json")
        r.raise_for_status()
        return r.json()

    async def get_job(self, job: str) -> dict:
        async with self._client() as c:
            r = await c.get(f"{self.base}/job/{job}/api/json")
            r.raise_for_status()
            return r.json()

    async def get_job_builds(self, job: str, limit: int = 50) -> list[dict]:
        url    = f"{self.base}/job/{job}/api/json"
        params = {"tree": f"builds[number,result,building,timestamp,description,duration]{{0,{limit}}}"}
        async with self._client() as c:
            r = await c.get(url, params=params)
        if r.status_code == 200:
            return r.json().get("builds", [])
        # SSO-only Jenkins rejects Basic Auth but allows anonymous reads (same as validate())
        if r.status_code in (401, 403):
            async with httpx.AsyncClient(**_CLIENT_DEFAULTS) as anon:
                r2 = await anon.get(url, params=params)
            if r2.status_code == 200:
                return r2.json().get("builds", [])
        self._check_auth(r)
        r.raise_for_status()
        return []

    async def get_build_params(self, job: str, build_num: int) -> dict:
        build = await self.get_build(job, build_num)
        for action in build.get("actions", []):
            if action.get("_class") == "hudson.model.ParametersAction":
                return {p["name"]: p.get("value") for p in action.get("parameters", [])}
        return {}

    async def get_job_params_schema(self, job: str) -> list[dict]:
        async with self._client() as c:
            r = await c.get(f"{self.base}/job/{job}/api/json")
            r.raise_for_status()
            data = r.json()
        for prop in data.get("property", []):
            if "parameterDefinitions" in prop:
                return prop["parameterDefinitions"]
        return []

    async def _get_crumb(self) -> dict:
        """Fetch Jenkins CSRF crumb. Returns header dict or {} if crumb not required."""
        try:
            async with self._client() as c:
                r = await c.get(f"{self.base}/crumbIssuer/api/json")
            print(f"[CRUMB] status={r.status_code}", flush=True)
            if r.status_code == 200:
                data = r.json()
                return {data["crumbRequestField"]: data["crumb"]}
        except Exception as e:
            print(f"[CRUMB] exception: {e}", flush=True)
        return {}

    async def trigger_job(self, job: str, params: dict) -> int:
        crumb = await self._get_crumb()
        async with self._client() as c:
            r = await c.post(
                f"{self.base}/job/{job}/buildWithParameters",
                data=params,
                headers=crumb,
            )
        if not r.is_success:
            body = r.text[:500]
            raise httpx.HTTPStatusError(
                f"{r.status_code} from {r.url} — {body}",
                request=r.request,
                response=r,
            )
        # Jenkins returns queue item URL in Location header
        location = r.headers.get("Location", "")
        match = re.search(r"/queue/item/(\d+)/", location)
        return int(match.group(1)) if match else 0

    async def abort_build(self, job: str, build_num: int) -> None:
        crumb = await self._get_crumb()
        async with self._client() as c:
            r = await c.post(
                f"{self.base}/job/{job}/{build_num}/stop",
                headers=crumb,
            )
            r.raise_for_status()

    async def list_agents(self) -> list[dict]:
        async with self._client() as c:
            r = await c.get(
                f"{self.base}/computer/api/json",
                params={"tree": "computer[displayName,offline,idle,description]"},
            )
            self._check_auth(r)
            r.raise_for_status()
            return r.json().get("computer", [])

    async def get_all_jobs(self) -> list[dict]:
        async with self._client() as c:
            r = await c.get(
                f"{self.base}/api/json",
                params={"tree": "jobs[name,url,description,_class]"},
            )
        if r.status_code in (401, 403):
            # SSO-only Jenkins rejects Basic Auth — retry anonymously
            async with httpx.AsyncClient(timeout=30, verify=False) as c:
                r = await c.get(
                    f"{self.base}/api/json",
                    params={"tree": "jobs[name,url,description,_class]"},
                )
        r.raise_for_status()
        return r.json().get("jobs", [])

    @staticmethod
    def parse_build_description(description: str) -> dict:
        """Extract kubeconfig URL, console URL, password, IP, logs from build HTML description."""
        if not description:
            return {}

        result = {}
        patterns = {
            "kubeconfig_url": r'kubeconfig[^"]*href="([^"]+auth/kubeconfig[^"]*)"',
            "console_url": r'Web Console[^"]*href="([^"]+)"',
            "kubeadmin_password": r"Password:</b>\s*([^\s<]+)",
            "agent_ip": r"Jenkins slave IP:</b>\s*([^\s<]+)",
            "logs_url": r'Logs[^"]*href="([^"]+)"',
        }
        for key, pattern in patterns.items():
            m = re.search(pattern, description)
            if m:
                result[key] = m.group(1).strip()

        return result
