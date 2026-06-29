terraform {
  backend "s3" {
    # Bucket name is supplied via -backend-config on first init or from
    # a backend.hcl file (not committed — contains account-specific names).
    # See infra/aws/bootstrap/ to create the bucket.
    #
    # bucket = "<created by bootstrap>"
    key    = "logalot/poc/terraform.tfstate"
    region = "us-east-1"

    # SSE-S3 encryption at rest (free; ADR-0010).
    # For higher assurance switch to sse_kms_key_id = "<key-arn>".
    encrypt = true

    # Native S3 state locking — no DynamoDB lock table needed (Terraform >= 1.10).
    # https://developer.hashicorp.com/terraform/language/backend/s3#native-s3-state-locking
    use_lockfile = true
  }
}
