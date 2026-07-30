package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"github.com/opslane/opslane/packages/ingestion/debugid"
)

func main() {
	dir := os.Args[1]
	re := regexp.MustCompile(`//# debugId=([0-9a-f-]{36})`)
	entries, _ := os.ReadDir(dir)
	names := []string{}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".js" {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, n := range names {
		code, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			continue
		}
		m := re.FindSubmatch(code)
		mp, err := os.ReadFile(filepath.Join(dir, n+".map"))
		if m == nil || err != nil {
			continue
		}
		res, err := debugid.Compute(mp)
		if err != nil {
			fmt.Printf("%-40s embedded=%s  SERVER REJECTS: %v\n", n, m[1], err)
			continue
		}
		status := "MISMATCH -> 409"
		if res.DebugID == string(m[1]) {
			status = "OK"
		}
		fmt.Printf("%-40s embedded=%s  server=%s  %s\n", n, m[1], res.DebugID, status)
	}
}
