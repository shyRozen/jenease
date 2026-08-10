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

    async def get_job_builds(self, job: str, limit: int = 50, include_causes: bool = False) -> list[dict]:
        url    = f"{self.base}/job/{job}/api/json"
        fields = "number,result,building,timestamp,description,duration"
        if include_causes:
            fields += ",actions[causes[upstreamProject,upstreamBuild,upstreamUrl]]"

        async def _fetch(prop: str) -> tuple[bool, list[dict]]:
            """Returns (property_exists, builds_list)."""
            params = {"tree": f"{prop}[{fields}]{{{0},{limit}}}"}
            async with self._client() as c:
                r = await c.get(url, params=params)
            if r.status_code == 200:
                data = r.json()
                # Key present → property is supported (even if list is empty)
                if prop in data:
                    return True, data[prop]
                return False, []
            if r.status_code in (401, 403):
                async with httpx.AsyncClient(**_CLIENT_DEFAULTS) as anon:
                    r2 = await anon.get(url, params=params)
                if r2.status_code == 200:
                    data = r2.json()
                    if prop in data:
                        return True, data[prop]
                    return False, []
            self._check_auth(r)
            r.raise_for_status()
            return False, []

        # allBuilds bypasses Jenkins' hard 100-build cap on the 'builds' property.
        # If the Jenkins instance supports it, use it; otherwise fall back to builds.
        supported, builds = await _fetch("allBuilds")
        if not supported:
            _, builds = await _fetch("builds")
        return builds

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

    async def _post(self, path: str, data: dict | None = None, skip_crumb: bool = False) -> httpx.Response:
        """POST using a single client session so the CSRF crumb stays valid."""
        import json as _json
        async with self._client() as c:
            crumb_headers = {}
            if not skip_crumb:
                crumb_r = await c.get(f"{self.base}/crumbIssuer/api/json")
                if crumb_r.status_code == 200:
                    d = crumb_r.json()
                    crumb_headers = {d["crumbRequestField"]: d["crumb"]}
                    print(f"[JENKINS] crumb OK field={d['crumbRequestField']}", flush=True)
                else:
                    print(f"[JENKINS] crumb FAILED status={crumb_r.status_code}", flush=True)
            else:
                print(f"[JENKINS] crumb SKIPPED (API token auth)", flush=True)
            print(f"[JENKINS] POST {path} data_keys={list((data or {}).keys())}", flush=True)
            r = await c.post(f"{self.base}{path}", data=data or {}, headers=crumb_headers)
        if not r.is_success:
            # Try to extract a human-readable error from Jenkins HTML
            body = r.text
            err_text = body[:2000]
            m = re.search(r'<h2[^>]*>(.*?)</h2>', body, re.DOTALL | re.IGNORECASE)
            if m:
                err_text = re.sub(r'<[^>]+>', '', m.group(1)).strip() or err_text
            else:
                m = re.search(r'(?:hudson|jenkins)[^<]{0,200}error[^<]{0,400}', body, re.IGNORECASE | re.DOTALL)
                if m:
                    err_text = re.sub(r'<[^>]+>', '', m.group(0)).strip()[:400] or err_text
            print(f"[JENKINS] POST failed {r.status_code}: {err_text[:400]}", flush=True)
            raise httpx.HTTPStatusError(
                f"{r.status_code} from {r.url} — {err_text[:600]}",
                request=r.request,
                response=r,
            )
        return r

    async def trigger_job(self, job: str, params: dict, skip_crumb: bool = False) -> int:
        if skip_crumb:
            # No pre-flight crumb GET — raw POST, exactly like the working curl.
            # The crumb GET establishes a session cookie that then requires CSRF validation,
            # breaking API-token-based triggers. Without it Jenkins is crumb-exempt for tokens.
            async with httpx.AsyncClient(verify=False, timeout=30.0) as c:
                r = await c.post(
                    f"{self.base}/job/{job}/buildWithParameters",
                    auth=self.auth,
                    data=params,
                )
            if not r.is_success:
                body = r.text
                err = re.sub(r'<[^>]+>', '', (re.search(r'<h2[^>]*>(.*?)</h2>', body, re.DOTALL | re.IGNORECASE) or re.search(r'', body) or type('', (), {'group': lambda s, n: body[:400]})()).group(1) if '<h2' in body else body[:400]).strip() or body[:400]
                raise httpx.HTTPStatusError(f"{r.status_code} from {r.url} — {err[:400]}", request=r.request, response=r)
        else:
            r = await self._post(f"/job/{job}/buildWithParameters", params)
        location = r.headers.get("Location", "")
        match = re.search(r"/queue/item/(\d+)/", location)
        return int(match.group(1)) if match else 0

    async def trigger_job_json(self, job: str, params: dict) -> int:
        """Trigger using JSON body format — explicit types for booleans, avoids form-encoding issues."""
        import json as _json
        param_list = [{"name": k, "value": v} for k, v in params.items()]
        r = await self._post(f"/job/{job}/build", {"json": _json.dumps({"parameter": param_list})})
        location = r.headers.get("Location", "")
        match = re.search(r"/queue/item/(\d+)/", location)
        return int(match.group(1)) if match else 0

    async def abort_build(self, job: str, build_num: int) -> None:
        await self._post(f"/job/{job}/{build_num}/stop")

    async def list_agents(self) -> list[dict]:
        params = {"tree": "computer[displayName,offline,idle,description]"}
        async with self._client() as c:
            r = await c.get(f"{self.base}/computer/api/json", params=params)
        if r.status_code in (401, 403):
            async with httpx.AsyncClient(**_CLIENT_DEFAULTS) as anon:
                r = await anon.get(f"{self.base}/computer/api/json", params=params)
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
