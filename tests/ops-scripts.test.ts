import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
describe("ops shell scripts", () => {
  it.each(["ops/heartbeat/cortex-heartbeat.sh", "ops/routines/report.sh"])("%s parses", (f) => { expect(() => execFileSync("bash", ["-n", f])).not.toThrow(); });
  it("the heartbeat reads its token from a 600 file and never echoes it", () => {
    const s = readFileSync("ops/heartbeat/cortex-heartbeat.sh", "utf8");
    expect(s).toContain("$HOME/.config/cortex/ops.env"); expect(s).toContain("set -euo pipefail"); expect(s).not.toMatch(/echo .*OPS_TOKEN/);
  });
  it("the timer fires every 15 minutes with a randomized delay", () => { const t = readFileSync("ops/heartbeat/cortex-heartbeat.timer", "utf8"); expect(t).toMatch(/OnUnitActiveSec=15min/); expect(t).toMatch(/RandomizedDelaySec=/); });
  it("the heartbeat's session count doesn't double up when pgrep finds nothing", () => {
    const s = readFileSync("ops/heartbeat/cortex-heartbeat.sh", "utf8");
    expect(s).not.toMatch(/pgrep[^\n]*\|\|\s*echo 0/);
  });
  it("the heartbeat's run_key is the UTC day, so 96 beats patch one row", () => {
    const s = readFileSync("ops/heartbeat/cortex-heartbeat.sh", "utf8");
    expect(s).toContain('"run_key":"hb-%s"');
    expect(s).toContain("date -u +%Y%m%d)");
    expect(s).not.toContain("%Y%m%d%H%M");
  });
  it("report.sh checks the HTTP status before exiting 0", () => {
    const s = readFileSync("ops/routines/report.sh", "utf8");
    expect(s).toContain("%{http_code}");
  });
});
