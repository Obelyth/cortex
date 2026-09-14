# Export privacy checks

The export gate compares shipped source with a private reference corpus before a
public release. It checks note paths, distinctive note names, copied sentences and
credential-shaped values. A normal test run without that corpus is not privacy
evidence. Release verification must set `BRAIN_DIR` to the reviewed corpus and
`REQUIRE_EXPORT_GATE=1`; a missing corpus then fails the run.

## Public repository names

A public repository name can also be the name of a private note. That overlap does
not make the repository reference private, but it must not create an exemption for
the rest of a workflow file.

`tests/helpers/export-public-references.json` records reviewed public repository
references. Each entry fixes the local workflow file, repository, called workflow
and Git ref. Before adding an entry, independently verify that the repository is
public and that the workflow uses those exact values. This is a reviewed policy,
not automatic trust in any GitHub URL.

Only the repository identifier within these exact forms is recognized:

- The installer's standard attribution comment.
- Its full-description GitHub URL comment.
- The matching reusable-workflow `uses:` line.
- The corresponding `repository` value in the policy itself.

The rest of each line and file remains subject to every privacy check. A private
path, an unapproved occurrence of the same name, an unrelated name, copied prose or
a credential still fails. Changed owners, workflow paths, refs, URL suffixes and
extra same-line text require review. Malformed or duplicate policy entries fail
closed. Do not exclude a generated workflow or globally allow its matching note
name to silence a failure.

## Regression coverage

`tests/export-reference-policy.test.ts` checks exact forms, malformed policies and
escaped or repeated occurrences. `tests/export-reference-gate.integration.test.ts`
runs the real export gate against an isolated synthetic corpus. It first confirms
the public references pass, then injects private paths, names, prose and credentials
to confirm the intended checks fail. These fixtures contain no real private notes.

Run both suites with:

```sh
npx vitest run tests/export-reference-policy.test.ts tests/export-reference-gate.integration.test.ts
```

Those synthetic tests protect the gate's behavior. They do not replace the enforced
check against the private reference corpus before publication.
