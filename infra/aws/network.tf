# network.tf — VPC, public subnet, IGW, route table
#
# ADR-0009: one VPC, one public subnet, one IGW; no NAT gateway (cost NFR).
# The EC2 instance reaches the internet (Google JWKS, ACME, S3) directly through
# the IGW. Inbound control lives in the security group (security.tf), not in a
# private subnet.

locals {
  # Consistent name prefix used across all network resources.
  net_prefix = "${var.project}-${var.env}"
}

# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${local.net_prefix}-vpc"
  }
}

# ---------------------------------------------------------------------------
# Public subnet
# ---------------------------------------------------------------------------

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.net_prefix}-public-subnet"
  }
}

# ---------------------------------------------------------------------------
# Internet Gateway
# ---------------------------------------------------------------------------

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.net_prefix}-igw"
  }
}

# ---------------------------------------------------------------------------
# Route table — public (0.0.0.0/0 via IGW)
# ---------------------------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.net_prefix}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}
