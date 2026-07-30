# Lambda Function URL — `lambda:InvokeFunction` permission requirement — design

- **Date:** 2026-07-20
- **Status:** Implemented 2026-07-30 via Option A — the code in this doc is what shipped
- **Scope:** `infra/pulumi/__main__.py`, `infra/pulumi/requirements.txt`
- **Related repo:** `flexo333/my-blog` (`infra/pulumi-ingress`) — owns the CI IAM roles
- **Sibling doc:** same change is required in `flexo333/garmin-health-dashboard`

## Problem

AWS changed the permission model for Lambda function URLs in **October 2025**. From the
[AWS docs](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html):

> Starting in October 2025, new function URLs will require both `lambda:InvokeFunctionUrl`
> and `lambda:InvokeFunction` permissions.

and:

> If a function's resource-based policy doesn't grant `lambda:invokeFunctionUrl` and
> `lambda:InvokeFunction` permissions, users will get a 403 Forbidden error code when they
> try to invoke your function URL. **This will occur even if the function URL uses the
> `NONE` auth type.**

`infra/pulumi/__main__.py` currently grants **only the first of the two**:

```python
url_permission = aws.lambda_.Permission(
    "summarise-url-public",
    action="lambda:InvokeFunctionUrl",   # <-- only half of what AWS now requires
    function=summarise_fn.name,
    principal="*",
    function_url_auth_type="NONE",
)
```

### Why it hasn't broken yet

Function URLs created **before** October 2025 are grandfathered and keep working with the
single permission. That is why this is latent rather than a live outage — and why it will
surface as a sudden, confusing 403 the first time the function URL is recreated.

**This is a trap.** The URL is recreated by anything that replaces the function or the
`FunctionUrl` resource — a rename, a logical-name change, a `pulumi destroy`/`up` cycle, or
a stack rebuild. At that moment the API returns 403 for every caller, the site breaks, and
nothing in the diff will look related to permissions.

