SHELL := /bin/bash
ROOT_DIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
SKILL_DIR := $(ROOT_DIR)/deyo
SKILL_SLUG := deyo
SKILL_NAME := Deyo
SKILL_TAGS ?= latest
CHANGELOG ?=
VERSION ?=

.PHONY: publish_skill_clawhub

publish_skill_clawhub:
	@set -euo pipefail; \
	cd "$(ROOT_DIR)"; \
	if ! command -v clawhub >/dev/null 2>&1; then \
		echo "clawhub CLI is required. Install it with: npm i -g clawhub"; \
		exit 1; \
	fi; \
	if ! command -v node >/dev/null 2>&1; then \
		echo "node is required to parse clawhub inspect output."; \
		exit 1; \
	fi; \
	if [ ! -f "$(SKILL_DIR)/SKILL.md" ]; then \
		echo "Missing skill definition: $(SKILL_DIR)/SKILL.md"; \
		exit 1; \
	fi; \
	if ! clawhub whoami >/dev/null 2>&1; then \
		echo "You are not logged in to ClawHub. Run: clawhub login"; \
		exit 1; \
	fi; \
	TARGET_VERSION="$(VERSION)"; \
	if [ -z "$$TARGET_VERSION" ]; then \
		inspect_json=$$(mktemp); \
		inspect_err=$$(mktemp); \
		cleanup() { rm -f "$$inspect_json" "$$inspect_err"; }; \
		trap cleanup EXIT; \
		if clawhub inspect "$(SKILL_SLUG)" --json --versions --limit 1 >"$$inspect_json" 2>"$$inspect_err"; then \
			TARGET_VERSION=$$(node -e 'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const version = data.latestVersion?.version || data.versions?.[0]?.version || ""; if (!/^\d+\.\d+\.\d+$$/.test(version)) { console.error("Could not determine the latest published semver from clawhub inspect output."); process.exit(1); } const [major, minor, patch] = version.split(".").map(Number); console.log([major, minor, patch + 1].join("."));' "$$inspect_json"); \
		else \
			if grep -qi "Skill not found" "$$inspect_err"; then \
				TARGET_VERSION="1.0.0"; \
			else \
				cat "$$inspect_err" >&2; \
				exit 1; \
			fi; \
		fi; \
		trap - EXIT; \
		cleanup; \
	fi; \
	echo "Publishing $(SKILL_NAME) ($(SKILL_SLUG)) version $$TARGET_VERSION from $(SKILL_DIR)"; \
	clawhub publish "$(SKILL_DIR)" --slug "$(SKILL_SLUG)" --name "$(SKILL_NAME)" --version "$$TARGET_VERSION" --tags "$(SKILL_TAGS)" --changelog "$(CHANGELOG)"; \
	echo "Published $(SKILL_SLUG)@$$TARGET_VERSION"
