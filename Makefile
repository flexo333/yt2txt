.DEFAULT_GOAL := help

ifneq (,$(wildcard .env))
  include .env
  export
endif

PULUMI_YES := --yes

.PHONY: help
help:
	@grep -E '^[a-zA-Z_/-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install npm dependencies
	docker compose run --rm node npm install

.PHONY: dev
dev: ## Start Vite dev server → http://localhost:5173
	docker compose run --rm --service-ports node npm run dev -- --host

.PHONY: build
build: install ## Build for production (outputs to dist/)
	docker compose run --rm node npm run build

.PHONY: infra-preview
infra-preview: ## Preview infra changes
	docker compose build pulumi
	docker compose run --rm pulumi preview

.PHONY: infra-up
infra-up: ## Apply infra changes
	docker compose build pulumi
	docker compose run --rm pulumi up $(PULUMI_YES)

.PHONY: infra-destroy
infra-destroy: ## Destroy infra ⚠️  careful
	docker compose run --rm pulumi destroy $(PULUMI_YES)

.PHONY: infra-outputs
infra-outputs: ## Show stack outputs
	docker compose run --rm pulumi stack output

.PHONY: deploy
deploy: build ## Build + sync dist/ to S3 + invalidate CloudFront
	@BUCKET=$${BUCKET:-$$(docker compose run --rm -T pulumi stack output bucket 2>/dev/null | tail -1)}; \
	CFID=$${CF_DISTRIBUTION_ID:-$$(docker compose run --rm -T pulumi stack output distribution_id 2>/dev/null | tail -1)}; \
	test -n "$$BUCKET" || { echo "❌  Run 'make infra-up' first"; exit 1; }; \
	echo "→ Deploying to $$BUCKET"; \
	docker compose run --rm awscli s3 sync /app/dist/ s3://$$BUCKET --delete; \
	docker compose run --rm awscli cloudfront create-invalidation \
		--distribution-id $$CFID --paths '/*'
