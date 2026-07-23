# Backend Tests

Pytest suite for the JenEase FastAPI backend. Two tiers: offline unit tests (no network, no DB) and live Jenkins integration tests (real stage Jenkins, skipped when credentials absent).

## Run

```bash
# From repo root
make test-fast        # unit + API tests, no Jenkins needed, ~5s
make test-jenkins     # Jenkins integration, ~35s, needs .env.test
make test-full        # everything

# Directly
cd backend
pytest tests/test_job_parser.py tests/test_jenkins_parse.py tests/test_names.py \
       tests/test_api_auth.py tests/test_api_sequences.py -v
```

## Fixtures (`conftest.py`)

| Fixture | What it provides |
|---|---|
| `client` | Unauthenticated `httpx.AsyncClient` → FastAPI app |
| `authed_client` | Same client with a signed session cookie (fake token, no Jenkins calls) |
| `jenkins_client` | Same client with **real** `JENKINS_TEST_USER` + `JENKINS_TEST_TOKEN` from `.env.test` |

All tests use an **in-memory SQLite** database — no prod DB is touched.

---

## `test_job_parser.py` — parse_job() unit tests

Tests `parse_job(job_name)` which parses `qe-trigger-*-deployment` job names into structured metadata used throughout the app.

| Test | What it checks |
|---|---|
| `test_vsphere_upi_vsan` | vSphere UPI job parses platform=vsphere, installer=upi, storage=vsan, topology 3M+3W, multus feature |
| `test_aws_ipi_fips` | AWS IPI job parses platform=aws, installer=ipi, az=2az, fips feature |
| `test_ibmcloud_ipv6` | IBM Cloud job parses platform=ibmcloud, ipv6 feature |
| `test_compact_mode_0_workers` | `3m-0w` topology sets workers=0 (compact mode) |
| `test_lso_storage` | Single-token storage `lso` parsed correctly |
| `test_lso_rdm_multitoke` | Multi-token storage `lso-rdm` treated as one unit, not split |
| `test_kms_vault_feature` | Multi-token feature `kms-vault-v1` extracted intact |
| `test_multiple_features` | `fips-encryption` produces two separate feature entries |
| `test_no_suffix_stripped` | `job_name` field preserves the original full name unchanged |
| `test_title_non_empty` | `title` field is generated and contains the platform label |
| `test_masters_workers_parsed` | `5m-6w` sets masters=5, workers=6 |
| `test_unknown_platform_falls_through` | Unrecognised platform sets platform=None without crashing |
| `test_baremetal` | `baremetal` platform is correctly identified |
| `test_dedup_features` | Duplicate features in the job name are de-duplicated |

---

## `test_jenkins_parse.py` — Jenkins HTML + topology parsing

Tests two pure parsing functions with no network calls.

### `JenkinsClient.parse_build_description()` — extracts cluster URLs from Jenkins build HTML

| Test | What it checks |
|---|---|
| `test_parse_kubeconfig_url` | `kubeconfig_url` key is present and contains `auth/kubeconfig` |
| `test_parse_console_url` | `console_url` key is present and contains `console-openshift` |
| `test_parse_password` | `kubeadmin_password` is extracted correctly |
| `test_parse_agent_ip` | `agent_ip` (Jenkins slave IP) is extracted correctly |
| `test_parse_empty_description` | Empty string returns `{}` without error |
| `test_parse_none_description` | `None` input returns `{}` without error |
| `test_parse_no_kubeconfig` | Description without kubeconfig link returns no `kubeconfig_url` key |

### `_parse_topology()` — extracts masters/workers from platform conf filename

| Test | What it checks |
|---|---|
| `test_topology_3m_3w` | `upi_1az_rhcos_vsan_3m_3w.yaml` → (3, 3) |
| `test_topology_3m_0w_compact` | `3m_0w.yaml` → (3, 0) for compact mode |
| `test_topology_5m_6w` | `5m-6w-config.yaml` with dash separator → (5, 6) |
| `test_topology_default_fallback` | Empty string or unrecognised path → default (3, 3) |
| `test_topology_dash_separator` | Dash-separated `3m-3w` works as well as underscore |

---

## `test_names.py` — Cluster name suggestion logic

Tests the flavor abbreviation and name slot logic that feeds the Deploy page's cluster name pre-fill. The backend's `suggest_name` endpoint receives a flavor string from the frontend and appends it to the username — this file tests both the abbreviation algorithm and the slot collision handling.

