#!/bin/bash
# Double-click me — macOS opens Terminal and walks you through Cortex setup.
#
# The first time, macOS may warn that this file came from the internet:
# right-click (or Control-click) it, choose Open, then Open again. After that
# it double-clicks normally. Everything it does is asked about first; the real
# work happens in scripts/bootstrap-macos.sh, which you can read.
cd "$(dirname "$0")" || exit 1
/bin/bash scripts/bootstrap-macos.sh
status=$?
if [[ $status -ne 0 ]]; then
  printf '\nSetup stopped before finishing (see above). Fix what it printed, then double-click again.\n'
fi
read -r -p "Press Return to close this window. "
exit $status
