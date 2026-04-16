"""
yt2txt — yt2txt.willbright.link
S3 + CloudFront SPA, shares ingress stack (Route53 zone + OIDC + IAM roles).
"""

import pulumi
from pulumi_static_site import StaticSite

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

pulumi.export("bucket", site.bucket_name)
pulumi.export("distribution_id", site.distribution_id)
pulumi.export("cloudfront_domain", site.distribution_domain.apply(lambda d: f"https://{d}"))
pulumi.export("aws_region", pulumi.Config("aws").require("region"))
