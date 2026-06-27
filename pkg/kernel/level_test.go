package kernel

import (
	"encoding/json"
	"testing"
)

func TestParseLevel(t *testing.T) {
	for _, s := range []string{"trace", "debug", "info", "warn", "error", "fatal"} {
		l, err := ParseLevel(s)
		if err != nil {
			t.Fatalf("ParseLevel(%q) error: %v", s, err)
		}
		if l.String() != s {
			t.Fatalf("ParseLevel(%q).String() = %q", s, l.String())
		}
	}
	if _, err := ParseLevel("verbose"); err == nil {
		t.Fatal("ParseLevel(verbose) = nil error, want failure (fail closed)")
	}
	if _, err := ParseLevel(""); err == nil {
		t.Fatal("ParseLevel(\"\") = nil error, want failure")
	}
}

func TestLevelOrderingMatchesDBEnum(t *testing.T) {
	order := []Level{LevelTrace, LevelDebug, LevelInfo, LevelWarn, LevelError, LevelFatal}
	for i := 1; i < len(order); i++ {
		if order[i-1].Rank() >= order[i].Rank() {
			t.Fatalf("ordering broken: %s(%d) !< %s(%d)",
				order[i-1], order[i-1].Rank(), order[i], order[i].Rank())
		}
	}
	if LevelWarn.Rank() < LevelInfo.Rank() {
		t.Fatal("warn must outrank info")
	}
	if Level("bogus").Rank() != -1 {
		t.Fatal("invalid level Rank() must be -1")
	}
}

func TestLevelJSONRoundTrip(t *testing.T) {
	b, err := json.Marshal(LevelError)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `"error"` {
		t.Fatalf("marshal = %s, want \"error\"", b)
	}
	var l Level
	if err := json.Unmarshal(b, &l); err != nil {
		t.Fatal(err)
	}
	if l != LevelError {
		t.Fatalf("unmarshal = %q, want error", l)
	}
}

func TestLevelUnmarshalFailsClosed(t *testing.T) {
	var l Level
	if err := json.Unmarshal([]byte(`"critical"`), &l); err == nil {
		t.Fatal("unmarshal of unknown level succeeded, want failure (fail closed)")
	}
}
