A snapshot of `main` with the full check suite re-run at this tag. Updates ship from `main` ([SECURITY.md](https://github.com/Obelyth/cortex/blob/main/SECURITY.md)).

**Already running Cortex?** One command pulls what shipped, redeploys, and re-verifies the doors:

```bash
npm run update
```

If an **Action required** section appears below, do those steps too — they are the manual part (a new env var, a migration) the one command cannot do for you. No section means no manual steps. To hear about the next release: **Watch → Custom → Releases** on the repo.

**New here? Set up in five minutes** (Node 20+, `gh` and `vercel` CLIs logged in):

```bash
npm install
npm run onboard
```

On a Mac, the download can do the prerequisites too: double-click **`Cortex Setup.command`** (first time: right-click it, choose Open) — it installs what is missing, asking before each step, signs you in to GitHub and Vercel, and starts the same wizard.

The wizard creates your private brain repo from the included template, asks whether to start fresh or index an existing folder of notes (preview first, then commit), generates your secrets locally, deploys to Vercel, verifies the deployment against the live tool roster, and prints the wiring commands for your devices. Safe to re-run.

---
