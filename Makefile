.PHONY: test-fast test-full test-backend test-frontend

# Fast gate — run before every push (~15s)
test-fast: test-backend test-frontend

# Full suite — run before releases (requires JENKINS_TEST_TOKEN for real Jenkins tests)
test-full: test-backend test-frontend
	@echo "Running full suite (real Jenkins tests if JENKINS_TEST_TOKEN is set)..."
	cd backend && python -m pytest tests/ -v

test-backend:
	cd backend && python -m pytest tests/test_job_parser.py tests/test_jenkins_parse.py tests/test_names.py tests/test_api_auth.py tests/test_api_sequences.py -v

test-frontend:
	cd frontend && npm test
