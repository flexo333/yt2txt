"""
yt2txt — YouTube-to-text summariser SPA
S3 + CloudFront front-end (via StaticSite component)
Lambda (Gemini-backed) + DynamoDB for summary persistence

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
table = aws.dynamodb.Table(
    "summaries",
    name="yt2txt-summaries",
    billing_mode="PAY_PER_REQUEST",
    hash_key="url",
    attributes=[aws.dynamodb.TableAttributeArgs(name="url", type="S")],
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

# ── IAM role for Lambda ───────────────────────────────────────────────────────
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
                    "dynamodb:PutItem",
                    "dynamodb:GetItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:Scan",
                    "dynamodb:Query",
                ],
                "Resource": arns,
            }],
        })
    ),
)

# ── Lambda function ───────────────────────────────────────────────────────────
summarise_zip = _lambda_archive("../../backend/summarise")

summarise_fn = aws.lambda_.Function(
    "summarise",
    runtime="nodejs20.x",
    handler="handler.handler",
    role=lambda_role.arn,
    code=summarise_zip,
    timeout=900,
    memory_size=256,
    environment=aws.lambda_.FunctionEnvironmentArgs(variables={
        "DYNAMODB_TABLE": table.name,
        "PEOPLE_TABLE": people_table.name,
        "PEOPLE_VIDEOS_TABLE": people_videos_table.name,
        "GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY", ""),
        "YOUTUBE_API_KEY": os.environ.get("YOUTUBE_API_KEY", ""),
        "SHARED_SECRET": shared_secret if shared_secret is not None else "",
    }),
)

aws.iam.RolePolicy(
    "summarise-self-invoke-policy",
    role=lambda_role.id,
    policy=summarise_fn.arn.apply(lambda arn: json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Action": ["lambda:InvokeFunction"],
            "Resource": arn,
        }],
    })),
)

# ── Batch-poll schedule ───────────────────────────────────────────────────────
# Person research submits a Gemini Batch job and returns; this rule wakes the
# Lambda every 3 min to poll for completion and write results. See people.js
# `pollPendingBatches`. Short cadence is cheap — scan only filters by
# status=batch_pending, and the batch itself is free to poll.
poll_rule = aws.cloudwatch.EventRule(
    "summarise-poll-rule",
    schedule_expression="rate(3 minutes)",
    description="Poll Gemini batch jobs for yt2txt person research",
)

aws.cloudwatch.EventTarget(
    "summarise-poll-target",
    rule=poll_rule.name,
    arn=summarise_fn.arn,
    input=json.dumps({"__pollBatches": True}),
)

aws.lambda_.Permission(
    "summarise-poll-permission",
    action="lambda:InvokeFunction",
    function=summarise_fn.name,
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
pulumi.export("lambda_function_name", summarise_fn.name)
pulumi.export("dynamodb_table", table.name)
if shared_secret is not None:
    pulumi.export("yt2txt_shared_secret", shared_secret)
