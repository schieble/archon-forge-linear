# archon-forge-linear

An [Archon](https://github.com/coleam00/Archon) forge plugin (protocol 1) for work items in
**Linear**. It serves the work-item side of the SDLC pack: issues, comments, labels and state.
Pull requests stay with your code forge (`forge-github` or `gh`).

## Install

```sh
archon plugin add schieble/archon-forge-linear
```

This downloads the release binary for your platform, checks it against the release's
`checksums.txt`, and puts it in `ARCHON_HOME/plugins/`. Give the plugin a Linear API key in the
environment Archon runs with, for example in `~/.archon/.env`:

```sh
LINEAR_API_KEY=lin_api_...
```

The key needs read and write access to the teams you use. Check the install with:

```sh
archon forge metadata --data '{"host":"linear.app"}'
```

## Addressing

A Linear team stands where a repository would. Issue `ENG-12` in the workspace whose URL is
`linear.app/acme` is:

```json
{ "repo": { "host": "linear.app", "path": "acme/ENG" }, "number": 12 }
```

`acme` is the workspace's URL key, and `ENG` the team key. The plugin claims host `linear.app` and
refuses a `pr` subject, because Linear has no pull requests.

## Operations

`workitem.view`, `workitem.comments`, `workitem.list`, `workitem.create`, `workitem.labels.set`,
`workitem.label.add`, `workitem.label.remove`, `workitem.comment.upsert`, `workitem.close`,
`workitem.edit-body`, `repo.labels.list`, `repo.label.ensure`.

How Linear maps onto them:

- **State.** Issues in triage, backlog, unstarted or started states are open. Completed and
  canceled issues are closed. A close moves the issue to the team's first completed state
  (`completed`), a canceled state named like "Duplicate" (`duplicate`), or another canceled state
  (`not_planned`). Closing an issue that is already closed for another reason is a `conflict`.
- **Labels** are the team's labels plus the workspace's, with label groups left out.
  `workitem.label.add` and `workitem.label.remove` use Linear's single-label writes, so a label
  another writer adds at the same moment survives. `repo.label.ensure` creates a team label.
- **Authors.** An author's `login` is the Linear display name, which is unique in the workspace.
- **Comments** are stored byte for byte, and each upsert is proven by its exact read-back.
- **Trash.** An issue in Linear's trash is never found, listed or recovered by its marker.

### Descriptions: Linear rewrites Markdown

Linear rewrites Markdown as it stores a description. It adds a blank line after the first line,
changes `-` bullets to `*`, writes `[x]` as `[X]`, turns bare URLs into links, escapes some
characters and collapses repeated blank lines. The first line survives, which is where the SDLC
pack keeps its `<!-- marker -->`.

So a description write cannot be proven by the digest of the text sent. The plugin counts it as
applied when a fresh read returns exactly the text Linear answered the write with: this write
produced the description, and no other edit landed after it. The `bodyDigest` it then reports is
the digest of the **requested** text, which is what Archon's host checks. It is not a digest of
the bytes Linear holds. Resending an unchanged body always writes again, because the stored text
never equals the text sent.

## Using it with the SDLC pack

The pack, as Archon ships it, expects a queue's `repo_host`/`repo_path` to hold both the work items
and the pull requests. Keeping work items in Linear and code on GitHub also needs changes to the
pack. They are described in [coleam00/Archon#5424](https://github.com/coleam00/Archon/issues/5424).

## Development

```sh
bun install
bun test             # 42 tests against an in-memory Linear; every answer checked with
                     # Archon's response schemas and host-side result matcher
bun run typecheck
bun run build        # dist/archon-forge-linear for this machine
```

`src/contract/` is Archon's forge contract, copied unmodified from the engine commit named in
`src/contract/README.md`. Refresh it with `scripts/sync-contract.sh <archon-checkout>`.

`probes/live-probe.sh <TEAM> <workspace>` runs every operation through `archon forge` against a
real Linear team, with `LINEAR_API_KEY` set, and deletes what it creates.

To use a local build instead of a release, configure it in `~/.archon/config.yaml`:

```yaml
forge:
  plugins:
    - plugin: linear
      command: /path/to/archon-forge-linear
```

A `v*` tag builds the binaries for Linux, macOS and Windows (x64 and arm64) and publishes them
with `checksums.txt`.

## License

MIT
