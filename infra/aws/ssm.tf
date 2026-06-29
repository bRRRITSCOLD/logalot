###############################################################################
# ssm.tf — SSM Parameter Store placeholders (SecureString)
#
# ADR-0010: all secrets are SSM SecureString with default KMS key (aws/ssm).
# The EC2 instance reads these at boot via a least-privilege IAM instance
# profile scoped to ssm:GetParameter* on /logalot/<env>/* only (R8).
#
# These are placeholder parameters.  Real values must be written out-of-band
# (e.g. `aws ssm put-parameter --overwrite --value "<real>"`) before the first
# `docker compose up` on the instance.  Terraform manages the parameter paths
# and metadata; it does NOT commit secrets to state.
#
# Parameter hierarchy: /logalot/<env>/<service>/<name>
###############################################################################

# ---------------------------------------------------------------------------
# Google OAuth (control-plane)
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "google_client_id" {
  name        = "/logalot/${var.env}/oauth/google/client_id"
  description = "Google OAuth 2.0 client ID (control-plane)"
  type        = "SecureString"
  value       = "REPLACE_ME"

  lifecycle {
    # Terraform manages the path; real value is written out-of-band.
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "google_client_secret" {
  name        = "/logalot/${var.env}/oauth/google/client_secret"
  description = "Google OAuth 2.0 client secret (control-plane)"
  type        = "SecureString"
  value       = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

# ---------------------------------------------------------------------------
# Auth / session keys (control-plane)
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "jwt_signing_key" {
  name        = "/logalot/${var.env}/auth/jwt_signing_key"
  description = "JWT signing key (HS256, control-plane)"
  type        = "SecureString"
  value       = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "refresh_token_pepper" {
  name        = "/logalot/${var.env}/auth/refresh_token_pepper"
  description = "Refresh-token HMAC pepper (control-plane)"
  type        = "SecureString"
  value       = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "cookie_seal_key" {
  name        = "/logalot/${var.env}/web/cookie_seal_key"
  description = "BFF cookie seal key (web / TanStack Start)"
  type        = "SecureString"
  value       = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

# ---------------------------------------------------------------------------
# Backing-store credentials (self-hosted containers on the EC2 box)
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "postgres_password" {
  name        = "/logalot/${var.env}/postgres/password"
  description = "Postgres superuser password"
  type        = "SecureString"
  value       = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "redis_password" {
  name        = "/logalot/${var.env}/redis/password"
  description = "Redis AUTH password"
  type        = "SecureString"
  value       = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "rabbitmq_password" {
  name        = "/logalot/${var.env}/rabbitmq/password"
  description = "RabbitMQ default user password"
  type        = "SecureString"
  value       = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

###############################################################################
# IAM instance profile — least-privilege SSM read
#
# R8 / ADR-0010: scoped to ssm:GetParameter* on /logalot/<env>/oauth/google/*
# and the full /logalot/<env>/* path.  No ssm:* / Resource:* permitted.
###############################################################################

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "ec2_instance" {
  name               = "${var.project}-${var.env}-ec2-instance"
  description        = "EC2 instance role for logalot ${var.env}"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

data "aws_iam_policy_document" "ssm_read" {
  # Allow GetParameter* on the full /logalot/<env>/* hierarchy.
  statement {
    sid    = "SSMReadLogalotPath"
    effect = "Allow"

    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]

    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/logalot/${var.env}/*",
    ]
  }

  # Allow decryption of SecureString values with the default aws/ssm KMS key.
  # Alias ARN format: arn:aws:kms:<region>:<account>:alias/aws/ssm
  statement {
    sid    = "KMSDecryptSSM"
    effect = "Allow"

    actions = ["kms:Decrypt"]

    resources = [
      "arn:aws:kms:${var.aws_region}:${data.aws_caller_identity.current.account_id}:alias/aws/ssm",
    ]
  }
}

resource "aws_iam_policy" "ssm_read" {
  name        = "${var.project}-${var.env}-ssm-read"
  description = "Least-privilege SSM read for logalot ${var.env} parameters (ADR-0010, R8)"
  policy      = data.aws_iam_policy_document.ssm_read.json
}

resource "aws_iam_role_policy_attachment" "ec2_ssm_read" {
  role       = aws_iam_role.ec2_instance.name
  policy_arn = aws_iam_policy.ssm_read.arn
}

resource "aws_iam_instance_profile" "ec2_instance" {
  name = "${var.project}-${var.env}-ec2-instance"
  role = aws_iam_role.ec2_instance.name
}

###############################################################################
# Caller identity (used for ARN construction above)
###############################################################################

data "aws_caller_identity" "current" {}
