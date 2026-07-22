"""API tests for /api/sequences — verifies count + node_name round-trip (regression guard)."""
import pytest

BASE_ITEM = {
    "offset_sec": 0,
    "workload_type": "rbd",
    "size_gb": 50,
    "mode": "readwrite",
    "pattern": "sequential",
    "block_size": "1m",
    "num_jobs": 4,
    "iodepth": 32,
    "duration_sec": 300,
    "obj_size_mb": 64,
    "workers": 8,
    "engine": "libaio",
    "direct": True,
}


@pytest.mark.asyncio
async def test_create_and_list(authed_client):
    r = await authed_client.post("/api/sequences/", json={
        "name": "test-seq",
        "items": [BASE_ITEM],
    })
    assert r.status_code == 200
    r2 = await authed_client.get("/api/sequences/")
    assert any(s["name"] == "test-seq" for s in r2.json())


@pytest.mark.asyncio
async def test_count_field_roundtrip(authed_client):
    """count must survive save → load (regression: was stripped by Pydantic)."""
    item = {**BASE_ITEM, "count": 3}
    r = await authed_client.post("/api/sequences/", json={"name": "count-test", "items": [item]})
    assert r.status_code == 200
    seq_id = r.json()["id"]

    r2 = await authed_client.get("/api/sequences/")
    seq = next(s for s in r2.json() if s["id"] == seq_id)
    assert seq["items"][0]["count"] == 3


@pytest.mark.asyncio
async def test_node_name_field_roundtrip(authed_client):
    """node_name must survive save → load (regression: was stripped by Pydantic)."""
    item = {**BASE_ITEM, "node_name": "compute-2"}
    r = await authed_client.post("/api/sequences/", json={"name": "node-test", "items": [item]})
    assert r.status_code == 200
    seq_id = r.json()["id"]

    r2 = await authed_client.get("/api/sequences/")
    seq = next(s for s in r2.json() if s["id"] == seq_id)
    assert seq["items"][0]["node_name"] == "compute-2"


@pytest.mark.asyncio
async def test_delete_sequence(authed_client):
    r = await authed_client.post("/api/sequences/", json={"name": "to-delete", "items": [BASE_ITEM]})
    seq_id = r.json()["id"]
    r2 = await authed_client.delete(f"/api/sequences/{seq_id}")
    assert r2.status_code == 200

    r3 = await authed_client.get("/api/sequences/")
    assert not any(s["id"] == seq_id for s in r3.json())


@pytest.mark.asyncio
async def test_update_sequence_name(authed_client):
    r = await authed_client.post("/api/sequences/", json={"name": "original", "items": [BASE_ITEM]})
    seq_id = r.json()["id"]
    r2 = await authed_client.patch(f"/api/sequences/{seq_id}", json={"name": "renamed"})
    assert r2.status_code == 200

    r3 = await authed_client.get("/api/sequences/")
    seq = next(s for s in r3.json() if s["id"] == seq_id)
    assert seq["name"] == "renamed"


@pytest.mark.asyncio
async def test_unauthenticated_rejected(client):
    r = await client.get("/api/sequences/")
    assert r.status_code == 401
