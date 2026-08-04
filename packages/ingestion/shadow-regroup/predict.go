package main

import (
	"sort"

	"github.com/opslane/opslane/packages/ingestion/grouping"
)

// EventRow carries the event-level platform. The group-level platform is
// nullable legacy data and is deliberately not trusted for regrouping.
type EventRow struct {
	ProjectID    string
	GroupID      string
	Platform     string
	ErrorMessage string
	StackRaw     string
}

type ProjectReport struct {
	SuppressedByRule map[string]int
	FamilyEvents     int
	FamilyCollapsed  []string
	NoiseOnly        []string
	MixedGroups      []string
	UnchangedGroups  int
}

type Report struct {
	PerProject map[string]ProjectReport
}

// Predict classifies every stored event under the slice-1 ladder. A group is
// removable only when every event is family or suppressed. Mixed groups
// survive and are never cutover candidates.
func Predict(rows []EventRow) Report {
	type groupKey struct {
		project string
		group   string
	}
	type tally struct {
		family     int
		suppressed int
		ordinary   int
	}

	tallies := make(map[groupKey]*tally)
	suppressedByRule := make(map[string]map[string]int)
	familyEvents := make(map[string]int)
	for _, row := range rows {
		key := groupKey{project: row.ProjectID, group: row.GroupID}
		groupTally := tallies[key]
		if groupTally == nil {
			groupTally = &tally{}
			tallies[key] = groupTally
		}

		if rule, drop := grouping.Suppress(row.Platform, row.ErrorMessage, row.StackRaw); drop {
			groupTally.suppressed++
			if suppressedByRule[row.ProjectID] == nil {
				suppressedByRule[row.ProjectID] = make(map[string]int)
			}
			suppressedByRule[row.ProjectID][rule]++
			continue
		}
		if _, matched := grouping.FamilyFingerprint(row.Platform, row.ErrorMessage); matched {
			groupTally.family++
			familyEvents[row.ProjectID]++
			continue
		}
		groupTally.ordinary++
	}

	report := Report{PerProject: make(map[string]ProjectReport)}
	getProject := func(project string) ProjectReport {
		projectReport, ok := report.PerProject[project]
		if !ok {
			projectReport = ProjectReport{SuppressedByRule: make(map[string]int)}
		}
		return projectReport
	}
	for project, rules := range suppressedByRule {
		projectReport := getProject(project)
		for rule, count := range rules {
			projectReport.SuppressedByRule[rule] += count
		}
		report.PerProject[project] = projectReport
	}
	for project, count := range familyEvents {
		projectReport := getProject(project)
		projectReport.FamilyEvents = count
		report.PerProject[project] = projectReport
	}
	for key, groupTally := range tallies {
		projectReport := getProject(key.project)
		removable := groupTally.family + groupTally.suppressed
		switch {
		case removable > 0 && groupTally.ordinary > 0:
			projectReport.MixedGroups = append(projectReport.MixedGroups, key.group)
			projectReport.UnchangedGroups++
		case groupTally.family > 0:
			projectReport.FamilyCollapsed = append(projectReport.FamilyCollapsed, key.group)
		case groupTally.suppressed > 0:
			projectReport.NoiseOnly = append(projectReport.NoiseOnly, key.group)
		default:
			projectReport.UnchangedGroups++
		}
		report.PerProject[key.project] = projectReport
	}
	for project, projectReport := range report.PerProject {
		sort.Strings(projectReport.FamilyCollapsed)
		sort.Strings(projectReport.NoiseOnly)
		sort.Strings(projectReport.MixedGroups)
		report.PerProject[project] = projectReport
	}
	return report
}
