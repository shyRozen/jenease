# Load .env.test if it exists (JENKINS_TEST_USER, JENKINS_TEST_TOKEN)
-include .env.test
export

.PHONY: test-fast test-full test-backend test-frontend test-jenkins

# Fast gate — run before every push (~15s, no Jenkins needed)
test-fast: test-backend test-frontend

# Full suite including Jenkins integration tests
test-full: test-backend test-frontend test-jenkins

test-backend:
	cd backend && python -m pytest tests/test_job_parser.py tests/test_jenkins_parse.py tests/test_names.py tests/test_api_auth.py tests/test_api_sequences.py -v

test-frontend:
	cd frontend && npm test

# Jenkins integration tests — reads credentials from .env.test or shell env
test-jenkins:
	cd backend && python -m pytest tests/test_api_jenkins.py -v
