#!/bin/bash
# Run from a terminal: bash "/path/to/extracted/Cortex Setup.sh"
# Linux file managers differ in how they open executable shell scripts.
set -u

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
/bin/bash "$SOURCE_DIR/scripts/bootstrap-linux.sh"
status=$?
if [[ $status -ne 0 ]]; then
  printf '\nSetup stopped before finishing (see above). Resolve the reported issue, then run this launcher again.\n' >&2
fi
exit "$status"
