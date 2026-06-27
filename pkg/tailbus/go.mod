module github.com/bRRRITSCOLD/logalot/pkg/tailbus

go 1.26

require (
	github.com/bRRRITSCOLD/logalot/pkg/kernel v0.0.0
	github.com/redis/go-redis/v9 v9.15.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
)

replace github.com/bRRRITSCOLD/logalot/pkg/kernel => ../kernel
