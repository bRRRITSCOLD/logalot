package coldstore

import (
	"errors"
	"fmt"
	"strings"
)

// ErrMissingTenantPredicate is returned by CheckTenantPredicate when the
// generated SQL lacks a static `tenant_id = '<ctx>'` equality predicate at the
// top level of the WHERE clause. It is the sentinel for the fitness-function
// gate: StartQueryExecution is never called when this fires (NFR-6 / decision
// 016).
var ErrMissingTenantPredicate = errors.New("coldstore: missing tenant_id predicate")

// CheckTenantPredicate verifies that sql contains a static equality predicate
//
//	tenant_id = '<tenantID>'
//
// at the top level of the WHERE clause as an unconditional AND condition.
// This is a structural AST check — the SQL is tokenized, the WHERE clause is
// parsed into a predicate tree, and the tree is walked for the exact predicate.
// It is NOT a substring match and will reject:
//   - the predicate buried inside parens (ambiguous / might be OR'd away)
//   - a LIKE or != or any non-equality operator
//   - a different tenant ID
//   - SQL without a WHERE clause
//
// Returns ErrMissingTenantPredicate if the predicate is absent or incorrect.
// Fail-closed: an empty tenantID is immediately rejected.
func CheckTenantPredicate(sql, tenantID string) error {
	if strings.TrimSpace(tenantID) == "" {
		return fmt.Errorf("%w: empty tenant ID", ErrMissingTenantPredicate)
	}
	tokens := tokenize(sql)
	whereIdx := findWHERE(tokens)
	if whereIdx < 0 {
		return fmt.Errorf("%w: no WHERE clause found", ErrMissingTenantPredicate)
	}
	terms := splitTopLevelAND(tokens[whereIdx+1:])
	for _, term := range terms {
		if isEqualityPredicate(term, "tenant_id", tenantID) {
			return nil
		}
	}
	return fmt.Errorf("%w: tenant_id = '%s' predicate absent from top-level WHERE AND-chain",
		ErrMissingTenantPredicate, tenantID)
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

// tokKind classifies a SQL token for the fitness-function parser. The set is
// deliberately minimal — just enough to parse WHERE-clause predicate structure.
type tokKind uint8

const (
	tokIdent  tokKind = iota // identifier: tenant_id, logalot_cold.log_events, …
	tokString                // single-quoted literal: 'uuid-value'
	tokNumber                // numeric literal: 50
	tokOp                    // operator: = < > <= >= != <>
	tokLParen                // (
	tokRParen                // )
	tokComma                 // ,
	tokKW                    // keyword: SELECT FROM WHERE AND OR BETWEEN ORDER LIMIT …
)

type token struct {
	kind tokKind
	val  string
}

// sqlKeywords is the set of SQL keywords the tokenizer recognises. Case is
// normalised to uppercase in token.val so comparisons are case-insensitive.
var sqlKeywords = map[string]bool{
	"SELECT": true, "FROM": true, "WHERE": true,
	"AND": true, "OR": true, "NOT": true,
	"BETWEEN": true, "IN": true, "LIKE": true, "IS": true,
	"ORDER": true, "BY": true, "LIMIT": true, "HAVING": true,
	"GROUP": true, "AS": true, "NULL": true, "TRUE": true, "FALSE": true,
	"UNION": true, "EXCEPT": true, "INTERSECT": true,
}

// tokenize splits sql into a flat token slice. Whitespace and SQL comments are
// skipped. Single-quoted strings are returned with their surrounding quotes
// stripped and `”` escape sequences normalised to `'`. Keywords are
// case-folded to uppercase in val.
func tokenize(sql string) []token {
	var out []token
	i := 0
	for i < len(sql) {
		c := sql[i]

		// --- skip whitespace ---
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			i++
			continue
		}

		// --- skip line comment (-- …) ---
		if c == '-' && i+1 < len(sql) && sql[i+1] == '-' {
			i += 2
			for i < len(sql) && sql[i] != '\n' {
				i++
			}
			continue
		}

		// --- skip block comment (/* … */) ---
		if c == '/' && i+1 < len(sql) && sql[i+1] == '*' {
			i += 2
			for i+1 < len(sql) && !(sql[i] == '*' && sql[i+1] == '/') {
				i++
			}
			i += 2
			continue
		}

		// --- single-quoted string literal ---
		if c == '\'' {
			i++
			start := i
			for i < len(sql) {
				if sql[i] == '\'' {
					if i+1 < len(sql) && sql[i+1] == '\'' {
						i += 2 // escape sequence '' → '
						continue
					}
					break
				}
				i++
			}
			val := sql[start:i]
			val = strings.ReplaceAll(val, "''", "'")
			out = append(out, token{kind: tokString, val: val})
			i++ // skip closing quote
			continue
		}

		// --- punctuation ---
		switch c {
		case '(':
			out = append(out, token{kind: tokLParen, val: "("})
			i++
			continue
		case ')':
			out = append(out, token{kind: tokRParen, val: ")"})
			i++
			continue
		case ',':
			out = append(out, token{kind: tokComma, val: ","})
			i++
			continue
		}

		// --- operators (1- or 2-char) ---
		if c == '=' {
			out = append(out, token{kind: tokOp, val: "="})
			i++
			continue
		}
		if c == '<' || c == '>' || c == '!' {
			if i+1 < len(sql) && (sql[i+1] == '=' || sql[i+1] == '>') {
				out = append(out, token{kind: tokOp, val: string(sql[i : i+2])})
				i += 2
			} else {
				out = append(out, token{kind: tokOp, val: string(c)})
				i++
			}
			continue
		}
		if c == '*' || c == '+' || c == '-' || c == '/' {
			out = append(out, token{kind: tokOp, val: string(c)})
			i++
			continue
		}

		// --- numeric literals ---
		if c >= '0' && c <= '9' {
			j := i
			for j < len(sql) && ((sql[j] >= '0' && sql[j] <= '9') || sql[j] == '.') {
				j++
			}
			out = append(out, token{kind: tokNumber, val: sql[i:j]})
			i = j
			continue
		}

		// --- identifiers and keywords ---
		if c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
			j := i
			for j < len(sql) && (sql[j] == '_' || sql[j] == '.' ||
				(sql[j] >= 'a' && sql[j] <= 'z') || (sql[j] >= 'A' && sql[j] <= 'Z') ||
				(sql[j] >= '0' && sql[j] <= '9')) {
				j++
			}
			word := sql[i:j]
			upper := strings.ToUpper(word)
			if sqlKeywords[upper] {
				out = append(out, token{kind: tokKW, val: upper})
			} else {
				out = append(out, token{kind: tokIdent, val: word})
			}
			i = j
			continue
		}

		// --- skip unrecognised characters (semicolons, backticks, etc.) ---
		i++
	}
	return out
}

