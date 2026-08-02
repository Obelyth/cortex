# Conventions this brain runs on

- **Layout**: `profile.md` (boot file) · `projects/<name>.md` (one page per
  project) · `notes/<topic>.md` (evergreen) · `log/YYYY-MM-DD.md` (daily
  capture) · `archive/` (retired, kept verbatim) · `INDEX.md` (generated —
  never hand-edit). `log/` and `archive/` are created by the first write that
  needs them.
- **Retraction markers the server enforces**: the verifier treats a small set
  of marker words as retractions — the exact list is in the Cortex README's
  stamp table. A quote from a marked passage comes back stamped as retracted,
  not VERIFIED. Mark stale claims; do not delete them. (The words are not
  spelled out here on purpose: writing one flags the surrounding block, so a
  note that merely mentions them would boot flagged.)
- **Marker placement matters**: the verifier checks the quoted block, its
  immediate neighbours, and the heading above it — deliberately, so one banner
  cannot blanket a whole page. Put the marker in the heading line to retract an
  entire section, or next to the exact claim to retract one passage. One banner
  at the top of a long section does NOT protect the paragraphs further down.
- **Dated logs are diaries**: a log entry that was true on its date stays as
  written. Standing claims live on project pages and notes, not in logs.
- **Secrets do not belong here.** The server redacts credential-shaped strings
  on the way out, but storing them is the underlying mistake.
