"""
yt2txt — YouTube-to-text summariser SPA
S3 + CloudFront front-end (via StaticSite component)
Two Lambdas over one code bundle (Gemini-backed) + DynamoDB:
  web    — behind the public Function URL (backend/summarise/web.js)
  worker — person-research jobs, backfill, resumer tick (worker.js)

DNS is resolved one of three ways (first match wins):
  1. yt2txt:parentIngressStack — Pulumi StackReference with a zone_id output
                                 (flexo333-ingress / shared ingress setup)
  2. yt2txt:zoneId             — Route53 hosted zone ID passed directly
                                 (you already have a zone, just give us the ID)
  3. (neither)                 — a new Route53 zone is created; nameservers are
                                 exported so you can update your registrar
"""

import os
import json
import glob as _glob
import pulumi
import pulumi_aws as aws
from pulumi_static_site import StaticSite


def _lambda_archive(handler_dir: str) -> pulumi.AssetArchive:
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), handler_dir))
    assets: dict[str, pulumi.Asset] = {}

    for abs_path in _glob.glob(os.path.join(base, "**", "*"), recursive=True):
        if (os.path.isfile(abs_path)
                and "__pycache__" not in abs_path
                and not abs_path.endswith(".pyc")):
            assets[os.path.relpath(abs_path, base)] = pulumi.FileAsset(abs_path)

    return pulumi.AssetArchive(assets)


config      = pulumi.Config()
domain_name = config.require("domainName")
bucket_name = config.get("bucketName") or "flexo333-yt2txt"
shared_secret = config.get_secret("yt2txtSharedSecret")

# ── DNS / Route53 zone ────────────────────────────────────────────────────────
parent_stack_ref = config.get("parentIngressStack")
zone_id_direct   = config.get("zoneId")

if parent_stack_ref:
    ingress = pulumi.StackReference(parent_stack_ref)
    zone_id = ingress.get_output("zone_id")
elif zone_id_direct:
    zone_id = zone_id_direct
else:
    _zone   = aws.route53.Zone("yt2txt-zone", name=domain_name)
    zone_id = _zone.zone_id
    pulumi.export("nameservers", _zone.name_servers)

site = StaticSite(
    "yt2txt",
    domain=domain_name,
    zone_id=zone_id,
    bucket_name=bucket_name,
    spa_mode=True,
)

# ── DynamoDB tables ───────────────────────────────────────────────────────────
# byCreatedAt: the history feed. The table is keyed by url, so "the newest 50"
# has to come from an index — a Scan returns rows in hash order. Every summary
# carries the same partition key (gsi1pk = "SUMMARY"), which makes one hot
# partition; at this table's size and write rate that is the point, not a flaw.
table = aws.dynamodb.Table(
    "summaries",
    name="yt2txt-summaries",
    billing_mode="PAY_PER_REQUEST",
    hash_key="url",
    attributes=[
        aws.dynamodb.TableAttributeArgs(name="url", type="S"),
        aws.dynamodb.TableAttributeArgs(name="gsi1pk", type="S"),
        aws.dynamodb.TableAttributeArgs(name="createdAt", type="N"),
    ],
    global_secondary_indexes=[
        aws.dynamodb.TableGlobalSecondaryIndexArgs(
            name="byCreatedAt",
            hash_key="gsi1pk",
            range_key="createdAt",
            # ALL: the list response reads title/date/model/speakers/markdown,
            # so a KEYS_ONLY index would need a GetItem per row.
            projection_type="ALL",
        ),
    ],
)

people_table = aws.dynamodb.Table(
    "people",
    name="yt2txt-people",
    billing_mode="PAY_PER_REQUEST",
    hash_key="person",
    attributes=[aws.dynamodb.TableAttributeArgs(name="person", type="S")],
)

people_videos_table = aws.dynamodb.Table(
    "people-videos",
    name="yt2txt-people-videos",
    billing_mode="PAY_PER_REQUEST",
    hash_key="person",
    range_key="videoId",
    attributes=[
        aws.dynamodb.TableAttributeArgs(name="person", type="S"),
        aws.dynamodb.TableAttributeArgs(name="videoId", type="S"),
    ],
)

