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
deploy: ## Sync to S3 + invalidate CloudFront
	@BUCKET=$${BUCKET:-$$(docker compose run --rm -T pulumi stack output bucket 2>/dev/null | tail -1)}; \
	CFID=$${CF_DISTRIBUTION_ID:-$$(docker compose run --rm -T pulumi stack output distribution_id 2>/dev/null | tail -1)}; \
	test -n "$$BUCKET" || { echo "❌  Run 'make infra-up' first"; exit 1; }; \
	echo "→ Deploying to $$BUCKET"; \
	docker compose run --rm awscli s3 sync /app/ s3://$$BUCKET --delete \
		--exclude '.git/*' --exclude 'infra/*' --exclude '.env' --exclude '*.DS_Store'; \
	docker compose run --rm awscli cloudfront create-invalidation \
		--distribution-id $$CFID --paths '/*'
