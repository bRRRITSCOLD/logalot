variable "aws_region" {
  description = "AWS region for the Terraform state bucket."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Project name, used as a prefix on the bucket name."
  type        = string
  default     = "logalot"
}

variable "env" {
  description = "Deployment environment (e.g. poc, staging, prod)."
  type        = string
  default     = "poc"
}

variable "state_bucket_name" {
  description = "Globally unique name for the Terraform state S3 bucket. Defaults to '<project>-<env>-tf-state-<account_id>'. Override when necessary."
  type        = string
  default     = ""
}
