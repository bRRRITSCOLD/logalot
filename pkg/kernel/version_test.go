package kernel

import "testing"

func TestVersionIsScaffoldPlaceholder(t *testing.T) {
	if Version != "0.0.0-scaffold" {
		t.Fatalf("Version = %q, want %q", Version, "0.0.0-scaffold")
	}
}
