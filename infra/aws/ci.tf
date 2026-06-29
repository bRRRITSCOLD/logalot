###############################################################################
# ci.tf — GitHub Actions OIDC trust for the cold_smoke_aws CI job
#
# Decision 016 §7 requires a gated, real-AWS smoke canary before
# COLD_ENABLED=true is merged to main. This file provisions:
#
#   1. aws_iam_openid_connect_provider.github — the GitHub OIDC IdP (created
#      once per account; guarded by `create_oidc_provider`).
#   2. aws_iam_role.ci_smoke — assumed by GitHub Actions runners via OIDC;
#      trust policy scoped to the `bRRRITSCOLD/logalot` repo only.
#   3. aws_iam_role_policy.ci_smoke — least-privilege inline policy:
#        • S3 r/w on the cold bucket (Archive + GetObject for Athena).
#        • S3 r/w on the Athena-results bucket.
#        • Glue GetTable / CreatePartition / GetPartition (EnsureGlueTable).
#        • Athena StartQueryExecution / GetQueryExecution / GetQueryResults.
#        • SSM GetParameter (read cold-tier resource names at runtime).
#
# ADR-0010: no long-lived CI credentials; OIDC tokens are ephemeral.
# ADR-0011: per-job scope is `sts:AssumeRoleWithWebIdentity` only.
# R8: every policy is least-privilege.
###############################################################################

variable "create_oidc_provider" {
  description = "Set to false if the github.com OIDC provider already exists in this AWS account."
  type        = bool
  default     = true
}

variable "github_repo" {
  description = "GitHub repo in owner/name format. Used to scope the OIDC trust condition."
  type        = string
  default     = "bRRRITSCOLD/logalot"
}

###############################################################################
# 1. GitHub OIDC provider
###############################################################################

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # GitHub publishes its thumbprints at
  # https://github.blog/changelog/2023-06-27-github-actions-update-on-oidc-integration-with-aws/
  # AWS now validates the OIDC JWT signature directly, so the thumbprint value
  # is informational. Pinning the current value keeps the resource stable.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  # Resolve the OIDC provider ARN whether we created it above or it pre-exists.
  github_oidc_provider_arn = var.create_oidc_provider ? (
    aws_iam_openid_connect_provider.github[0].arn
  ) : "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

###############################################################################
# 2. CI smoke role
###############################################################################

data "aws_iam_policy_document" "ci_smoke_assume" {
  statement {
    sid     = "GitHubOIDCAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Restrict to the exact repo; `repo:owner/name:*` matches any branch/PR/tag.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

resource "aws_iam_role" "ci_smoke" {
  name               = "${var.project}-${var.env}-ci-smoke"
  description        = "GitHub Actions OIDC role for the cold_smoke_aws CI job (ADR-0010, ADR-0011)"
  assume_role_policy = data.aws_iam_policy_document.ci_smoke_assume.json
}

###############################################################################
# 3. Least-privilege inline policy
###############################################################################

data "aws_iam_policy_document" "ci_smoke" {
  # -------------------------------------------------------------------------
  # S3 — cold-tier bucket (Archive writes + Athena reads)
  # -------------------------------------------------------------------------
  statement {
    sid    = "S3ColdObjects"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]

    resources = ["${aws_s3_bucket.cold.arn}/*"]
  }

  statement {
    sid    = "S3ColdBucket"
    effect = "Allow"

    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]

    resources = [aws_s3_bucket.cold.arn]
  }

  # -------------------------------------------------------------------------
  # S3 — Athena-results bucket
  # -------------------------------------------------------------------------
  statement {
    sid    = "S3AthenaResults"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:ListBucket",
    ]

    resources = [
      aws_s3_bucket.athena_results.arn,
      "${aws_s3_bucket.athena_results.arn}/*",
    ]
  }

  # -------------------------------------------------------------------------
  # Glue — EnsureGlueTable (GetDatabase / GetTable / CreateTable) +
  #         partition management (CreatePartition / GetPartition)
  # -------------------------------------------------------------------------
  statement {
    sid    = "GlueColdTier"
    effect = "Allow"

    actions = [
      "glue:GetDatabase",
      "glue:GetTable",
      "glue:CreateTable",
      "glue:UpdateTable",
      "glue:CreatePartition",
      "glue:GetPartition",
      "glue:BatchCreatePartition",
    ]

    resources = [
      "arn:aws:glue:${var.aws_region}:${data.aws_caller_identity.current.account_id}:catalog",
      "arn:aws:glue:${var.aws_region}:${data.aws_caller_identity.current.account_id}:database/${aws_glue_catalog_database.cold.name}",
      "arn:aws:glue:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${aws_glue_catalog_database.cold.name}/*",
    ]
  }

  # -------------------------------------------------------------------------
  # Athena — run queries via the scoped workgroup
  # -------------------------------------------------------------------------
  statement {
    sid    = "AthenaQuery"
    effect = "Allow"

    actions = [
      "athena:StartQueryExecution",
      "athena:GetQueryExecution",
      "athena:GetQueryResults",
      "athena:StopQueryExecution",
      "athena:GetWorkGroup",
    ]

    resources = [
      "arn:aws:athena:${var.aws_region}:${data.aws_caller_identity.current.account_id}:workgroup/${aws_athena_workgroup.main.name}",
    ]
  }
}

resource "aws_iam_role_policy" "ci_smoke" {
  name   = "ci-smoke-least-privilege"
  role   = aws_iam_role.ci_smoke.id
  policy = data.aws_iam_policy_document.ci_smoke.json
}
