###############################################################################
# glue.tf — AWS Glue catalog database + Athena workgroup
#
# ADR-0005: Glue Data Catalog + Athena for cold-tier queries (pay-per-scan).
# Glue catalog itself is free; Athena charges $5/TB scanned.
###############################################################################

resource "aws_glue_catalog_database" "cold" {
  name        = "${var.project}_${var.env}"
  description = "logalot cold-tier Parquet tables (${var.env})"
}

###############################################################################
# Athena workgroup
#
# Scopes result output to the athena-results bucket and enforces per-query
# data-scan limits to prevent runaway costs (ADR-0011).
###############################################################################

resource "aws_athena_workgroup" "main" {
  name        = "${var.project}-${var.env}"
  description = "logalot Athena workgroup (${var.env})"
  state       = "ENABLED"

  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true

    result_configuration {
      output_location = "s3://${aws_s3_bucket.athena_results.bucket}/results/"

      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }

    # Hard limit per query: 1 GB — prevents accidental full-table scans blowing cost.
    bytes_scanned_cutoff_per_query = 1073741824
  }
}