A **1 November 2026** enforcement date for pre-existing URLs has been reported in
[terraform-provider-aws#44829](https://github.com/hashicorp/terraform-provider-aws/issues/44829).
Treat that date as *unconfirmed* — it is not stated in the AWS documentation page above — but
it means the grandfathering should not be relied on indefinitely.

## Required end state

Per the AWS docs, an `AuthType: NONE` function URL needs **two** statements in the
function's resource-based policy:

| # | Action | Condition |
|---|---|---|
| 1 | `lambda:InvokeFunctionUrl` | `StringEquals` → `lambda:FunctionUrlAuthType` = `NONE` |
| 2 | `lambda:InvokeFunction` | `Bool` → `lambda:InvokedViaFunctionUrl` = `true` |

The `lambda:InvokedViaFunctionUrl` condition on statement 2 is what keeps the grant narrow:
without it, `principal="*"` on `lambda:InvokeFunction` would let anyone invoke the function
through the **normal Invoke API**, not just through the URL. That is a materially wider grant
than we have today and must not be shipped.

## Blocker: the provider cannot express this today

Statement 2 requires the `invoked_via_function_url` argument on `aws.lambda_.Permission`.
Verified by unzipping the published wheels and grepping `pulumi_aws/lambda_/permission.py`:

| pulumi-aws version | `invoked_via_function_url` |
|---|---|
| 6.83.4 | absent |
| 7.0.0, 7.5.0, 7.10.0, 7.15.0 | absent |
| **7.16.0** through 7.37.0 | **present** |

So the floor is **`pulumi-aws>=7.16.0`**. Note that `>=7.0` is *not* sufficient — the feature
landed mid-7.x, and pinning to the major version alone still leaves you broken.

Two pins blocked that upgrade:

1. `infra/pulumi/requirements.txt` — `pulumi-aws>=6.0.0,<7.0.0`
2. **`pulumi-static-site` v0.1.0** — its own `pyproject.toml` declares `pulumi-aws>=6.0.0,<7.0.0`

The second was the real obstacle. Relaxing only our own pin leaves pip unable to resolve.
Upstream `lukerohde/pulumi-static-site` has only ever tagged `v0.1.0`; both pins are lifted by
Option A below, which is what shipped.

### Two stale signals — do not be misled

- [pulumi/pulumi-aws#5930](https://github.com/pulumi/pulumi-aws/issues/5930) ("missing
  InvokedViaFunctionUrl parameter") is still **open** and labelled `awaiting-upstream`. The
  feature nevertheless shipped. The issue is simply stale; trust the wheel, not the tracker.
- `invoked_via_function_url` shipping in **6.28.0** refers to *terraform*-provider-aws, a
  different numbering line from pulumi-aws. Do not read that as "pulumi-aws 6.x supports it".

## Options

### Option A — bump `pulumi-static-site`, then the provider *(chosen — shipped)*

1. ✅ Fork `lukerohde/pulumi-static-site`; widen its pin to `pulumi-aws>=6.0.0,<8.0.0`; tag
   `v0.2.0`. Done: [`flexo333/pulumi-static-site@v0.2.0`](https://github.com/flexo333/pulumi-static-site)
   is a two-line `pyproject.toml` change and nothing else.
2. ✅ In `infra/pulumi/requirements.txt`: `pulumi-aws>=7.16.0,<8.0.0`, and point the
   `pulumi-static-site` line at the new tag.
3. ✅ Add the second Permission resource (below).
4. Run the v7 state migration: `pulumi up --refresh --run-program`. This happens on merge —
   `deploy-infra.yml` applies on push to `main`.

The v7 migration is low-risk for this stack: the
[7.0 migration guide](https://www.pulumi.com/registry/packages/aws/how-to-guides/7-0-migration/)
lists **no breaking changes** for IAM, Route53, ACM, CloudFront, or Lambda. The S3 changes
(`loggings` → `logging`, `website.routingRules` now string-only, `BucketXV2` superseded) land
inside `pulumi-static-site`, so verify them there rather than here.

The new resource:

```python
url_invoke_permission = aws.lambda_.Permission(
    "summarise-url-invoke",
    action="lambda:InvokeFunction",       # NOT InvokeFunctionUrl
    function=summarise_fn.name,
    principal="*",
    invoked_via_function_url=True,        # requires pulumi-aws >= 7.16.0
)
```

`invoked_via_function_url` is documented in the provider as *"Only valid with
`lambda:InvokeFunction` action"* — so this is a **second, separate** resource. Do not try to
add the flag to the existing `summarise-url-public` permission; that one keeps
`action="lambda:InvokeFunctionUrl"` unchanged.

### Option B — escape hatch, no provider upgrade

If bumping `pulumi-static-site` proves painful, add the statement out-of-band via the AWS CLI
(`aws lambda add-permission --action lambda:InvokeFunction --principal '*'
--invoked-via-function-url --statement-id UrlPolicyInvokeFunction`), driven by a
`pulumi_command.local.Command` so it stays in the graph. Ugly and non-declarative; acceptable
only as a stopgap.

### Option C — rejected

Adding `action="lambda:InvokeFunction"` with `principal="*"` and **no** condition does work on
pulumi-aws 6.x, and will be tempting. **Do not do this.** It grants the whole internet direct
`Invoke` API access to the function, bypassing the URL entirely.

## Ordering constraint — read before touching this code

`CLAUDE.md:84` documents a hard-won gotcha:

> `aws.lambda_.Permission` with `function_url_auth_type="NONE"` **must exist before** the
> `FunctionUrl` is created, otherwise AWS caches a "no public access" authz state that
> survives later policy edits.

The new permission must therefore be added to the `FunctionUrl`'s `depends_on` alongside the
existing one:

```python
opts=pulumi.ResourceOptions(depends_on=[url_permission, url_invoke_permission]),
```

Adding the permission to a **live, already-working** URL is safe and does not require
recreating it. But if the URL does get recreated, both permissions must land first.

This is not hypothetical caution. When the single function was split into web + worker
(2026-07-30), the public function deliberately kept the pre-split `"summarise"` Pulumi name
*specifically* so its Function URL and NONE-auth permission were updated rather than replaced —
see the comment above `summarise_fn` in `__main__.py`. The grandfathering is being preserved by
hand, which is exactly why the missing second statement is worth closing: today the stack is one
accidental resource rename away from a 403 with no obvious cause.

## Out of scope

- **Switching to `AWS_IAM` auth.** The browser calls the function URL directly, cross-origin
  (there is no CloudFront → Lambda origin; the distribution has a single S3 origin). Nothing
  would sign those requests, so `AWS_IAM` would break the site. Separate piece of work.
- **The `x-yt2txt-key` shared secret.** It ships inside the client bundle via
  `VITE_YT2TXT_KEY` and is not a real secret. Unrelated to this change, but worth not
  mistaking for access control while reading this code.

## CI permissions — no change needed

The deploy roles live in `flexo333/my-blog` at `infra/pulumi-ingress/__main__.py:200-208`,
which grants `lambda:*` scoped to `flexo333-*`, `yt2txt-*`, and `summarise-*`. `lambda:*`
covers `AddPermission`, so the infra role can already create this statement.

This works only because both functions are **Pulumi auto-named** — no `name=` argument on
either `aws.lambda_.Function`, so the physical names are `summarise-<hex>` and
`summarise-worker-<hex>`, which both match the `summarise-*` ARN pattern. That match is
incidental. **If either function is ever given an explicit name outside those three prefixes,
CI will start failing with `AccessDenied` on `AddPermission`**, and the fix belongs in the
my-blog ingress stack, not here. (`yt2txt-summarise-poll-rule` is explicitly named for the
same reason — see the comment on `poll_rule` in `__main__.py`.)

## Verification

1. `pulumi preview` shows exactly one new `aws:lambda/permission:Permission`, no replacement
   of `summarise-url` (a planned *replace* on the FunctionUrl means the ordering constraint
   above is now live — stop and re-read that section).
2. Confirm both statements are present:
   ```bash
   aws lambda get-policy --function-name "$(pulumi stack output lambda_function_name)" \
     --query Policy --output text | python3 -m json.tool
   ```
   Expect `lambda:InvokeFunctionUrl` with `lambda:FunctionUrlAuthType = NONE`, **and**
   `lambda:InvokeFunction` with `lambda:InvokedViaFunctionUrl = true`.
3. `curl -i "$(pulumi stack output api_url)"` → not 403.
4. Load https://yt2txt.willbright.link and run a real summarise request.

## Sources

- [Control access to Lambda function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)
- [pulumi-aws 7.0 migration guide](https://www.pulumi.com/registry/packages/aws/how-to-guides/7-0-migration/)
- [pulumi/pulumi-aws#5930](https://github.com/pulumi/pulumi-aws/issues/5930) (open but stale)
- [terraform-provider-aws#44829](https://github.com/hashicorp/terraform-provider-aws/issues/44829)
