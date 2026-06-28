// Package coldtiersmoke contains the real-AWS cold-tier CI smoke test
// (ADR-0005, decision 016 §7). It validates end-to-end behaviour against
// genuine AWS services: S3 Parquet writes, Glue table registration with
// injected-projection DDL, and Athena canary queries — including the
// no-tenant query that must be rejected before reaching Athena.
//
// Build tag: cold_smoke_aws
// Run:
//
//	AWS_REGION=us-east-1 \
//	COLD_BUCKET=logalot-cold-smoke \
//	COLD_GLUE_DB=logalot_cold_smoke \
//	COLD_ATHENA_RESULT_BUCKET=s3://logalot-cold-smoke-results/ \
//	go test -tags=cold_smoke_aws -v -timeout 600s \
//	    github.com/bRRRITSCOLD/logalot/tests/cold-tier-smoke
//
// AWS credential chain (IAM role or profile) must have:
//   - s3:PutObject, s3:GetObject, s3:ListBucket on COLD_BUCKET
//   - glue:CreateDatabase, glue:CreateTable, glue:CreatePartition, glue:GetPartition
//   - athena:StartQueryExecution, athena:GetQueryExecution, athena:GetQueryResults
//   - s3:PutObject on COLD_ATHENA_RESULT_BUCKET
//
// This test is intentionally NOT run in normal CI — it requires real AWS
// credentials and is gated in a separate workflow job that runs only on
// repository_dispatch or manual trigger (decision 016 §7).
package coldtiersmoke
