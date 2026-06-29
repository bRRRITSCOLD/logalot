variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Project name, used as a prefix/tag on all resources."
  type        = string
  default     = "logalot"
}

variable "env" {
  description = "Deployment environment (e.g. poc, staging, prod)."
  type        = string
  default     = "poc"

  validation {
    condition     = contains(["poc", "staging", "prod"], var.env)
    error_message = "env must be one of: poc, staging, prod."
  }
}

variable "state_bucket" {
  description = "Name of the S3 bucket that holds Terraform state. Created by infra/aws/bootstrap before first apply."
  type        = string
}
