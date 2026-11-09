#!/usr/bin/env bash
# Live check of the plugin through `archon forge`, against a real Linear team: every operation
# the SDLC pack uses on a work item, each answer checked. It creates one issue and one label,
# then deletes both (the issue goes to Linear's trash). Needs `archon` with this plugin
# configured, `jq`, `curl`, and LINEAR_API_KEY in the environment.
#
#   probes/live-probe.sh <team-key> <workspace-url-key>
TEAM=${1:?usage: live-probe.sh <team-key> <workspace-url-key>}
WORKSPACE=${2:?usage: live-probe.sh <team-key> <workspace-url-key>}
set -- "$TEAM" "$WORKSPACE"
# No -e: a failed check is counted and the probe goes on, so cleanup always runs.
set -uo pipefail
team=$1 workspace=$2
dir=$(mktemp -d); cd "$dir"
repo="{\"host\":\"linear.app\",\"path\":\"$workspace/$team\"}"
marker="<!-- forge-linear-probe $(date +%s) -->"
label=forge-linear-probe
fails=0

forge() { # op request-json -> prints the response, returns archon's exit code
  printf '%s' "$2" > req.json
  archon forge "$1" --data-file req.json 2>/dev/null
}
check() { # name jq-condition response
  if jq -e "$2" <<< "$3" > /dev/null; then echo "ok   $1"; else echo "FAIL $1: $(jq -c . <<< "$3" | head -c 600)"; fails=$((fails + 1)); fi
}

body=$(printf '%s\n## Problem\n\n- dash bullet\n\nDepends on: nothing' "$marker")
r=$(forge workitem.create "$(jq -n --argjson repo "$repo" --arg m "$marker" --arg b "$body" '{repo:$repo,title:"forge-linear probe (delete me)",body:$b,marker:$m}')")
check "create" '.ok and .result.value.changed and .result.value.workitem.state == "open"' "$r"
number=$(jq -r '.result.value.workitem.ref.number' <<< "$r")
ref="{\"repo\":$repo,\"number\":$number}"
subject="{\"kind\":\"issue\",\"ref\":$ref}"

r=$(forge workitem.create "$(jq -n --argjson repo "$repo" --arg m "$marker" --arg b "$body" '{repo:$repo,title:"again",body:$b,marker:$m}')")
check "create again finds it by marker" ".ok and (.result.value.changed | not) and .result.value.workitem.ref.number == $number" "$r"

r=$(forge workitem.view "{\"ref\":$ref}")
check "view" ".ok and (.result.value.body | startswith(\"$marker\")) and .result.value.author.login != null" "$r"

r=$(forge repo.label.ensure "$(jq -n --argjson repo "$repo" --arg n "$label" '{repo:$repo,name:$n,color:"FBCA04",description:"forge-linear probe label"}')")
check "label ensure" '.ok and .result.value.changed' "$r"
r=$(forge workitem.label.add "$(jq -n --argjson s "$subject" --arg n "$label" '{subject:$s,name:$n}')")
check "label add" ".ok and (.result.value.labels | index(\"$label\"))" "$r"
r=$(forge workitem.list "$(jq -n --argjson repo "$repo" --arg n "$label" '{repo:$repo,label:$n}')")
check "list by label" "[.result.value.items[].ref.number] == [$number]" "$r"
r=$(forge workitem.label.remove "$(jq -n --argjson s "$subject" --arg n "$label" '{subject:$s,name:$n}')")
check "label remove" ".ok and (.result.value.labels | index(\"$label\") | not)" "$r"

c1=$(printf '<!-- forge-linear-probe:comment -->\nfirst **version**\n\n- a\n- b\n')
c2=$(printf '<!-- forge-linear-probe:comment -->\nsecond version\n\n<details><summary>s</summary>\n\nx\n\n</details>')
r=$(forge workitem.comment.upsert "$(jq -n --argjson s "$subject" --arg b "$c1" '{subject:$s,marker:"<!-- forge-linear-probe:comment -->",body:$b}')")
check "comment create" '.ok and .result.value.changed' "$r"
id=$(jq -r '.result.value.comment.id' <<< "$r")
r=$(forge workitem.comment.upsert "$(jq -n --argjson s "$subject" --arg b "$c2" '{subject:$s,marker:"<!-- forge-linear-probe:comment -->",body:$b}')")
check "comment replace in place" ".ok and .result.value.comment.id == \"$id\"" "$r"
r=$(forge workitem.comments "{\"subject\":$subject}")
if jq -e --arg b "$c2" '(.result.value.comments | length) == 1 and .result.value.comments[0].body == $b' <<< "$r" > /dev/null; then
  echo "ok   comments read exact"
else
  echo "FAIL comments read exact: $(jq -c . <<< "$r" | head -c 600)"; fails=$((fails + 1))
fi

r=$(forge workitem.view "{\"ref\":$ref}")
current=$(jq -r '.result.value.body' <<< "$r")
r=$(forge workitem.edit-body "$(jq -n --argjson ref "$ref" --arg b "$current"$'\n\n\n### Current scope (2026-11-08)\n\nOnly the API.' '{ref:$ref,body:$b}')")
check "edit body (append a section)" '.ok and .result.value.changed' "$r"

r=$(forge workitem.close "{\"ref\":$ref,\"reason\":\"not_planned\"}")
check "close not_planned" '.ok and .result.value.workitem.state == "closed" and .result.value.reason == "not_planned"' "$r"
r=$(forge workitem.close "{\"ref\":$ref,\"reason\":\"completed\"}")
check "close for another reason is refused" '(.ok | not) and .error.kind == "conflict" and .mutation.outcome == "refused"' "$r"

gql() { curl -sf https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" -H 'Content-Type: application/json' -d "$1"; }
issue_id=$(gql "{\"query\":\"{ issues(filter:{team:{key:{eq:\\\"$team\\\"}},number:{eq:$number}}){nodes{id}} }\"}" | jq -r '.data.issues.nodes[0].id')
label_id=$(gql "{\"query\":\"{ issueLabels(filter:{name:{eq:\\\"$label\\\"}}){nodes{id}} }\"}" | jq -r '.data.issueLabels.nodes[0].id')
echo "cleanup: issue $(gql "{\"query\":\"mutation { issueDelete(id:\\\"$issue_id\\\"){success} }\"}" | jq -r .data.issueDelete.success)," \
  "label $(gql "{\"query\":\"mutation { issueLabelDelete(id:\\\"$label_id\\\"){success} }\"}" | jq -r .data.issueLabelDelete.success)"
rm -rf "$dir"
echo "$fails failed"
exit $(( fails > 0 ))
