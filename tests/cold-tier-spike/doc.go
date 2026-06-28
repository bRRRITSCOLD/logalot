// Package coldtierspike is the reproducible integration test for the
// Firehose→Parquet + Glue cataloging fidelity spike (issue #13).
//
// It validates the cold-tier design documented in docs/data/cold-tier.md §1–3
// against compose floci (image floci/floci:1.5.28) — the project's AWS-local
// emulator. Localstack is explicitly excluded (ADR-0005 / NFR floci gaps).
//
// Run against a live compose stack (make up first):
//
//	go test -tags=floci_spike -run TestColdTierFidelity -v -timeout 300s ./tests/cold-tier-spike/...
//
// The FLOCI_ENDPOINT env var defaults to http://localhost:4566. The test reads
// AWS credentials from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (compose .env
// defaults: "test"/"test").
//
// This file exists so the module has a non-test, untagged package and does not
// confuse go build ./... / go vet ./... when the floci_spike tag is absent.
package coldtierspike
