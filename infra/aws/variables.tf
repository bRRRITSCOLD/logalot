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

# ---------------------------------------------------------------------------
# Network variables
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the VPC (ADR-0009: one VPC, public subnet, no NAT)."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr" {
  description = "CIDR block for the single public subnet."
  type        = string
  default     = "10.0.1.0/24"
}

variable "availability_zone" {
  description = "Availability zone for the public subnet and EC2 instance."
  type        = string
  default     = "us-east-1a"
}

# ---------------------------------------------------------------------------
# Security / admin access
# ---------------------------------------------------------------------------

variable "admin_cidr" {
  description = <<-EOT
    CIDR that may reach port 22 via SSH (e.g. \"203.0.113.10/32\").
    Leave empty (default) to keep port 22 closed — use SSM Session Manager instead.
    Per ADR-0009 / spec D3: SSM is the preferred admin path; SSH is a togglable fallback.
  EOT
  type        = string
  default     = ""

  validation {
    condition = (
      var.admin_cidr == "" ||
      can(cidrnetmask(var.admin_cidr))
    )
    error_message = "admin_cidr must be a valid CIDR block (e.g. 203.0.113.10/32) or empty string."
  }
}
