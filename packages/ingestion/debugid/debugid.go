// Package debugid computes deterministic source-map fingerprints.
package debugid

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"unicode/utf8"

	"github.com/gowebpki/jcs"
)

// Error reports the stable rejection reason shared by the TypeScript and Go
// implementations.
type Error struct {
	Reason string
}

func (e *Error) Error() string {
	return "source map cannot be fingerprinted: " + e.Reason
}

// Result contains the 128-bit debug ID and the full content digest.
type Result struct {
	DebugID           string
	ContentSHA256     string
	HasSourcesContent bool
}

// Compute validates and canonicalizes a source map before hashing it.
func Compute(input []byte) (Result, error) {
	if len(input) >= 3 && bytes.Equal(input[:3], []byte{0xef, 0xbb, 0xbf}) {
		return Result{}, reject("bom")
	}
	if !utf8.Valid(input) {
		return Result{}, reject("invalid_utf8")
	}
	if err := newScanner(input).scan(); err != nil {
		return Result{}, err
	}

	var root map[string]json.RawMessage
	if err := json.Unmarshal(input, &root); err != nil || root == nil {
		return Result{}, reject("bad_field_type")
	}
	if err := validateSourceMap(root); err != nil {
		return Result{}, err
	}
	_, hasSourcesContent := root["sourcesContent"]

	delete(root, "debugId")
	reduced, err := json.Marshal(root)
	if err != nil {
		return Result{}, reject("invalid_json")
	}
	canonical, err := jcs.Transform(reduced)
	if err != nil {
		return Result{}, reject("invalid_json")
	}

	digest := sha256.Sum256(canonical)
	contentSHA256 := hex.EncodeToString(digest[:])
	id := contentSHA256[:32]
	return Result{
		ContentSHA256:     contentSHA256,
		HasSourcesContent: hasSourcesContent,
		DebugID: fmt.Sprintf(
			"%s-%s-%s-%s-%s",
			id[:8],
			id[8:12],
			id[12:16],
			id[16:20],
			id[20:32],
		),
	}, nil
}

func validateSourceMap(root map[string]json.RawMessage) error {
	version, ok := root["version"]
	if !ok {
		return reject("bad_version")
	}
	var versionNumber float64
	if err := json.Unmarshal(version, &versionNumber); err != nil || versionNumber != 3 {
		return reject("bad_version")
	}
	if _, indexed := root["sections"]; indexed {
		return reject("indexed_map")
	}

	sources, err := stringArray(root["sources"])
	if err != nil {
		return reject("bad_field_type")
	}
	if _, err := stringArray(root["names"]); err != nil {
		return reject("bad_field_type")
	}
	var mappings string
	if raw, ok := root["mappings"]; !ok || json.Unmarshal(raw, &mappings) != nil {
		return reject("bad_field_type")
	}
	if raw, ok := root["sourcesContent"]; ok {
		sourcesContent, err := stringArray(raw)
		if err != nil {
			return reject("bad_field_type")
		}
		if len(sources) != len(sourcesContent) {
			return reject("sources_content_mismatch")
		}
	}
	return nil
}

func stringArray(raw json.RawMessage) ([]string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, reject("bad_field_type")
	}
	var values []string
	if err := json.Unmarshal(trimmed, &values); err != nil || values == nil {
		return nil, reject("bad_field_type")
	}
	return values, nil
}

func reject(reason string) *Error {
	return &Error{Reason: reason}
}

type scanner struct {
	input  []byte
	offset int
}

func newScanner(input []byte) *scanner {
	return &scanner{input: input}
}

func (s *scanner) scan() error {
	s.skipWhitespace()
	if err := s.value(1); err != nil {
		return err
	}
	s.skipWhitespace()
	if s.offset != len(s.input) {
		return reject("trailing_data")
	}
	return nil
}

func (s *scanner) value(depth int) error {
	if depth > 64 {
		return reject("depth_exceeded")
	}
	if s.offset >= len(s.input) {
		return reject("invalid_json")
	}
	switch current := s.input[s.offset]; {
	case current == '{':
		return s.object(depth)
	case current == '[':
		return s.array(depth)
	case current == '"':
		_, err := s.string()
		return err
	case current == 't':
		return s.literal("true")
	case current == 'f':
		return s.literal("false")
	case current == 'n':
		return s.literal("null")
	case current == '-' || current >= '0' && current <= '9':
		return s.number()
	default:
		return reject("invalid_json")
	}
}

func (s *scanner) object(depth int) error {
	s.offset++
	s.skipWhitespace()
	names := make(map[string]struct{})
	if s.consume('}') {
		return nil
	}
	for {
		name, err := s.string()
		if err != nil {
			return err
		}
		if _, duplicate := names[name]; duplicate {
			return reject("duplicate_key")
		}
		names[name] = struct{}{}
		s.skipWhitespace()
		if !s.consume(':') {
			return reject("invalid_json")
		}
		s.skipWhitespace()
		if err := s.value(depth + 1); err != nil {
			return err
		}
		s.skipWhitespace()
		if s.consume('}') {
			return nil
		}
		if !s.consume(',') {
			return reject("invalid_json")
		}
		s.skipWhitespace()
	}
}

