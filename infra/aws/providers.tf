provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project = var.project
      env     = var.env
      managed = "terraform"
    }
  }
}
