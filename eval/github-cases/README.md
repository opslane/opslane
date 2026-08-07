# Diagnosis evals from real closed bugs

Every case here is a real bug report from a public repository, paired with the
pull request that actually fixed it. The investigation sees the issue and the
repository **at the commit before the fix**. The files the merged PR changed are
the ground truth, and they are never shown to the agent.

This exists because synthetic fixtures encode the author's assumptions. Ours had
four files and a comment in the backend saying `# Full table scan on every
request`, which is a confession no real codebase makes. The first run against
real repositories found a parser bug within three cases: a citation of
`lib/core/InterceptorManager.js:36-39` named exactly the right file and was
discarded, because only a bare `file:42` parsed.

## Generate cases

```bash
bash generate-cases.sh axios/axios 60 >> cases.jsonl
```

Takes merged PRs whose title starts with `fix`, that close an issue, that touch
three or fewer non-test files, and whose issue body is long enough to describe
something. Ground truth is the file list.

## Run

```bash
export ANTHROPIC_API_KEY=...
node run.mjs                       # every case in cases.jsonl
node run.mjs "" 10                 # first 10
node run.mjs "axios/axios#11070"   # one case
CASES=cases-apps.jsonl node run.mjs   # a different corpus file
```

`run-sdk.mjs` takes the same arguments and the same `CASES` variable, and shares
its case loading, retry policy and report with `run.mjs` through `harness.mjs`.
The retry policy lives there and nowhere else: when it was copied per runner the
two arms drifted and the comparison stopped being matched.

The default is the whole file. A subset run prints `PARTIAL RUN: n of N cases`
in the report body, so it cannot be mistaken for a corpus result.

Each repository is fetched at **exactly one commit** (`--depth 1` of
`base_sha`) into `/tmp/opslane-gheval-repos`. The earlier blobless clone fetched
every ref, which made the merged fix reachable from the working tree; the runner
now also asserts that `fix_sha` does not resolve and refuses to run if it does.
Results land in `results.json`.

## Reading the score

`HIT RATE` is the headline, but it is a floor, not a ceiling. It scores the
**first** citation only: the prompt says the first entry is the claim, so a
padded list cannot buy a hit. A miss can still be a good diagnosis: axios #6721 was scored a miss for citing
`lib/adapters/fetch.js:556`, the site that re-throws, when the fix landed in
`lib/core/AxiosError.js`. That is the failure this whole design targets, naming
where the error surfaced instead of where it was caused, and it is worth a human
reading rather than a number.

The report gives both denominators (`hits/ran` and `hits/answered`) and splits
`REFUSALS` into `insufficient` and `no adjudication`, on purpose. A run that
never submitted a diagnosis is a harness or rate-limit problem, not a wrong
answer, and folding the two together makes the agent look worse than it is.

## Comparing against the Claude Agent SDK

`run-sdk.mjs` puts the same cases through the Claude Agent SDK, which brings its
own tools, loop and context management. It gets the bug report and the repo at
the same commit, and is asked for one `CAUSE:` line.

Read the difference carefully rather than as a scoreboard. Our pipeline
deliberately refuses to answer when the evidence does not separate its
candidates, so some of its misses are that refusal working. The SDK always
answers. Hit rate therefore measures willingness to commit as much as it
measures diagnosis quality, and the two harnesses are not tuned to the same
point on that trade.

Retries are matched: both arms get at most 3 attempts per case, retried only on
a transport or rate-limit failure, and every attempt's cost is counted.

Turn budgets are not matched by default (the SDK gets 30, ours 10 — the
adjudication pass and its separate budget were retired with the two-agent
split). Set `INVESTIGATION_MAX_TURNS` and `SDK_MAX_TURNS` if you want a
controlled comparison.
