SHELL := /bin/bash
ROOT_DIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

ifneq ($(origin VERSION), undefined)
$(error VERSION overrides are not supported; ClawHub allocates the next patch)
endif
ifneq ($(origin CLAWHUB_VERSION), undefined)
$(error CLAWHUB_VERSION overrides are not supported; ClawHub allocates the next patch)
endif

.PHONY: publish abort fix-forward supersede generate validate test

publish:
	@cd "$(ROOT_DIR)" && node scripts/release.mjs $(if $(filter 1,$(DRY_RUN)),--dry-run,) $(if $(filter 1,$(RESUME)),--resume,)

abort:
	@cd "$(ROOT_DIR)" && node scripts/release.mjs --abort

fix-forward:
	@cd "$(ROOT_DIR)" && node scripts/release.mjs --fix-forward

supersede:
	@cd "$(ROOT_DIR)" && node scripts/release.mjs --supersede

generate:
	@cd "$(ROOT_DIR)" && pnpm generate

validate:
	@cd "$(ROOT_DIR)" && pnpm validate

test:
	@cd "$(ROOT_DIR)" && pnpm test
