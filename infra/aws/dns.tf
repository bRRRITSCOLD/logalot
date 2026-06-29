###############################################################################
# dns.tf — Route53 hosted zone + A record → EIP
#
# ADR-0010: Route53 hosted zone ($0.50/mo) required for:
#   1. Google OAuth redirect URI (must be a real domain with HTTPS).
#   2. Caddy ACME / Let's Encrypt TLS certificate.
#
# The EIP public IP is supplied via var.eip_public_ip.  When ec2.tf is
# provisioned, replace the variable default with:
#   eip_public_ip = aws_eip.instance.public_ip
###############################################################################

###############################################################################
# Hosted zone
###############################################################################

resource "aws_route53_zone" "main" {
  name    = var.domain_name
  comment = "logalot ${var.env} — managed by Terraform"
}

###############################################################################
# A record → EIP
#
# IPv6 (AAAA) is omitted for PoC; add when VPC IPv6 CIDR is configured.
###############################################################################

resource "aws_route53_record" "a" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 300
  records = [var.eip_public_ip]
}

###############################################################################
# Outputs — nameservers needed for registrar delegation
###############################################################################

output "route53_zone_id" {
  description = "Route53 hosted zone ID"
  value       = aws_route53_zone.main.zone_id
}

output "route53_name_servers" {
  description = "Nameservers to configure at your domain registrar"
  value       = aws_route53_zone.main.name_servers
}
