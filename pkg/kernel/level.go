package kernel

import (
	"encoding/json"
	"fmt"
	"slices"
)

// Level is a log severity. The set and ordering mirror the Postgres `log_level`
// enum exactly (migrations/000002_enums.up.sql, docs/data/model.md §5.1):
//
//	trace < debug < info < warn < error < fatal
//
// It is a string type so it (de)serializes stably as the same text the database
// stores, while Rank exposes the ordering for `level >= 'warn'` style filters.
type Level string

const (
	LevelTrace Level = "trace"
	LevelDebug Level = "debug"
	LevelInfo  Level = "info"
	LevelWarn  Level = "warn"
	LevelError Level = "error"
	LevelFatal Level = "fatal"
)

// orderedLevels is the single source of the enum's order (DRY).
var orderedLevels = []Level{LevelTrace, LevelDebug, LevelInfo, LevelWarn, LevelError, LevelFatal}

// Valid reports whether l is one of the known levels.
func (l Level) Valid() bool {
	return slices.Contains(orderedLevels, l)
}

// Rank returns the severity rank (trace=0 … fatal=5), or -1 if invalid. Use it
// for severity comparisons; the wire/DB form remains the string.
func (l Level) Rank() int {
	return slices.Index(orderedLevels, l)
}

// String returns the canonical text form.
func (l Level) String() string { return string(l) }

// ParseLevel parses the canonical text form, failing closed on anything unknown.
func ParseLevel(s string) (Level, error) {
	l := Level(s)
	if !l.Valid() {
		return "", fmt.Errorf("kernel: invalid log level %q", s)
	}
	return l, nil
}

// UnmarshalJSON validates on the way in: an unknown level from an untrusted
// payload is rejected rather than silently accepted (fail closed). Marshaling
// uses the default string encoding.
func (l *Level) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	parsed, err := ParseLevel(s)
	if err != nil {
		return err
	}
	*l = parsed
	return nil
}
