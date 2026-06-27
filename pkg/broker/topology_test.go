package broker

import "testing"

func TestDefaultTopology(t *testing.T) {
	got := DefaultTopology()
	want := Topology{
		Exchange:           "logalot.ingest",
		Queue:              "logalot.ingest.events",
		RoutingKey:         "ingest",
		DeadLetterExchange: "logalot.ingest.dlx",
		DeadLetterQueue:    "logalot.ingest.events.dlq",
	}
	if got != want {
		t.Fatalf("DefaultTopology()=%+v, want %+v", got, want)
	}
}

func TestDefaultTopology_DistinctNames(t *testing.T) {
	tp := DefaultTopology()
	// The DLX/DLQ must be distinct objects from the main exchange/queue, else a
	// nacked message would loop back onto the work queue instead of parking.
	if tp.Exchange == tp.DeadLetterExchange {
		t.Error("main exchange and DLX must differ")
	}
	if tp.Queue == tp.DeadLetterQueue {
		t.Error("work queue and DLQ must differ")
	}
}
