// Package sourcemapping decodes source-map v3 mappings and answers generated to
// original position queries.
//
// Written rather than vendored: github.com/go-sourcemap/sourcemap defaults a
// missing source index to 0 and reports success, so a spec-unmapped segment
// resolves to a fabricated position in sources[0]. For an endpoint whose job is
// proving resolution is correct, a confident wrong answer is worse than an error.
//
// This package never retains sourcesContent. Nothing here can leak source text.
package sourcemapping

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
)

// Position is an original source position.
type Position struct {
	Source string
	Line   int     // 1-based
	Column int     // 0-based
	Name   *string // nil when the segment carries no name index
}

// A decoded map is many times larger than the bytes it came from, so an
// unbounded decode is a memory bomb: uploads are capped at 100 MiB, and a
// mappings string of nothing but ";" or one-field segments used to expand to
// multiple gibibytes of heap in a single request. These caps bound the retained
// set to roughly 290 MiB in the worst case while leaving ~2x headroom over the
// segment count a real 100 MiB map produces.
const (
	maxMappingLines    = 4_000_000
	maxMappingSegments = 8_000_000
)

// Map contains the decoded mappings needed to answer position queries.
type Map struct {
	sources []string
	names   []string
	lines   [][]segment
}

// segment stores indices rather than strings: at ~4M segments for a large map,
// two string headers per segment would cost more than the mappings text itself.
type segment struct {
	generatedColumn int32
	originalLine    int32
	originalColumn  int32
	sourceIndex     int32
	nameIndex       int32
	mapped          bool
	hasName         bool
}

type sourceMapJSON struct {
	Version  int             `json:"version"`
	Sources  []string        `json:"sources"`
	Names    []string        `json:"names"`
	Mappings string          `json:"mappings"`
	Sections json.RawMessage `json:"sections"`
}

// Parse validates and decodes a source-map v3 mappings string.
func Parse(raw []byte) (*Map, error) {
	var document sourceMapJSON
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("decode source map: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, err
	}
	if document.Version != 3 {
		return nil, fmt.Errorf("unsupported source-map version %d", document.Version)
	}
	if document.Sections != nil {
		return nil, errors.New("indexed source maps with sections are not supported")
	}

	lineCount := strings.Count(document.Mappings, ";") + 1
	if lineCount > maxMappingLines {
		return nil, fmt.Errorf("mappings has %d lines; limit is %d", lineCount, maxMappingLines)
	}
	decoded := &Map{
		sources: document.Sources,
		names:   document.Names,
		lines:   make([][]segment, lineCount),
	}

	var sourceIndex int32
	var originalLine int32
	var originalColumn int32
	var nameIndex int32
	var totalSegments int

	// Iterate the mappings text in place. strings.Split would allocate a
	// []string header per line and per segment, which for a pathological map
	// costs more than the retained segments do.
	remaining := document.Mappings
	for lineIndex := 0; lineIndex < lineCount; lineIndex++ {
		encodedLine := remaining
		if cut := strings.IndexByte(remaining, ';'); cut >= 0 {
			encodedLine, remaining = remaining[:cut], remaining[cut+1:]
		} else {
			remaining = ""
		}
		if encodedLine == "" {
			continue
		}

		var line []segment
		var generatedColumn int32

		// Mirrors strings.Split semantics: a trailing comma yields a final
		// empty segment, which is malformed and must be rejected.
		for segmentIndex := 0; ; segmentIndex++ {
			encodedSegment := encodedLine
			more := false
			if cut := strings.IndexByte(encodedLine, ','); cut >= 0 {
				encodedSegment, encodedLine = encodedLine[:cut], encodedLine[cut+1:]
				more = true
			}
			if encodedSegment == "" {
				return nil, fmt.Errorf("line %d segment %d is empty", lineIndex+1, segmentIndex+1)
			}
			totalSegments++
			if totalSegments > maxMappingSegments {
				return nil, fmt.Errorf("mappings has more than %d segments", maxMappingSegments)
			}

			fields, err := decodeSegment(encodedSegment)
			if err != nil {
				return nil, fmt.Errorf("line %d segment %d: %w", lineIndex+1, segmentIndex+1, err)
			}
			switch len(fields) {
			case 1, 4, 5:
			default:
				return nil, fmt.Errorf(
					"line %d segment %d has %d fields; want 1, 4, or 5",
					lineIndex+1,
					segmentIndex+1,
					len(fields),
				)
			}

			generatedColumn, err = addInt32(generatedColumn, fields[0])
			if err != nil {
				return nil, fmt.Errorf("line %d segment %d generated column: %w", lineIndex+1, segmentIndex+1, err)
			}
			if generatedColumn < 0 {
				return nil, fmt.Errorf("line %d segment %d has negative generated column", lineIndex+1, segmentIndex+1)
			}

			current := segment{generatedColumn: generatedColumn}
			if len(fields) == 1 {
				line = append(line, current)
				if !more {
					break
				}
				continue
			}

			sourceIndex, err = addInt32(sourceIndex, fields[1])
			if err != nil {
				return nil, fmt.Errorf("line %d segment %d source index: %w", lineIndex+1, segmentIndex+1, err)
			}
			if sourceIndex < 0 || int64(sourceIndex) >= int64(len(document.Sources)) {
				return nil, fmt.Errorf(
					"line %d segment %d source index %d is out of range",
					lineIndex+1,
					segmentIndex+1,
					sourceIndex,
				)
			}

			originalLine, err = addInt32(originalLine, fields[2])
			if err != nil {
				return nil, fmt.Errorf("line %d segment %d original line: %w", lineIndex+1, segmentIndex+1, err)
			}
			if originalLine < 0 {
				return nil, fmt.Errorf("line %d segment %d has negative original line", lineIndex+1, segmentIndex+1)
			}

			originalColumn, err = addInt32(originalColumn, fields[3])
			if err != nil {
				return nil, fmt.Errorf("line %d segment %d original column: %w", lineIndex+1, segmentIndex+1, err)
			}
			if originalColumn < 0 {
				return nil, fmt.Errorf("line %d segment %d has negative original column", lineIndex+1, segmentIndex+1)
			}

			current.mapped = true
			current.sourceIndex = sourceIndex
			current.originalLine = originalLine
			current.originalColumn = originalColumn

			if len(fields) == 5 {
				nameIndex, err = addInt32(nameIndex, fields[4])
				if err != nil {
					return nil, fmt.Errorf("line %d segment %d name index: %w", lineIndex+1, segmentIndex+1, err)
				}
				if nameIndex < 0 || int64(nameIndex) >= int64(len(document.Names)) {
					return nil, fmt.Errorf(
						"line %d segment %d name index %d is out of range",
						lineIndex+1,
						segmentIndex+1,
						nameIndex,
					)
				}
				current.nameIndex = nameIndex
				current.hasName = true
			}
			line = append(line, current)
			if !more {
				break
			}
		}

		sort.SliceStable(line, func(i, j int) bool {
			return line[i].generatedColumn < line[j].generatedColumn
		})
		decoded.lines[lineIndex] = line
	}

	return decoded, nil
}

