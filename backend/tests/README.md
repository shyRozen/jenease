# Backend Tests

Pytest suite for the JenEase FastAPI backend. Two tiers: offline unit tests and live Jenkins integration tests.

## Run

```bash
# From repo root
make test-fast        # unit + API tests (no Jenkins, ~5s)
make test-jenkins     # Jenkins integration tests (~35s, needs VPN + .env.test)
make test-full        # everything

# Or directly from backend/
cd backend
python -m pytest tests/test_job_parser.py tests/test_jenkins_parse.py tests/test_names.py tests/test_api_auth.py tests/test_api_sequences.py -v
```

## Files

### Unit tests — no network, no DB, run offline

| File | What it tests |
|---|---|
| `test_job_parser.py` | `parse_job()` — all platforms, installers, storage types, features, topology |
| `test_jenkins_parse.py` | `JenkinsClient.parse_build_description()` and `_parse_topology()` |
| `test_names.py` | `jobFlavor()` abbreviation logic, name slot collision, 15-char max enforcement |

### API tests — in-memory SQLite, no Jenkins calls

| File | What it tests |
|---|---|
| `test_api_auth.py` | Login/logout endpoints, session cookie, 401 when unauthenticated |
| `test_api_sequences.py` | Sequence CRUD; **count and node_name round-trip** (regression guard for schema bug) |

### Jenkins integration tests — hits real stage Jenkins

| File | What it tests |
|---|---|
| `test_api_jenkins.py` | All-clusters fields, suggest-name prefix/length, job catalog, auth |

These tests are skipped automatically if `JENKINS_TEST_TOKEN` is not set.

## Fixtures (`conftest.py`)

- `client` — unauthenticated `httpx.AsyncClient` wired to the FastAPI app
- `authed_client` — same client with a signed session cookie (fake token, no Jenkins)
- `jenkins_client` — same client with **real** `JENKINS_TEST_USER` + `JENKINS_TEST_TOKEN` from `.env.test`

## Credentials

Create `.env.test` at the repo root (gitignored):

```
JENKINS_TEST_USER=srozen
JENKINS_TEST_TOKEN=<your stage Jenkins API token>
```

The Makefile auto-loads this file via `-include .env.test`.

## Key regression guards

| Test | Bug it would have caught |
|---|---|
| `test_count_field_roundtrip` | Sequence `count` silently reset to 1 on save/load |
| `test_node_name_field_roundtrip` | `node_name` dropped from saved sequences |
| `test_parse_build_description` | OCP/OCS version empty in All Clusters (wrong regex) |
| `test_topology_*` | Masters/workers showing 3+3 for all clusters |
