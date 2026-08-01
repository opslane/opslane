package sourcemapping

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParityWithTraceMapping(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "parity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name    string          `json:"name"`
			Map     json.RawMessage `json:"map"`
			Queries []struct {
				Line   int `json:"line"`
				Column int `json:"column"`
				Expect *struct {
					Source string  `json:"source"`
					Line   int     `json:"line"`
					Column int     `json:"column"`
					Name   *string `json:"name"`
				} `json:"expect"`
			} `json:"queries"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("parity.json has no cases")
	}

	for _, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			decoded, err := Parse(testCase.Map)
			if err != nil {
				t.Fatal(err)
			}
			for _, query := range testCase.Queries {
				got, ok := decoded.Lookup(query.Line, query.Column)
				if query.Expect == nil {
					if ok {
						t.Errorf(
							"(%d,%d) resolved to %+v, want unmapped",
							query.Line,
							query.Column,
							got,
						)
					}
					continue
				}
				if !ok {
					t.Fatalf(
						"(%d,%d) unmapped, want %+v",
						query.Line,
						query.Column,
						*query.Expect,
					)
				}
				if got.Source != query.Expect.Source ||
					got.Line != query.Expect.Line ||
					got.Column != query.Expect.Column ||
					!equalOptionalString(got.Name, query.Expect.Name) {
					t.Errorf(
						"(%d,%d) = %+v, want %+v",
						query.Line,
						query.Column,
						got,
						*query.Expect,
					)
				}
			}
		})
	}
}

func TestParseRejectsMalformedMaps(t *testing.T) {
	maxGenerated := encodeVLQ(math.MaxInt32)
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "invalid JSON",
			raw:  `{`,
			want: "decode source map",
		},
		{
			name: "multiple JSON values",
			raw:  validMap(`AAAA`) + `{}`,
			want: "multiple JSON values",
		},
		{
			name: "wrong field type",
			raw:  `{"version":3,"sources":[],"names":[],"mappings":7}`,
			want: "decode source map",
		},
		{
			name: "missing version",
			raw:  `{"sources":[],"names":[],"mappings":""}`,
			want: "unsupported source-map version",
		},
		{
			name: "wrong version",
			raw:  `{"version":2,"sources":[],"names":[],"mappings":""}`,
			want: "unsupported source-map version",
		},
		{
			name: "sections array",
			raw:  `{"version":3,"sources":[],"names":[],"mappings":"","sections":[]}`,
			want: "sections",
		},
		{
			name: "sections null",
			raw:  `{"version":3,"sources":[],"names":[],"mappings":"","sections":null}`,
			want: "sections",
		},
		{
			name: "two fields",
			raw:  validMap(`AA`),
			want: "2 fields",
		},
		{
			name: "three fields",
			raw:  validMap(`AAA`),
			want: "3 fields",
		},
		{
			name: "six fields",
			raw:  validMap(`AAAAAA`),
			want: "6 fields",
		},
		{
			name: "empty segment before comma",
			raw:  validMap(`,A`),
			want: "is empty",
		},
		{
			name: "empty segment after comma",
			raw:  validMap(`A,`),
			want: "is empty",
		},
		{
			name: "truncated VLQ",
			raw:  validMap(`g`),
			want: "truncated VLQ",
		},
		{
			name: "non-base64 VLQ",
			raw:  validMap(`!`),
			want: "invalid base64 VLQ character",
		},
		{
			name: "VLQ above int32 maximum",
			raw:  validMap(encodeVLQ(int64(math.MaxInt32) + 1)),
			want: "VLQ overflows int32",
		},
		{
			name: "VLQ below int32 minimum",
			raw:  validMap(encodeVLQ(int64(math.MinInt32) - 1)),
			want: "VLQ overflows int32",
		},
		{
			name: "generated column accumulator overflow",
			raw:  validMap(maxGenerated + `,C`),
			want: "generated column: value overflows int32",
		},
		{
			name: "negative generated column",
			raw:  validMap(encodeVLQ(-1)),
			want: "negative generated column",
		},
		{
			name: "source index out of range",
			raw:  validMap(`AAAA`),
			want: "source index 0 is out of range",
		},
		{
			name: "negative source index",
			raw:  mapWithTables(`ADAA`, []string{"a.ts"}, nil),
			want: "source index -1 is out of range",
		},
		{
			name: "negative original line",
			raw:  mapWithTables(`AADA`, []string{"a.ts"}, nil),
			want: "negative original line",
		},
		{
			name: "negative original column",
			raw:  mapWithTables(`AAAD`, []string{"a.ts"}, nil),
			want: "negative original column",
		},
		{
			name: "name index out of range",
			raw:  mapWithTables(`AAAAA`, []string{"a.ts"}, nil),
			want: "name index 0 is out of range",
		},
		{
			name: "negative name index",
			raw:  mapWithTables(`AAAAD`, []string{"a.ts"}, []string{"name"}),
			want: "name index -1 is out of range",
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := Parse([]byte(testCase.raw))
			if err == nil {
				t.Fatal("Parse() succeeded, want error")
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("Parse() error = %q, want it to contain %q", err, testCase.want)
			}
		})
	}
}

// A decoded map is many times larger than its input. Without these caps a map
// inside the 100 MiB upload limit — even one made of nothing but ";" — expands
// to multiple gibibytes of heap, so a single verify request can OOM the shared
// ingestion process.
func TestParseCapsWhatItMaterializes(t *testing.T) {
	tests := []struct {
		name     string
		mappings string
		wantErr  string
	}{
		{
			name:     "line count over the cap",
			mappings: strings.Repeat(";", maxMappingLines),
			wantErr:  "lines; limit is",
		},
		{
			name:     "segment count over the cap",
			mappings: strings.Repeat("A,", maxMappingSegments) + "A",
			wantErr:  "segments",
		},
		{
			name:     "empty-line padding still counts toward the line cap",
			mappings: strings.Repeat(";", maxMappingLines+1000),
			wantErr:  "lines; limit is",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw, err := json.Marshal(map[string]any{
				"version": 3, "sources": []string{"a.ts"}, "names": []string{},
				"mappings": test.mappings,
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Parse(raw); err == nil {
				t.Fatal("Parse() succeeded, want a cap error")
			} else if !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("Parse() error = %q, want it to mention %q", err, test.wantErr)
			}
		})
	}

	// A map just inside both caps must still parse and resolve.
	raw, err := json.Marshal(map[string]any{
		"version": 3, "sources": []string{"a.ts"}, "names": []string{},
		"mappings": strings.Repeat(";", 10) + "AAAA",
	})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := Parse(raw)
	if err != nil {
		t.Fatalf("a small map must still parse: %v", err)
	}
	if _, ok := decoded.Lookup(11, 0); !ok {
		t.Fatal("Lookup() on a small map failed after the cap change")
	}
}

func TestParseSortsGeneratedColumnsBeforeLookup(t *testing.T) {
	decoded, err := Parse([]byte(mapWithTables(
		`KAAA,HAAC`,
		[]string{"a.ts"},
		nil,
	)))
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		column       int
		wantOriginal int
	}{
		{column: 1, wantOriginal: -1},
		{column: 2, wantOriginal: 1},
		{column: 4, wantOriginal: 1},
		{column: 5, wantOriginal: 0},
	}
	for _, testCase := range tests {
		got, ok := decoded.Lookup(1, testCase.column)
		if testCase.wantOriginal < 0 {
			if ok {
				t.Errorf("Lookup(1, %d) = %+v, true; want unmapped", testCase.column, got)
			}
			continue
		}
		if !ok || got.Column != testCase.wantOriginal {
			t.Errorf(
				"Lookup(1, %d) = %+v, %t; want original column %d",
				testCase.column,
				got,
				ok,
				testCase.wantOriginal,
			)
		}
	}
}

func TestParseIgnoresNonMappingFields(t *testing.T) {
	raw := []byte(`{
		"version": 3,
		"sourceRoot": "https://cdn.example.test/src/",
		"file": "bundle.js",
		"sources": ["raw/path.ts"],
		"names": [],
		"mappings": "AAAA",
		"sourcesContent": ["must not be retained"]
	}`)
	decoded, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}

	got, ok := decoded.Lookup(1, 0)
	if !ok {
		t.Fatal("Lookup(1, 0) is unmapped, want mapped")
	}
	if got.Source != "raw/path.ts" {
		t.Errorf("Lookup(1, 0).Source = %q, want raw source path", got.Source)
	}
	if got.Name != nil {
		t.Errorf("Lookup(1, 0).Name = %q, want nil for a four-field segment", *got.Name)
	}
}

func TestLookupStopsAtUnmappedSegment(t *testing.T) {
	decoded, err := Parse([]byte(mapWithTables(
		`AAAA,K,KAAA`,
		[]string{"a.ts"},
		nil,
	)))
	if err != nil {
		t.Fatal(err)
	}

	if got, ok := decoded.Lookup(1, 4); !ok || got.Source != "a.ts" {
		t.Fatalf("Lookup(1, 4) = %+v, %t; want mapped", got, ok)
	}
	if got, ok := decoded.Lookup(1, 7); ok {
		t.Fatalf("Lookup(1, 7) = %+v, true; want unmapped", got)
	}
	if got, ok := decoded.Lookup(1, 10); !ok || got.Source != "a.ts" {
		t.Fatalf("Lookup(1, 10) = %+v, %t; want mapped", got, ok)
	}
}

func TestLookupRejectsInvalidQueries(t *testing.T) {
	decoded, err := Parse([]byte(mapWithTables(`AAAA`, []string{"a.ts"}, nil)))
	if err != nil {
		t.Fatal(err)
	}

	for _, query := range []struct {
		line   int
		column int
	}{
		{line: 0, column: 0},
		{line: 2, column: 0},
		{line: 1, column: -1},
	} {
		if got, ok := decoded.Lookup(query.line, query.column); ok {
			t.Errorf("Lookup(%d, %d) = %+v, true; want unmapped", query.line, query.column, got)
		}
	}

	var nilMap *Map
	if got, ok := nilMap.Lookup(1, 0); ok {
		t.Errorf("nil Map Lookup() = %+v, true; want unmapped", got)
	}
}

func TestDecodeVLQInt32Boundaries(t *testing.T) {
	for _, want := range []int64{math.MinInt32, math.MaxInt32} {
		encoded := encodeVLQ(want)
		got, next, err := decodeVLQ(encoded, 0)
		if err != nil {
			t.Fatalf("decodeVLQ(%q): %v", encoded, err)
		}
		if int64(got) != want || next != len(encoded) {
			t.Errorf(
				"decodeVLQ(%q) = %d, %d; want %d, %d",
				encoded,
				got,
				next,
				want,
				len(encoded),
			)
		}
	}
}

func equalOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func validMap(mappings string) string {
	return mapWithTables(mappings, nil, nil)
}

func mapWithTables(mappings string, sources, names []string) string {
	document := struct {
		Version  int      `json:"version"`
		Sources  []string `json:"sources"`
		Names    []string `json:"names"`
		Mappings string   `json:"mappings"`
	}{
		Version:  3,
		Sources:  sources,
		Names:    names,
		Mappings: mappings,
	}
	raw, err := json.Marshal(document)
	if err != nil {
		panic(err)
	}
	return string(raw)
}

func encodeVLQ(value int64) string {
	var encoded uint64
	if value < 0 {
		encoded = uint64(-value)<<1 | 1
	} else {
		encoded = uint64(value) << 1
	}

	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var result strings.Builder
	for {
		digit := encoded & 31
		encoded >>= 5
		if encoded != 0 {
			digit |= 32
		}
		result.WriteByte(alphabet[digit])
		if encoded == 0 {
			return result.String()
		}
	}
}

func ExampleMap_Lookup() {
	decoded, err := Parse([]byte(mapWithTables(`AAAA`, []string{"src/a.ts"}, nil)))
	if err != nil {
		panic(err)
	}
	position, ok := decoded.Lookup(1, 4)
	fmt.Println(position.Source, position.Line, position.Column, position.Name, ok)
	// Output: src/a.ts 1 0 <nil> true
}
