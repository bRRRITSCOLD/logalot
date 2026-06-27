// Package httpkit provides shared HTTP transport utilities for logalot services.
// It keeps security-sensitive helpers — notably credential parsing — as a single
// source of truth so ingest-service and query-service cannot drift independently.
//
// The package deliberately avoids Gin coupling: all functions operate on
// *net/http.Request so they are usable from any HTTP framework or in plain
// tests without spinning up a router.
package httpkit
