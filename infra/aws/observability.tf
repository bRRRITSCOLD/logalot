###############################################################################
# observability.tf — CloudWatch OOM alarm + AWS Budget ($30 @ 80/100%)
#
# ADR-0011: t4g.small is tight (~200 MB headroom). The OOM alarm is the
# trigger to resize → t4g.medium.  The Budget alarm guards total spend.
#
# The CloudWatch mem_used_percent metric is published by the CloudWatch agent
# running on the EC2 instance (configured in ec2.tf user-data).
# The instance ID is supplied via var.ec2_instance_id; when ec2.tf is
# provisioned, replace with: ec2_instance_id = aws_instance.main.id
###############################################################################

###############################################################################
# SNS topic — single sink for all alarms
###############################################################################

resource "aws_sns_topic" "alerts" {
  name = "${var.project}-${var.env}-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

###############################################################################
# CloudWatch alarm — memory pressure
#
# ADR-0011 trigger: "sustained memory pressure (>90% for 15 min) OR any
# OOMKilled container event → resize to t4g.medium".
#
# MemoryUtilization is a custom metric from the CloudWatch agent
# (namespace = CWAgent, metric = mem_used_percent).
###############################################################################

resource "aws_cloudwatch_metric_alarm" "high_mem" {
  alarm_name          = "${var.project}-${var.env}-high-memory"
  alarm_description   = "EC2 memory utilisation >90% for 15 min — resize to t4g.medium (ADR-0011)"
  comparison_operator = "GreaterThanThreshold"
  # 3 × 5-min periods = 15 min sustained threshold (ADR-0011).
  evaluation_periods = 3
  period             = 300
  statistic          = "Average"
  threshold          = 90
  treat_missing_data = "missing"

  namespace   = "CWAgent"
  metric_name = "mem_used_percent"

  dimensions = {
    InstanceId = var.ec2_instance_id
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

###############################################################################
# AWS Budget — $30/mo with actual 80%, actual 100%, and forecast 100% alerts
#
# ADR-0011: first two budgets are free.
###############################################################################

resource "aws_budgets_budget" "monthly" {
  name         = "${var.project}-${var.env}-monthly"
  budget_type  = "COST"
  limit_amount = "30"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Filter to this project via the "project" cost-allocation tag
  # (applied by default_tags in providers.tf).
  # Format: "user:<tag-key>$<tag-value>" — note the literal "$" separator.
  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:project$%s", var.project)]
  }

  # 80% of $30 = $24 actual spend alert.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  # 100% of $30 actual spend alert.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  # Forecasted overage — fires before the bill lands.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