# ── IAM roles ─────────────────────────────────────────────────────────────────
# One role per Lambda; the two want opposite privileges. The web role covers the
# request path only: it reads, it puts a summary / a queued person-job row, and
# it can invoke exactly one thing — the worker. The worker role owns everything
# destructive: UpdateItem for job progress, DeleteItem for the backfill's
# canonical-key pass, and self-invoke for its continuations.
lambda_role = aws.iam.Role(
    "summarise-role",
    assume_role_policy=json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "lambda.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }],
    }),
)

aws.iam.RolePolicyAttachment(
    "summarise-basic-exec",
    role=lambda_role.name,
    policy_arn="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
)

aws.iam.RolePolicy(
    "summarise-ddb-policy",
    role=lambda_role.id,
    policy=pulumi.Output.all(table.arn, people_table.arn, people_videos_table.arn).apply(
        lambda arns: json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Action": [
                    # The request path: dedupe GetItem + summary PutItem + the
                    # queued person-job row; Query for the byCreatedAt index and
                    # person videos; Scan for the history/?video= fallbacks and
                    # the people list. No UpdateItem, no DeleteItem — those are
                    # job-runner verbs and live on the worker role.
                    "dynamodb:PutItem",
                    "dynamodb:GetItem",
                    "dynamodb:Scan",
                    "dynamodb:Query",
                ],
                # Querying a GSI is authorised against the index ARN, not the
                # table's, so both are listed (only yt2txt-summaries has one
                # today — the wildcard keeps a future index from needing an
                # IAM change to be readable).
                "Resource": arns + [f"{arn}/index/*" for arn in arns],
            }],
        })
    ),
)

worker_role = aws.iam.Role(
    "summarise-worker-role",
    assume_role_policy=json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "lambda.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }],
    }),
)

aws.iam.RolePolicyAttachment(
    "summarise-worker-basic-exec",
    role=worker_role.name,
    policy_arn="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
)

aws.iam.RolePolicy(
    "summarise-worker-ddb-policy",
    role=worker_role.id,
    policy=pulumi.Output.all(table.arn, people_table.arn, people_videos_table.arn).apply(
        lambda arns: json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Action": [
                    "dynamodb:PutItem",
                    "dynamodb:GetItem",
                    "dynamodb:UpdateItem",
                    # DeleteItem exists for one caller: the backfill's canonical
                    # -key pass, which copies a row to its canonical url and then
                    # removes the original.
                    "dynamodb:DeleteItem",
                    "dynamodb:Scan",
                    "dynamodb:Query",
                ],
                "Resource": arns + [f"{arn}/index/*" for arn in arns],
            }],
        })
    ),
)

# ── Lambda functions ──────────────────────────────────────────────────────────
# Same archive, two functions. The worker is defined first because the web
# function carries WORKER_FUNCTION_NAME in its env — that direction is fine
# (worker.name is known before the web function exists); the reverse, a
# function's own name in its own env, would be the circular dependency the
# self-invoke path avoids by reading AWS_LAMBDA_FUNCTION_NAME at runtime.
summarise_zip = _lambda_archive("../../backend/summarise")

worker_fn = aws.lambda_.Function(
    "summarise-worker",
    runtime="nodejs20.x",
    handler="worker.handler",
    role=worker_role.arn,
    code=summarise_zip,
    timeout=900,
    memory_size=256,
    environment=aws.lambda_.FunctionEnvironmentArgs(variables={
        "DYNAMODB_TABLE": table.name,
        "PEOPLE_TABLE": people_table.name,
        "PEOPLE_VIDEOS_TABLE": people_videos_table.name,
        "GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY", ""),
        "YOUTUBE_API_KEY": os.environ.get("YOUTUBE_API_KEY", ""),
        # No SHARED_SECRET (nothing HTTP reaches this function) and no
        # WORKER_FUNCTION_NAME (its continuations self-invoke via the
        # runtime-injected AWS_LAMBDA_FUNCTION_NAME).
    }),
)

aws.iam.RolePolicy(
    "summarise-worker-self-invoke-policy",
    role=worker_role.id,
    policy=worker_fn.arn.apply(lambda arn: json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Action": ["lambda:InvokeFunction"],
            "Resource": arn,
        }],
    })),
)