### `jobFlavor()` — platform+storage+feature abbreviation

| Test | What it checks |
|---|---|
| `test_flavor_vsphere_vsan` | vsphere + vsan → `v-vs` |
| `test_flavor_aws_no_storage` | aws + no storage → `a` |
| `test_flavor_ibmcloud_ipv6` | ibmcloud + ipv6 feature → `ib-v6` |
| `test_flavor_vsphere_vsan_fips` | vsphere + vsan + fips → `v-vs-f` |
| `test_flavor_aws_ipv6_fips` | aws + ipv6 + fips → `a-v6-f` |
| `test_flavor_unknown_platform` | gcp falls back to single char `g` |
| `test_flavor_lso_rdm` | lso-rdm storage → `lr` abbreviation |

### `suggest_name()` — slot allocation and length enforcement

| Test | What it checks |
|---|---|
| `test_name_starts_with_username` | Generated name always starts with the username |
| `test_name_contains_flavor` | Flavor suffix is included when it fits |
| `test_name_no_flavor` | Empty flavor → just the username |
| `test_name_slot_collision` | If slot `""` is taken, uses slot `"1"` (srozen1-v-vs) |
| `test_name_max_length` | Long flavor trimmed at token boundary, result ≤ 15 chars |
| `test_name_all_slots_taken` | When slots 0-8 are all taken, falls back to slot `"9"` |

---

## `test_api_auth.py` — Auth endpoint tests (no Jenkins)

Tests session cookie behaviour via FastAPI's test client with an in-memory DB.

| Test | What it checks |
|---|---|
| `test_me_unauthenticated` | `/auth/me` returns 401 with no session cookie |
| `test_me_authenticated` | `/auth/me` reads the signed cookie correctly (accepts 200/401/502 since token is fake) |
| `test_logout_clears_cookie` | `/auth/logout` responds 200 and clears the session cookie |
| `test_me_without_cookie` | Fresh client with no cookie → 401 (stateless cookie design) |

---

## `test_api_sequences.py` — Sequence CRUD + regression guards

Tests the full sequence lifecycle. The two roundtrip tests are **regression guards** for bugs that hit production — `count` and `node_name` were silently stripped by Pydantic because the model was missing those fields.

| Test | What it checks |
|---|---|
| `test_create_and_list` | POST a sequence, then GET list — the sequence appears by name |
| `test_count_field_roundtrip` | `count: 3` survives save → load (regression: was reset to 1) |
| `test_node_name_field_roundtrip` | `node_name: "compute-2"` survives save → load (regression: was dropped) |
| `test_delete_sequence` | DELETE removes the sequence; subsequent GET confirms it's gone |
| `test_update_sequence_name` | PATCH renames a sequence; GET confirms the new name |
| `test_unauthenticated_rejected` | GET sequences without cookie → 401 |

---

## `test_api_jenkins.py` — Jenkins integration tests (real credentials)

These tests hit the actual stage Jenkins instance. They are **skipped automatically** unless `JENKINS_TEST_TOKEN` is set in `.env.test` or the environment.

Run: `make test-jenkins` (loads credentials from `.env.test` at repo root).

| Test | What it checks |
|---|---|
| `test_all_clusters_returns_list` | `/api/clusters/all` returns HTTP 200 and a JSON list |
| `test_all_clusters_have_required_fields` | Every cluster in the response has `cluster_name`, `ocp_version`, `ocs_version`, `platform_conf`, `credentials_conf` — catches the SSO fallback regression where these were blank |
| `test_all_clusters_name_starts_with_owner` | Every cluster's name starts with its owner's username (Jenkins naming convention) |
| `test_suggest_name_returns_prefixed_name` | `/api/suggest-name?flavor=v-vs` returns a name starting with the logged-in username |
| `test_suggest_name_max_length` | Suggested name never exceeds 15 characters even with a long flavor |
| `test_job_catalog_returns_jobs` | `/api/jobs/deployments` returns at least one job (catalog loaded) |
| `test_job_catalog_has_vsphere` | At least one vSphere job exists in the catalog |
| `test_job_catalog_params_have_ocp_version` | Jobs with loaded params contain `OCP_VERSION` and `OCS_VERSION` (skips gracefully if catalog was warmed anonymously) |
| `test_auth_me_returns_username` | `/auth/me` with real credentials returns the correct username |
