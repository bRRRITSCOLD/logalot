###############################################################################
# iam.tf — additional policy attachments for the EC2 instance role
#
# The IAM role and instance profile are defined in ssm.tf (where the
# trust policy and SSM SecureString read policy also live).  This file
# adds the two remaining policy attachments:
#
#   1. AmazonSSMManagedInstanceCore   — AWS-managed; enables SSM Session
#      Manager, Run Command, Patch Manager, and the CloudWatch agent install.
#      Required per ADR-0009 (no open SSH; SSM is the admin path) and R8.
#
#   2. s3_cold_access (inline policy) — least-privilege S3 read/write scoped
#      to the cold-tier bucket only.  The processor and retention-worker
#      services write/read Parquet; Athena (Glue) also reads via this role.
#
# IAM principal chain:
#   aws_iam_role.ec2_instance (ssm.tf)
#   ├── aws_iam_role_policy_attachment.ec2_ssm_managed_core   (here)
#   ├── aws_iam_role_policy_attachment.ec2_ssm_read           (ssm.tf)
#   └── aws_iam_role_policy_attachment.ec2_s3_cold            (here)
###############################################################################

###############################################################################
# 1. AmazonSSMManagedInstanceCore
#    Enables SSM agent features: Session Manager, Run Command, Patch Manager,
#    Parameter Store access via the agent, CloudWatch agent registration.
###############################################################################

resource "aws_iam_role_policy_attachment" "ec2_ssm_managed_core" {
  role       = aws_iam_role.ec2_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

###############################################################################
# 2. S3 cold-tier access (least-privilege, scoped to cold bucket)
#
# The EC2-hosted containers need:
#   - s3:PutObject / s3:GetObject / s3:DeleteObject   — processor, retention
#   - s3:ListBucket                                   — Athena partition listing
#
# Scope: cold bucket only.  The Athena-results bucket is written by the Athena
# service principal (not the EC2 role), so no additional permissions needed.
###############################################################################

data "aws_iam_policy_document" "s3_cold_access" {
  # Object-level operations on the cold bucket.
  statement {
    sid    = "S3ColdObjectAccess"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]

    resources = [
      "${aws_s3_bucket.cold.arn}/*",
    ]
  }

  # Bucket-level listing required by Athena partition discovery.
  statement {
    sid    = "S3ColdBucketList"
    effect = "Allow"

    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]

    resources = [
      aws_s3_bucket.cold.arn,
    ]
  }
}

resource "aws_iam_policy" "s3_cold_access" {
  name        = "${var.project}-${var.env}-s3-cold-access"
  description = "Least-privilege S3 access to the ${var.project}-${var.env} cold bucket (ADR-0005, ADR-0009)"
  policy      = data.aws_iam_policy_document.s3_cold_access.json
}

resource "aws_iam_role_policy_attachment" "ec2_s3_cold" {
  role       = aws_iam_role.ec2_instance.name
  policy_arn = aws_iam_policy.s3_cold_access.arn
}
