# Optional machine reporting

Browser devices register from the dashboard. This optional Linux reporter is different: it reports machine health for a unit already registered in your Ops ledger. Nothing in this folder installs a service or creates a unit automatically.

An administrator can install the supplied user service and timer after reviewing the script. Configure `OPS_TOKEN`, your deployment's HTTPS `CORTEX_URL`, and the matching unit ID as `UNIT` in `~/.config/cortex/ops.env`. Restrict that file to the owning user (mode 600). The default unit ID is `workstation`; change it for each machine. Do not share the token or include this file in a repository.

The reporter sends disk use, uptime, backup status, hostname, and a count of local Claude processes to your deployment. Review that data before enabling it. A browser opening the console does not install this reporter, and a phone will appear as a browser device only after opening and registering with the same deployment.