// Lookup returns the original position for the mapping segment whose generated
// column is the greatest one not exceeding genCol.
func (m *Map) Lookup(genLine, genCol int) (Position, bool) {
	if m == nil || genLine < 1 || genLine > len(m.lines) || genCol < 0 {
		return Position{}, false
	}
	line := m.lines[genLine-1]
	if len(line) == 0 {
		return Position{}, false
	}

	index := sort.Search(len(line), func(i int) bool {
		return int64(line[i].generatedColumn) > int64(genCol)
	}) - 1
	if index < 0 || !line[index].mapped {
		return Position{}, false
	}

	found := line[index]
	position := Position{
		Source: m.sources[found.sourceIndex],
		Line:   int(found.originalLine) + 1,
		Column: int(found.originalColumn),
	}
	if found.hasName {
		name := m.names[found.nameIndex]
		position.Name = &name
	}
	return position, true
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra json.RawMessage
	err := decoder.Decode(&extra)
	if err == nil {
		return errors.New("decode source map: multiple JSON values")
	}
	if errors.Is(err, io.EOF) {
		return nil
	}
	return fmt.Errorf("decode source map: %w", err)
}

func decodeSegment(encoded string) ([]int32, error) {
	fields := make([]int32, 0, 5)
	for offset := 0; offset < len(encoded); {
		value, next, err := decodeVLQ(encoded, offset)
		if err != nil {
			return nil, err
		}
		fields = append(fields, value)
		offset = next
	}
	return fields, nil
}

func decodeVLQ(encoded string, offset int) (int32, int, error) {
	var encodedValue uint64
	var shift uint

	for {
		if offset >= len(encoded) {
			return 0, offset, errors.New("truncated VLQ")
		}
		digit, ok := base64Digit(encoded[offset])
		if !ok {
			return 0, offset, fmt.Errorf("invalid base64 VLQ character %q", encoded[offset])
		}
		offset++

		payload := uint64(digit & 31)
		if shift >= 64 || payload > math.MaxUint64>>shift {
			return 0, offset, errors.New("VLQ overflows int32")
		}
		encodedValue |= payload << shift
		if digit&32 == 0 {
			break
		}
		if shift >= 35 {
			return 0, offset, errors.New("VLQ overflows int32")
		}
		shift += 5
	}

	negative := encodedValue&1 != 0
	magnitude := encodedValue >> 1
	if negative {
		if magnitude > 1<<31 {
			return 0, offset, errors.New("VLQ overflows int32")
		}
		return int32(-int64(magnitude)), offset, nil
	}
	if magnitude > math.MaxInt32 {
		return 0, offset, errors.New("VLQ overflows int32")
	}
	return int32(magnitude), offset, nil
}

func base64Digit(char byte) (byte, bool) {
	switch {
	case char >= 'A' && char <= 'Z':
		return char - 'A', true
	case char >= 'a' && char <= 'z':
		return char - 'a' + 26, true
	case char >= '0' && char <= '9':
		return char - '0' + 52, true
	case char == '+':
		return 62, true
	case char == '/':
		return 63, true
	default:
		return 0, false
	}
}

func addInt32(left, right int32) (int32, error) {
	sum := int64(left) + int64(right)
	if sum < math.MinInt32 || sum > math.MaxInt32 {
		return 0, errors.New("value overflows int32")
	}
	return int32(sum), nil
}