func (s *scanner) array(depth int) error {
	s.offset++
	s.skipWhitespace()
	if s.consume(']') {
		return nil
	}
	for {
		if err := s.value(depth + 1); err != nil {
			return err
		}
		s.skipWhitespace()
		if s.consume(']') {
			return nil
		}
		if !s.consume(',') {
			return reject("invalid_json")
		}
		s.skipWhitespace()
	}
}

func (s *scanner) string() (string, error) {
	if !s.consume('"') {
		return "", reject("invalid_json")
	}
	start := s.offset - 1
	for s.offset < len(s.input) {
		current := s.input[s.offset]
		switch {
		case current == '"':
			s.offset++
			var decoded string
			if err := json.Unmarshal(s.input[start:s.offset], &decoded); err != nil {
				return "", reject("invalid_json")
			}
			return decoded, nil
		case current < 0x20:
			return "", reject("invalid_json")
		case current != '\\':
			_, size := utf8.DecodeRune(s.input[s.offset:])
			s.offset += size
		default:
			s.offset++
			if s.offset >= len(s.input) {
				return "", reject("invalid_json")
			}
			escape := s.input[s.offset]
			if escape != 'u' {
				if !bytes.ContainsRune([]byte(`"\/bfnrt`), rune(escape)) {
					return "", reject("invalid_json")
				}
				s.offset++
				continue
			}

			code, err := s.unicodeEscape()
			if err != nil {
				return "", err
			}
			switch {
			case code >= 0xd800 && code <= 0xdbff:
				if s.offset+6 > len(s.input) ||
					s.input[s.offset] != '\\' ||
					s.input[s.offset+1] != 'u' {
					return "", reject("invalid_unicode")
				}
				s.offset += 2
				low, err := s.hexCodeUnit()
				if err != nil {
					return "", err
				}
				if low < 0xdc00 || low > 0xdfff {
					return "", reject("invalid_unicode")
				}
			case code >= 0xdc00 && code <= 0xdfff:
				return "", reject("invalid_unicode")
			}
		}
	}
	return "", reject("invalid_json")
}

func (s *scanner) unicodeEscape() (uint64, error) {
	s.offset++
	return s.hexCodeUnit()
}

func (s *scanner) hexCodeUnit() (uint64, error) {
	if s.offset+4 > len(s.input) {
		return 0, reject("invalid_json")
	}
	code, err := strconv.ParseUint(string(s.input[s.offset:s.offset+4]), 16, 16)
	if err != nil {
		return 0, reject("invalid_json")
	}
	s.offset += 4
	return code, nil
}

func (s *scanner) number() error {
	start := s.offset
	if s.consume('-') && s.offset >= len(s.input) {
		return reject("invalid_json")
	}
	if s.consume('0') {
		// A leading zero may not be followed by another digit.
		if s.offset < len(s.input) && s.input[s.offset] >= '0' && s.input[s.offset] <= '9' {
			return reject("invalid_json")
		}
	} else {
		if s.offset >= len(s.input) || s.input[s.offset] < '1' || s.input[s.offset] > '9' {
			return reject("invalid_json")
		}
		for s.offset < len(s.input) && s.input[s.offset] >= '0' && s.input[s.offset] <= '9' {
			s.offset++
		}
	}
	if s.consume('.') {
		digits := s.offset
		for s.offset < len(s.input) && s.input[s.offset] >= '0' && s.input[s.offset] <= '9' {
			s.offset++
		}
		if digits == s.offset {
			return reject("invalid_json")
		}
	}
	if s.offset < len(s.input) && (s.input[s.offset] == 'e' || s.input[s.offset] == 'E') {
		s.offset++
		if s.offset < len(s.input) && (s.input[s.offset] == '+' || s.input[s.offset] == '-') {
			s.offset++
		}
		digits := s.offset
		for s.offset < len(s.input) && s.input[s.offset] >= '0' && s.input[s.offset] <= '9' {
			s.offset++
		}
		if digits == s.offset {
			return reject("invalid_json")
		}
	}

	number, err := strconv.ParseFloat(string(s.input[start:s.offset]), 64)
	if err != nil || math.IsInf(number, 0) || math.IsNaN(number) {
		return reject("non_finite_number")
	}
	return nil
}

func (s *scanner) literal(literal string) error {
	if !bytes.HasPrefix(s.input[s.offset:], []byte(literal)) {
		return reject("invalid_json")
	}
	s.offset += len(literal)
	return nil
}

func (s *scanner) skipWhitespace() {
	for s.offset < len(s.input) {
		switch s.input[s.offset] {
		case ' ', '\n', '\r', '\t':
			s.offset++
		default:
			return
		}
	}
}

func (s *scanner) consume(character byte) bool {
	if s.offset >= len(s.input) || s.input[s.offset] != character {
		return false
	}
	s.offset++
	return true
}
