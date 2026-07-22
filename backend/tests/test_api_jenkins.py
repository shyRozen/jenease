"""Jenkins integration tests — use real credentials, hit real stage Jenkins.

Run with:
    JENKINS_TEST_USER=srozen JENKINS_TEST_TOKEN=<token> pytest tests/test_api_jenkins.py -v

Skipped automatically when JENKINS_TEST_TOKEN is not set.
"""
import os
import pytest

TEST_USERNAME = os.environ.get("JENKINS_TEST_USER", "srozen")

needs_jenkins = pytest.mark.skipif(
    not os.environ.get("JENKINS_TEST_TOKEN"),
    reason="set JENKINS_TEST_TOKEN and JENKINS_TEST_USER to run Jenkins integration tests",
)


@needs_jenkins
@pytest.mark.asyncio
async def test_all_clusters_returns_list(jenkins_client):
    """Active clusters endpoint returns a list (may be empty if none active)."""
    r = await jenkins_client.get("/api/clusters/all")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)


@needs_jenkins
@pytest.mark.asyncio
async def test_all_clusters_have_required_fields(jenkins_client):
    """Every cluster in the response has ocp_version, ocs_version, platform_conf."""
    r = await jenkins_client.get("/api/clusters/all")
    assert r.status_code == 200
    for c in r.json():
        assert "cluster_name" in c, f"cluster_name missing in {c}"
        assert "ocp_version" in c, f"ocp_version missing in {c.get('cluster_name')}"
        assert "ocs_version" in c, f"ocs_version missing in {c.get('cluster_name')}"
        assert "platform_conf" in c, f"platform_conf missing in {c.get('cluster_name')}"
        assert "credentials_conf" in c, f"credentials_conf missing in {c.get('cluster_name')}"


@needs_jenkins
@pytest.mark.asyncio
async def test_all_clusters_name_starts_with_owner(jenkins_client):
    """Every cluster name starts with its owner's username."""
    r = await jenkins_client.get("/api/clusters/all")
    for c in r.json():
        assert c["cluster_name"].lower().startswith(c["owner"].lower()), (
            f"{c['cluster_name']} doesn't start with owner {c['owner']}"
        )


@needs_jenkins
@pytest.mark.asyncio
async def test_suggest_name_returns_prefixed_name(jenkins_client):
    """suggest-name returns a name starting with the logged-in username."""
    r = await jenkins_client.get("/api/suggest-name?flavor=v-vs")
    assert r.status_code == 200
    data = r.json()
    assert "name" in data
    assert data["name"].lower().startswith(TEST_USERNAME.lower()), (
        f"Expected name to start with {TEST_USERNAME}, got {data['name']}"
    )


@needs_jenkins
@pytest.mark.asyncio
async def test_suggest_name_max_length(jenkins_client):
    """Suggested name never exceeds 15 characters."""
    r = await jenkins_client.get("/api/suggest-name?flavor=v-vs-f-extra")
    assert r.status_code == 200
    name = r.json()["name"]
    assert len(name) <= 15, f"Name too long: {name!r} ({len(name)} chars)"


@needs_jenkins
@pytest.mark.asyncio
async def test_job_catalog_returns_jobs(jenkins_client):
    """Deploy catalog returns jobs (may be cached from disk)."""
    r = await jenkins_client.get("/api/jobs/deployments")
    assert r.status_code == 200
    jobs = r.json()
    assert isinstance(jobs, list)
    assert len(jobs) > 0, "Expected at least one deployment job"


@needs_jenkins
@pytest.mark.asyncio
async def test_job_catalog_has_vsphere(jenkins_client):
    """At least one vsphere job exists in the catalog."""
    r = await jenkins_client.get("/api/jobs/deployments")
    platforms = [j.get("platform") for j in r.json()]
    assert "vsphere" in platforms, f"No vsphere job found. Platforms: {set(platforms)}"


@needs_jenkins
@pytest.mark.asyncio
async def test_job_catalog_params_have_ocp_version(jenkins_client):
    """Jobs with non-empty params have OCP_VERSION and OCS_VERSION.
    The catalog may be disk-cached from an anonymous warmup (empty params) —
    skip gracefully if no params are available yet.
    """
    r = await jenkins_client.get("/api/jobs/deployments")
    jobs_with_params = [j for j in r.json() if j.get("params")]
    if not jobs_with_params:
        pytest.skip("Catalog is warm but params are empty — rebuild cache with valid credentials first")
    for job in jobs_with_params[:5]:
        param_names = [p["name"] for p in job["params"]]
        assert "OCP_VERSION" in param_names, f"{job['job_name']} missing OCP_VERSION"
        assert "OCS_VERSION" in param_names, f"{job['job_name']} missing OCS_VERSION"


@needs_jenkins
@pytest.mark.asyncio
async def test_auth_me_returns_username(jenkins_client):
    """With real credentials, /auth/me returns the correct username."""
    r = await jenkins_client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json().get("username") == TEST_USERNAME
