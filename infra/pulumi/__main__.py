"""
yt2txt — yt2txt.willbright.link
S3 + CloudFront SPA, shares ingress stack (Route53 zone + OIDC + IAM roles).
API Gateway HTTP API proxy keeps GEMINI_API_KEY server-side.
DynamoDB table persists generated summaries.
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


config = pulumi.Config()
domain = config.get("domain") or "yt2txt.willbright.link"

ingress = pulumi.StackReference("flexo333/flexo333-ingress/prod")
zone_id = ingress.get_output("zone_id")

site = StaticSite(
    "yt2txt",
    domain=domain,
    zone_id=zone_id,
    bucket_name="flexo333-yt2txt",
    spa_mode=True,
)

# ── DynamoDB table ────────────────────────────────────────────────────────────
table = aws.dynamodb.Table(
    "summaries",
    name="yt2txt-summaries",
    billing_mode="PAY_PER_REQUEST",
    hash_key="url",
    attributes=[aws.dynamodb.TableAttributeArgs(name="url", type="S")],
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
    policy=table.arn.apply(lambda arn: json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Action": ["dynamodb:PutItem", "dynamodb:Scan"],
            "Resource": arn,
        }],
    })),
)

# ── Lambda function ───────────────────────────────────────────────────────────
summarise_zip = _lambda_archive("../../backend/summarise")

summarise_fn = aws.lambda_.Function(
    "summarise",
    runtime="nodejs20.x",
    handler="handler.handler",
    role=lambda_role.arn,
    code=summarise_zip,
    timeout=120,
    memory_size=256,
    environment=aws.lambda_.FunctionEnvironmentArgs(variables={
        "DYNAMODB_TABLE": table.name,
        "GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY", ""),
    }),
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
        allow_headers=["content-type"],
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
