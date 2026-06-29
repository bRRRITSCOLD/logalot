terraform {
  # S3 native state locking (conditional writes) requires >= 1.10.
  # https://developer.hashicorp.com/terraform/language/backend/s3#native-s3-state-locking
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
