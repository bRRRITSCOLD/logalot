# outputs.tf — exported values from the root module

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

output "vpc_id" {
  description = "ID of the main VPC."
  value       = aws_vpc.main.id
}

output "public_subnet_id" {
  description = "ID of the public subnet (used for EC2 placement)."
  value       = aws_subnet.public.id
}

output "internet_gateway_id" {
  description = "ID of the Internet Gateway."
  value       = aws_internet_gateway.main.id
}

# ---------------------------------------------------------------------------
# Security
# ---------------------------------------------------------------------------

output "app_security_group_id" {
  description = "ID of the app security group. Attach to the EC2 instance."
  value       = aws_security_group.app.id
}
