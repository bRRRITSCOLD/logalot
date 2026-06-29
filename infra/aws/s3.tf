###############################################################################
# s3.tf — cold-tier Parquet + Athena-results buckets
#
# ADR-0005: real S3 unblocks cold_smoke_aws test.
# ADR-0009: lifecycle expiry keeps storage cost bounded.
# ADR-0010: private, SSE-S3 encrypted, versioned (R8).
###############################################################################

locals {
  cold_bucket_name    = "${var.project}-${var.env}-cold"
  athena_bucket_name  = "${var.project}-${var.env}-athena-results"
}

###############################################################################
# Cold-tier bucket (Parquet / Iceberg)
###############################################################################

resource "aws_s3_bucket" "cold" {
  bucket = local.cold_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "cold" {
  bucket = aws_s3_bucket.cold.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "cold" {
  bucket = aws_s3_bucket.cold.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cold" {
  bucket = aws_s3_bucket.cold.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Lifecycle: expire cold objects after retention_days and clean up old versions.
resource "aws_s3_bucket_lifecycle_configuration" "cold" {
  bucket = aws_s3_bucket.cold.id

  rule {
    id     = "expire-cold-data"
    status = "Enabled"

    expiration {
      days = var.cold_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "cold" {
  bucket     = aws_s3_bucket.cold.id
  depends_on = [aws_s3_bucket_public_access_block.cold]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyNonTLS"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.cold.arn,
          "${aws_s3_bucket.cold.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
    ]
  })
}

###############################################################################
# Athena query-results bucket
###############################################################################

resource "aws_s3_bucket" "athena_results" {
  bucket = local.athena_bucket_name
}

resource "aws_s3_bucket_public_access_block" "athena_results" {
  bucket = aws_s3_bucket.athena_results.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "athena_results" {
  bucket = aws_s3_bucket.athena_results.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "athena_results" {
  bucket = aws_s3_bucket.athena_results.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Athena result files are ephemeral; expire after 7 days.
resource "aws_s3_bucket_lifecycle_configuration" "athena_results" {
  bucket = aws_s3_bucket.athena_results.id

  rule {
    id     = "expire-athena-results"
    status = "Enabled"

    expiration {
      days = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 3
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "athena_results" {
  bucket     = aws_s3_bucket.athena_results.id
  depends_on = [aws_s3_bucket_public_access_block.athena_results]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyNonTLS"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.athena_results.arn,
          "${aws_s3_bucket.athena_results.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
    ]
  })
}
