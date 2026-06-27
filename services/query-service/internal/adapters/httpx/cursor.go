package httpx

import (
	"encoding/base64"
	"encoding/json"
	"errors"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// errBadCursor is the single opaque error a malformed cursor produces; the edge
// maps it to 400 without revealing the encoding internals.
var errBadCursor = errors.New("invalid cursor")

// encodeCursor renders a keyset cursor as an opaque, URL-safe token. The token is
// just base64(JSON{ts,id}) — clients MUST treat it as opaque and only round-trip
// it back via ?cursor=. A nil cursor (final page) encodes to the empty string so
// the response simply omits nextCursor.
func encodeCursor(c *kernel.Cursor) string {
	if c == nil {
		return ""
	}
	b, err := json.Marshal(c)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// decodeCursor parses an opaque token from ?cursor= back into a keyset position.
// An empty token means "first page" (nil, nil). Anything that does not decode to
// a complete (ts, id) position is rejected with errBadCursor so a tampered or
// truncated token is a 400, never a silent full scan from the top.
func decodeCursor(token string) (*kernel.Cursor, error) {
	if token == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return nil, errBadCursor
	}
	var c kernel.Cursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, errBadCursor
	}
	if c.ID == "" || c.TS.IsZero() {
		return nil, errBadCursor
	}
	return &c, nil
}