# The public function: this is the pre-split "summarise" resource, kept (rather
# than replaced) so its Function URL and the NONE-auth Permission below are
# never recreated — see the authz-caching warning at the FunctionUrl. 300 s, not
# 900: a summarise walks at most 4 models, and the fallback-triggering errors
# (quota, rate limit) fail in seconds, so the realistic worst case is one slow
# long-video generation (~3–4 min) plus fast failures. A hung request now dies
# in five minutes instead of fifteen.
summarise_fn = aws.lambda_.Function(
    "summarise",
    runtime="nodejs20.x",
    handler="web.handler",
    role=lambda_role.arn,
    code=summarise_zip,
    timeout=300,
    memory_size=256,
    environment=aws.lambda_.FunctionEnvironmentArgs(variables={
        "DYNAMODB_TABLE": table.name,
        "PEOPLE_TABLE": people_table.name,
        "PEOPLE_VIDEOS_TABLE": people_videos_table.name,
        "GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY", ""),
        "YOUTUBE_API_KEY": os.environ.get("YOUTUBE_API_KEY", ""),
        "SHARED_SECRET": shared_secret if shared_secret is not None else "",
        "WORKER_FUNCTION_NAME": worker_fn.name,
    }),
)

aws.iam.RolePolicy(
    "summarise-invoke-worker-policy",
    role=lambda_role.id,
    policy=worker_fn.arn.apply(lambda arn: json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Action": ["lambda:InvokeFunction"],
            "Resource": arn,
        }],
    })),
)

# ── Person-job resumer schedule ───────────────────────────────────────────────
# Person research runs synchronously and self-invokes its own continuations;
# this rule is a safety net. It wakes the Lambda every 3 min so people.js
# `resumeStalledJobs` can restart any job whose Lambda was killed mid-run.
poll_rule = aws.cloudwatch.EventRule(
    "summarise-poll-rule",
    schedule_expression="rate(3 minutes)",
    description="Resume stalled yt2txt person-research jobs",
)

aws.cloudwatch.EventTarget(
    "summarise-poll-target",
    rule=poll_rule.name,
    arn=worker_fn.arn,
    input=json.dumps({"__resumeJobs": True}),
)

aws.lambda_.Permission(
    "summarise-poll-permission",
    action="lambda:InvokeFunction",
    function=worker_fn.name,
    principal="events.amazonaws.com",
    source_arn=poll_rule.arn,
)

# ── Lambda Function URL (no APIGW 29 s timeout) ───────────────────────────────
# Permission must exist before the URL is created; otherwise AWS caches a
# "no public access" authz state on the URL that survives later policy edits.
url_permission = aws.lambda_.Permission(
    "summarise-url-public",
    action="lambda:InvokeFunctionUrl",
    function=summarise_fn.name,
    principal="*",
    function_url_auth_type="NONE",
)

fn_url = aws.lambda_.FunctionUrl(
    "summarise-url",
    function_name=summarise_fn.name,
    authorization_type="NONE",
    cors=aws.lambda_.FunctionUrlCorsArgs(
        allow_origins=["https://yt2txt.willbright.link", "http://localhost:5173"],
        allow_methods=["GET", "POST"],
        allow_headers=["content-type", "x-yt2txt-key"],
        max_age=300,
    ),
    opts=pulumi.ResourceOptions(depends_on=[url_permission]),
)

# ── Exports ───────────────────────────────────────────────────────────────────
pulumi.export("bucket", site.bucket_name)
pulumi.export("distribution_id", site.distribution_id)
pulumi.export("cloudfront_domain", site.distribution_domain.apply(lambda d: f"https://{d}"))
pulumi.export("aws_region", pulumi.Config("aws").require("region"))
pulumi.export("api_url", fn_url.function_url)
# lambda_function_name stays the URL-bearing web function — infra-refresh diffs
# its FunctionUrl config and make logs tails it by default. The worker is a
# separate output; person-job/backfill logs live under its log group
# (make logs LAMBDA=worker_function_name).
pulumi.export("lambda_function_name", summarise_fn.name)
pulumi.export("worker_function_name", worker_fn.name)
pulumi.export("dynamodb_table", table.name)
if shared_secret is not None:
    pulumi.export("yt2txt_shared_secret", shared_secret)
