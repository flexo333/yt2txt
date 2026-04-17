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

.PHONY: build-lambda
build-lambda: ## Install Lambda npm deps into backend/summarise/node_modules/ (linux/amd64)
	docker compose run --rm node-lambda npm install

.PHONY: dev
dev: ## Start Vite dev server → http://localhost:5173
	docker compose run --rm --service-ports node npm run dev -- --host

.PHONY: build
build: install ## Build for production (outputs to dist/)
	docker compose run --rm node npm run build

.PHONY: infra-preview
infra-preview: build-lambda ## Preview infra changes
	docker compose build pulumi
	docker compose run --rm pulumi preview

.PHONY: infra-up
infra-up: build-lambda ## Apply infra changes
	docker compose build pulumi
	docker compose run --rm pulumi up $(PULUMI_YES)

.PHONY: infra-destroy
infra-destroy: ## Destroy infra ⚠️  careful
	docker compose run --rm pulumi destroy $(PULUMI_YES)

.PHONY: infra-outputs
infra-outputs: ## Show stack outputs
	docker compose run --rm pulumi stack output

.PHONY: infra-refresh
infra-refresh: ## Resync Pulumi state from AWS (fixes stale api_url drift)
	@FN=$$(docker compose run --rm -T pulumi stack output lambda_function_name 2>/dev/null | tr -d '\r\n'); \
	test -n "$$FN" || { echo "❌  lambda_function_name not exported — run 'make infra-up' first"; exit 1; }; \
	echo "→ Pulumi state api_url:"; \
	docker compose run --rm -T pulumi stack output api_url; \
	echo "→ AWS live FunctionUrl for $$FN:"; \
	docker compose run --rm awscli lambda get-function-url-config \
		--function-name $$FN --query FunctionUrl --output text; \
	echo "→ Refreshing Pulumi state from AWS..."; \
	docker compose run --rm pulumi refresh $(PULUMI_YES); \
	echo "→ Post-refresh api_url:"; \
	docker compose run --rm -T pulumi stack output api_url

.PHONY: deploy
deploy: install ## Build (with live Lambda URL) + sync dist/ to S3 + invalidate CloudFront
	@BUCKET=$$(docker compose run --rm -T pulumi stack output bucket 2>/dev/null | tr -d '\r\n'); \
	CFID=$$(docker compose run --rm -T pulumi stack output distribution_id 2>/dev/null | tr -d '\r\n'); \
	LAMBDA_URL=$${VITE_LAMBDA_URL_OVERRIDE:-$$(docker compose run --rm -T pulumi stack output api_url 2>/dev/null | tr -d '\r\n')}; \
	test -n "$$BUCKET" || { echo "❌  Run 'make infra-up' first"; exit 1; }; \
	test -n "$$LAMBDA_URL" || { echo "❌  Could not resolve LAMBDA_URL"; exit 1; }; \
	echo "→ Building with VITE_LAMBDA_URL=$$LAMBDA_URL"; \
	docker compose run --rm -e VITE_LAMBDA_URL=$$LAMBDA_URL node npm run build; \
	echo "→ Deploying to $$BUCKET"; \
	docker compose run --rm awscli s3 sync /app/dist/ s3://$$BUCKET --delete; \
	docker compose run --rm awscli cloudfront create-invalidation \
		--distribution-id $$CFID --paths '/*'
