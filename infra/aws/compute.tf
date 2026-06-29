###############################################################################
# compute.tf — EC2 t4g.small + EIP + gp3 root volume
#
# ADR-0009: one public-subnet EC2 instance; no NAT gateway.
# ADR-0011: t4g.small ARM64 (2 vCPU / 2 GiB RAM); 30 GiB gp3 root;
#           ~2 GiB swap file created by user-data for burst headroom.
#
# Sizing decision (ADR-0011):
#   t4g.small  = $0.0168/hr ≈ $12/mo; acceptable PoC spend ceiling.
#   t4g.medium = resize target if sustained mem_used_percent > 90 % (15 min).
#
# Apply order note: network.tf + security.tf + ssm.tf (T16) must be applied
# before this file (T17).  dns.tf (T18) can follow immediately after the EIP
# is allocated.
###############################################################################

###############################################################################
# AMI — latest Amazon Linux 2023 for ARM64
###############################################################################

data "aws_ami" "al2023_arm64" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-arm64"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

###############################################################################
# EC2 instance
###############################################################################

resource "aws_instance" "main" {
  ami                         = data.aws_ami.al2023_arm64.id
  instance_type               = "t4g.small"
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.ec2_instance.name
  # Keep the auto-assigned public IP so the instance has outbound internet
  # access from first boot (when user-data runs network-dependent commands like
  # `dnf update`, `git clone`, and `docker compose --pull always`).  The EIP
  # is attached asynchronously by aws_eip_association AFTER the instance reaches
  # "running", so relying on the EIP alone would leave user-data without a
  # route to the internet during the critical bootstrap window.  The subnet
  # default (map_public_ip_on_launch = true) already does this; the explicit
  # `true` here makes the intent clear.
  associate_public_ip_address = true

  # user-data: Docker, swap, SSM → .env, compose up
  user_data = templatefile(
    "${path.module}/templates/user-data.sh.tftpl",
    {
      project               = var.project
      env                   = var.env
      aws_region            = var.aws_region
      cold_bucket           = aws_s3_bucket.cold.bucket
      athena_results_bucket = aws_s3_bucket.athena_results.bucket
      glue_db               = aws_glue_catalog_database.cold.name
      app_version           = var.app_version
      image_tag             = var.image_tag
    }
  )

  # Keep user-data changes from replacing the instance unexpectedly.
  user_data_replace_on_change = false

  # Enforce IMDSv2 (session-oriented metadata requests).
  # http_tokens = "required" blocks the single-GET IMDSv1 path that any SSRF or
  # container-level request could use to steal the instance-role credentials
  # (which hold ssm:GetParameter* + kms:Decrypt over all app secrets).
  # hop_limit = 2 allows Docker containers on the bridge network to reach IMDS
  # when they legitimately need instance identity; set to 1 if no containers
  # require IMDS access.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 30
    delete_on_termination = true
    encrypted             = true

    tags = {
      Name = "${var.project}-${var.env}-root"
    }
  }

  tags = {
    Name = "${var.project}-${var.env}-app"
  }

  lifecycle {
    # Prevent accidental termination of the instance by a plan/apply.
    prevent_destroy = true

    # AMI updates should not force-replace; handle via instance refresh or
    # manual AMI update and taint.
    ignore_changes = [ami]
  }
}

###############################################################################
# Elastic IP
###############################################################################

resource "aws_eip" "instance" {
  domain = "vpc"

  tags = {
    Name = "${var.project}-${var.env}-eip"
  }
}

resource "aws_eip_association" "instance" {
  instance_id   = aws_instance.main.id
  allocation_id = aws_eip.instance.id
}

###############################################################################
# Outputs — used by dns.tf, observability.tf, and operators
###############################################################################

output "instance_id" {
  description = "EC2 instance ID (set ec2_instance_id in tfvars for CloudWatch alarm dimensions)."
  value       = aws_instance.main.id
}

output "eip_public_ip" {
  description = "Elastic IP public address (set eip_public_ip in tfvars for Route53 A record)."
  value       = aws_eip.instance.public_ip
}

output "ami_id" {
  description = "Amazon Linux 2023 ARM64 AMI used for the EC2 instance."
  value       = data.aws_ami.al2023_arm64.id
}
