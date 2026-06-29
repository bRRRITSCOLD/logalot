# security.tf — EC2 security group
#
# ADR-0009 trust boundary:
#   - Inbound 443  (Caddy/TLS)      open to world (required for real HTTPS)
#   - Inbound 80   (ACME HTTP-01 + HTTP→HTTPS redirect) open to world
#   - Inbound 22   NOT opened by default; only enabled when var.admin_cidr != ""
#                  SSM Session Manager is the preferred admin path (no port 22 needed)
#   - Egress       fully open (IGW reachability: Google JWKS, ACME, ECR, S3)
#
# Security-architect note (spec D3): if SSH must be kept, lock it to an admin CIDR.
# Setting var.admin_cidr="" (default) leaves port 22 closed — policy assertion in
# tests/infra/sg_policy_test.go / scripts/tf-policy-assert.sh verifies this.

resource "aws_security_group" "app" {
  name        = "${local.net_prefix}-app-sg"
  description = "logalot app: HTTPS+HTTP inbound; SSM admin; no open SSH"
  vpc_id      = aws_vpc.main.id

  # ------------------------------------------------------------------
  # Inbound — HTTPS (443)
  # ------------------------------------------------------------------
  ingress {
    description = "HTTPS — Caddy TLS termination"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # ------------------------------------------------------------------
  # Inbound — HTTP (80) — ACME HTTP-01 + redirect to HTTPS
  # ------------------------------------------------------------------
  ingress {
    description = "HTTP — ACME challenge / redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # ------------------------------------------------------------------
  # Inbound — SSH (22) — DISABLED by default; toggled via admin_cidr
  # ------------------------------------------------------------------
  dynamic "ingress" {
    for_each = var.admin_cidr != "" ? [var.admin_cidr] : []

    content {
      description = "SSH — admin CIDR only (fallback; prefer SSM)"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  # ------------------------------------------------------------------
  # Egress — fully open (IGW → internet)
  # ------------------------------------------------------------------
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.net_prefix}-app-sg"
  }
}
