// Package e2e holds the vertical-slice end-to-end test for logalot (issue #9).
//
// The actual test lives in slice_e2e_test.go behind the `e2e` build tag, so the
// default `go test ./...` (and therefore CI's unit suite) never compiles or runs
// it. Run the slice proof explicitly with Docker available:
//
//	go test -tags=e2e -run TestSliceE2E ./...
//
// This file exists only so the module has a non-test, untagged package, keeping
// `go build ./...` / `go vet ./...` happy across the workspace when the e2e tag
// is absent.
package e2e
