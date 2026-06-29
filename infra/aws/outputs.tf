# outputs.tf — exported values from the root module

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

output "vpc_id" {
  description = "ID of the main VPC."
  value       = aws_vpc.main.id
}

output "public_subnet_id" {
  description = "ID of the public subnet (used for EC2 placement)."
  value       = aws_subnet.public.id
}

output "internet_gateway_id" {
  description = "ID of the Internet Gateway."
  value       = aws_internet_gateway.main.id
}

# ---------------------------------------------------------------------------
# Security
# ---------------------------------------------------------------------------

output "app_security_group_id" {
  description = "ID of the app security group. Attach to the EC2 instance."
  value       = aws_security_group.app.id
}

# ---------------------------------------------------------------------------
# Cold-tier (S3 / Glue / Athena) — consumed by the cold_smoke_aws CI job
# ---------------------------------------------------------------------------

output "cold_bucket" {
  description = "Name of the cold-tier Parquet S3 bucket."
  value       = aws_s3_bucket.cold.bucket
}

output "cold_glue_db" {
  description = "Name of the Glue catalog database for cold-tier tables."
  value       = aws_glue_catalog_database.cold.name
}

output "cold_athena_result_bucket" {
  description = "Name of the S3 bucket that stores Athena query results (s3://<bucket>/results/)."
  value       = aws_s3_bucket.athena_results.bucket
}

output "cold_athena_workgroup" {
  description = "Name of the Athena workgroup scoped to the cold-tier result bucket."
  value       = aws_athena_workgroup.main.name
}

output "ci_smoke_role_arn" {
  description = "ARN of the GitHub Actions OIDC role for the cold_smoke_aws CI job."
  value       = aws_iam_role.ci_smoke.arn
}