// ---------------------------------------------------------------------------
// WHERE-clause parser helpers
// ---------------------------------------------------------------------------

// findWHERE returns the index of the WHERE keyword token at parenthesis
// depth 0, or -1 if absent. Depth tracking prevents a subquery's WHERE from
// satisfying the check.
func findWHERE(tokens []token) int {
	depth := 0
	for i, tok := range tokens {
		switch tok.kind {
		case tokLParen:
			depth++
		case tokRParen:
			if depth > 0 {
				depth--
			}
		case tokKW:
			if depth == 0 && tok.val == "WHERE" {
				return i
			}
		}
	}
	return -1
}

// splitTopLevelAND splits tokens (the portion AFTER the WHERE keyword) into
// independent AND terms, stopping at the first ORDER / LIMIT / HAVING / UNION
// keyword at depth 0. It correctly handles BETWEEN … AND … by not treating
// BETWEEN's AND as a split point.
func splitTopLevelAND(tokens []token) [][]token {
	var terms [][]token
	depth := 0
	inBetween := false
	start := 0

	for i, tok := range tokens {
		switch tok.kind {
		case tokLParen:
			depth++
		case tokRParen:
			if depth > 0 {
				depth--
			}
		case tokKW:
			if depth > 0 {
				break
			}
			switch tok.val {
			case "ORDER", "LIMIT", "HAVING", "UNION", "EXCEPT", "INTERSECT":
				// End of WHERE clause: flush the current term and stop.
				if i > start {
					terms = append(terms, tokens[start:i])
				}
				return terms

			case "BETWEEN":
				inBetween = true

			case "AND":
				if inBetween {
					// This AND is the BETWEEN separator (BETWEEN x AND y).
					// Clear the flag but do NOT split here.
					inBetween = false
				} else {
					// Top-level conjunction: split here.
					if i > start {
						terms = append(terms, tokens[start:i])
					}
					start = i + 1
				}
			}
		}
	}

	// Flush whatever remains after the last split.
	if start < len(tokens) {
		terms = append(terms, tokens[start:])
	}
	return terms
}

// isEqualityPredicate reports whether term is the 3-token sequence:
//
//	<colName> = '<value>'
//
// (IDENT, OP:=, STR). Column name comparison is case-insensitive; value
// comparison is exact (UUID strings are case-sensitive in practice).
func isEqualityPredicate(term []token, colName, value string) bool {
	if len(term) != 3 {
		return false
	}
	return term[0].kind == tokIdent &&
		strings.EqualFold(term[0].val, colName) &&
		term[1].kind == tokOp && term[1].val == "=" &&
		term[2].kind == tokString && term[2].val == value
}
