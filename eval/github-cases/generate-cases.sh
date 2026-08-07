#!/bin/bash
# Emit one JSON case per fix-PR/issue pair: the bug report as input, the files
# the fix touched as ground truth, and the commit BEFORE the fix to check out.
REPO=$1; LIMIT=${2:-60}
gh api graphql -f query='
query($owner:String!,$name:String!,$n:Int!) {
  repository(owner:$owner,name:$name) {
    pullRequests(states:MERGED, first:$n, orderBy:{field:CREATED_AT,direction:DESC}) {
      nodes { number title mergeCommit{oid parents(first:1){nodes{oid}}}
        files(first:30){nodes{path}}
        closingIssuesReferences(first:1){nodes{number title body}} } } }
}' -f owner="${REPO%/*}" -f name="${REPO#*/}" -F n="$LIMIT" --jq '
.data.repository.pullRequests.nodes[]
| select(.closingIssuesReferences.nodes|length>0)
| select(.title|test("^fix"))
| {repo:"'"$REPO"'", pr:.number, pr_title:.title,
   base_sha:.mergeCommit.parents.nodes[0].oid,
   fix_sha:.mergeCommit.oid,
   ground_truth:[.files.nodes[].path]|map(select(test("test|spec|__|\\.md$|changeset")|not)),
   issue:.closingIssuesReferences.nodes[0].number,
   issue_title:.closingIssuesReferences.nodes[0].title,
   issue_body:(.closingIssuesReferences.nodes[0].body//"")}
| select(.ground_truth|length>0 and length<=3)
| select(.issue_body|length>200)'
