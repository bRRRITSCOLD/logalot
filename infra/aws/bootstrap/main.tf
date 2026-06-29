###############################################################################
# bootstrap/main.tf
#
# One-time setup: creates the S3 bucket that stores Terraform state for the
# main infra/aws root module.  Run once per environment with local state,
# then copy the bucket name into your backend.hcl (or -backend-config flag).
#
# Usage:
#   cd infra/aws/bootstrap
#   terraform init
#   terraform apply -var="env=poc"
#   # note the bucket name from outputs, then:
#   cd ..
#   terraform init -backend-config="bucket=<bucket_name>"
###############################################################################

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project   = var.project
      env       = var.env
      managed   = "terraform"
      bootstrap = "true"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  bucket_name = var.state_bucket_name != "" ? var.state_bucket_name : "${var.project}-${var.env}-tf-state-${data.aws_caller_identity.current.account_id}"
}

###############################################################################
# State bucket
###############################################################################

resource "aws_s3_bucket" "tf_state" {
  bucket = local.bucket_name

  # Prevent accidental deletion of state — destroy requires explicit override.
  lifecycle {
    prevent_destroy = true
  }
}

# Block all public access (ADR-0010: state bucket must be private).
resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Enable versioning so state history is retained and accidental deletions are
# recoverable (ADR-0010 state-hardening).
resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Server-side encryption: SSE-S3 (AES-256) — free and sufficient for PoC.
# Upgrade to aws:kms + a CMK for stricter key-access auditing if needed.
resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Deny any unencrypted uploads and non-TLS requests (defence-in-depth).
resource "aws_s3_bucket_policy" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  # Policy depends on public-access block being in place first.
  depends_on = [aws_s3_bucket_public_access_block.tf_state]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyNonTLS"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.tf_state.arn,
          "${aws_s3_bucket.tf_state.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
      {
        Sid       = "DenyUnencryptedUploads"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.tf_state.arn}/*"
        Condition = {
          StringNotEquals = {
            "s3:x-amz-server-side-encryption" = "AES256"
          }
        }
      },
    ]
  })
}
