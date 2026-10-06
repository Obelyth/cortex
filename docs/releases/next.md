# Next Cortex release: recall, context and verification

**Status: release preparation, unpublished.** The current public release is
[v2.0.2](https://github.com/Obelyth/cortex/releases/tag/v2.0.2). The improvements
below are the proposed scope of a future release; they are not available in
v2.0.2. A version and release date will be assigned after the public implementation
and upgrade path pass review.

Cortex by OBELYTH is a self-hosted memory server for compatible MCP clients. Its
knowledge lives in a private Markdown repository, and its answer citations can be
checked against source text. This update focuses on choosing useful context,
handling older material explicitly, and making repeated questions less wasteful.

## Proposed release notes

- **Retrieve a useful passage with its context intact.** Best-section lexical
  ranking will select notes by their relevant passages while giving the reader
  the original note. Recall changes will be evaluated before changing defaults.
- **Carry bounded working context between questions.** The reader will receive
  recent source material within explicit limits. Original source passages will
  remain citable; handoff context will be marked as context, not evidence.
- **Reuse eligible context and answers.** Separate prompt-cache blocks will cover
  working context and retrieved sources. Saved answers will track the notes they
  depend on so unrelated edits need not discard an otherwise valid answer.
  Cache eligibility does not guarantee a hit or a particular saving.
- **Consult the archive after a valid "not found" response.** The current-source
  pass will come first, with at most one archive pass after a valid abstention.
  Provider failures and malformed replies will remain errors. This does not
  automatically archive, delete or rewrite notes.
- **Apply consistent selection and verification to offline source access.** An
  offline helper will prepare a bounded local source pack for an existing model
  session and check its returned quotes against those files. This does not supply
  a local model or make model inference work without a provider.
- **Account for the work actually performed.** Usage records will distinguish
  ordinary input, cache reads, cache writes and output, include both reader
  stages when used, and leave unmeasured cost unknown. Larger source packs will
  depend on verified model capacity and explicit limits.

An optional machine verifier is also proposed: a dedicated working copy,
restricted write access and per-run hook controls. Installation and scheduling
will be explicit administrator actions. A fresh install will not enroll a
machine or start a verifier automatically.

## Upgrade requirements to resolve before release

This is not an upgrade procedure. Keep using the guide that belongs to your
installed release until a numbered guide is published.

- Preserve the public migration history. Review every new migration against a
  real upgrade from v2.0.2 and a separate pristine installation; never replace
  historical migration contents or manufacture ledger entries.
- Document the supported Node version, model and provider requirements, new
  configuration, database changes, and any client or verifier installation steps
  from the final public implementation.
- Back up notes and database state separately before an upgrade. The source
  update helper does not apply database migrations, and pristine bootstrap must
  never run over an existing database.
- Keep a fresh brain and Ops register empty. Test fixtures must be invented for
  their assertions. Personal notes, deployment settings and operator history
  do not belong in source packages or examples.

## Release checklist

- [ ] Port the self-hosted implementation and its dependencies without adding
      private managed-hosting components.
- [ ] Retain public onboarding, access controls, privacy checks and supported
      dependency versions; verify the complete resulting application.
- [ ] Test the pristine database and supported upgrade path, including unchanged
      checksums for historical public migrations.
- [ ] Run the enforced export gate against the exact candidate source with the
      reviewed private reference corpus. A skipped gate is not a pass.
- [ ] Pass public type checking, portable tests, production build and zero-skip
      native integration checks. Evaluate retrieval changes with an appropriate
      labelled set; publish only reproducible, explicitly scoped measurements.
- [ ] Assign the version; update both package files, the numbered release guide,
      README links and the reviewed release header to agree with that version.
- [ ] Merge the reviewed release PR, tag its exact main-branch commit, and pass
      the checks at the tag before maintainer approval of publication.
- [ ] Inspect the published source archive and blank template, verify its
      provenance attestation, and check its installation instructions.
- [ ] Announce only the features present in that verified public release.

No release tag, downloadable update, performance claim or release date is
established by this preparation document. See
[the maintainer release process](../../CONTRIBUTING.md#releasing-maintainers).
