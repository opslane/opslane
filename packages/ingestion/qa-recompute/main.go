// Command qa-recompute checks a real build directory the way the server will.
//
// The shared golden vectors prove Go and TypeScript agree on fixed inputs. They
// cannot prove that what a Vite build actually writes to disk still recomputes
// to the ID stamped in the JavaScript beside it, which is the property an
// upload depends on. This reads the emitted bytes and calls the same
// debugid.Compute the ingestion path uses, so agreement here is agreement with
// the server rather than with a second implementation of it.
//
// Usage: go run ./qa-recompute <directory of built .js and .js.map>
//
// Exits non-zero when any chunk mismatches, when a map cannot be fingerprinted,
// or when the directory yields nothing to check.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"github.com/opslane/opslane/packages/ingestion/debugid"
)

var trailer = regexp.MustCompile(`//# debugId=([0-9a-f-]{36})`)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: qa-recompute <directory of built .js and .js.map>")
		os.Exit(2)
	}
	if err := run(os.Args[1]); err != nil {
		fmt.Fprintf(os.Stderr, "qa-recompute: %v\n", err)
		os.Exit(1)
	}
}

func run(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}

	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".js" {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	var checked, failed int
	for _, n := range names {
		code, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			return fmt.Errorf("read %s: %w", n, err)
		}
		stamped := trailer.FindSubmatch(code)
		if stamped == nil {
			// Not every chunk carries an ID, and an unstamped one is
			// `opslane doctor`'s business rather than this tool's.
			continue
		}

		// A stamped chunk with no sibling map is a real fault: the ID promises a
		// map that cannot be fingerprinted, so an upload has nothing to match
		// against. Count it rather than skipping past it.
		mapBytes, err := os.ReadFile(filepath.Join(dir, n+".map"))
		if err != nil {
			fmt.Printf("%-40s embedded=%s  NO SIBLING MAP\n", n, stamped[1])
			checked++
			failed++
			continue
		}

		checked++
		res, err := debugid.Compute(mapBytes)
		if err != nil {
			fmt.Printf("%-40s embedded=%s  SERVER REJECTS: %v\n", n, stamped[1], err)
			failed++
			continue
		}
		status := "OK"
		if res.DebugID != string(stamped[1]) {
			status = "MISMATCH -> 409"
			failed++
		}
		fmt.Printf("%-40s embedded=%s  server=%s  %s\n", n, stamped[1], res.DebugID, status)
	}

	// Printing nothing used to exit 0, so a mistyped path or a build where
	// stamping never ran read exactly like a clean pass.
	if checked == 0 {
		return fmt.Errorf("no stamped chunk with a sibling map found in %s", dir)
	}
	fmt.Printf("\n%d/%d chunks recompute to the ID stamped beside them.\n", checked-failed, checked)
	if failed > 0 {
		return fmt.Errorf("%d of %d chunks would be rejected on upload", failed, checked)
	}
	return nil
}
