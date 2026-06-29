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

variable "cold_retention_days" {
  description = "Number of days before cold-tier Parquet objects are expired by S3 lifecycle (ADR-0009/0005)."
  type        = number
  default     = 90

  validation {
    condition     = var.cold_retention_days >= 1
    error_message = "cold_retention_days must be at least 1."
  }
}

variable "domain_name" {
  description = "Primary domain name for the logalot PoC (e.g. logalot.example.com). Required for Google OAuth redirect URI and TLS (ADR-0010)."
  type        = string
}

variable "eip_public_ip" {
  description = "Public IP of the EC2 Elastic IP. Set to aws_eip.instance.public_ip once ec2.tf is provisioned."
  type        = string
  default     = ""

  # Forward-wiring: intentionally empty until ec2.tf is provisioned. Apply with
  # -target flags or supply the real IP to avoid aws_route53_record getting
  # records=[""] which would fail or silently produce a broken record.
  validation {
    condition     = var.eip_public_ip == "" || can(regex("^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$", var.eip_public_ip))
    error_message = "eip_public_ip must be a valid IPv4 address or empty string (forward-wiring placeholder)."
  }
}

variable "ec2_instance_id" {
  description = "EC2 instance ID used for CloudWatch alarm dimensions. Set to aws_instance.main.id once ec2.tf is provisioned."
  type        = string
  default     = ""

  # Forward-wiring: intentionally empty until ec2.tf is provisioned. Apply with
  # -target flags or supply the real instance ID to avoid CloudWatch alarm
  # dimensions keying on InstanceId="" (permanently INSUFFICIENT_DATA).
  validation {
    condition     = var.ec2_instance_id == "" || can(regex("^i-[0-9a-f]+$", var.ec2_instance_id))
    error_message = "ec2_instance_id must be a valid EC2 instance ID (i-...) or empty string (forward-wiring placeholder)."
  }
}

variable "alert_email" {
  description = "Email address for CloudWatch and Budget alert notifications (ADR-0011)."
  type        = string
}
