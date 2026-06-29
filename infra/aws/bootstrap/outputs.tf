output "state_bucket_name" {
  description = "Name of the S3 bucket created for Terraform state. Supply this to the main module via -backend-config=\"bucket=<value>\" or backend.hcl."
  value       = aws_s3_bucket.tf_state.bucket
}

output "state_bucket_arn" {
  description = "ARN of the Terraform state S3 bucket."
  value       = aws_s3_bucket.tf_state.arn
}

output "state_bucket_region" {
  description = "Region where the Terraform state S3 bucket was created."
  value       = aws_s3_bucket.tf_state.region
}
