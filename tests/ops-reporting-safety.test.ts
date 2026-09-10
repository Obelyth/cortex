import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

let scratch: string;
let capture: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cortex-report-test-"));
  capture = join(scratch, "curl.json");
  const config = join(scratch, "home", ".config", "cortex");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "ops.env"), "# Synthetic settings are supplied through the child environment.\n", { mode: 0o600 });
  writeFileSync(join(scratch, "curl"), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(process.env.REPORT_TEST_CAPTURE,JSON.stringify(args));const out=args[args.indexOf('-o')+1];if(out&&out!='/dev/null')fs.writeFileSync(out,'{}');process.stdout.write(process.env.REPORT_TEST_STATUS||'200');`, { mode: 0o700 });
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

// Mock only machine inputs. The actual configuration-file read, Bash serialization,
// and curl invocation run unchanged, inside the test's own scratch home.
const heartbeatInputs = `
df() { printf 'Use%%\\n42%%\\n'; }
cut() { printf '12345\\n'; }
cat() { printf '%s' "$REPORT_TEST_BACKUP"; }
pgrep() { printf '0\\n'; return 1; }
hostname() { printf '%s' "$REPORT_TEST_HOST"; }
date() { printf '20260102'; }
builtin source "$1"
`;

function report(kind: "heartbeat" | "routine", url: string, args: string[] = [], extra: Record<string, string> = {}) {
  const script = resolve(kind === "heartbeat" ? "ops/heartbeat/cortex-heartbeat.sh" : "ops/routines/report.sh");
  return spawnSync("bash", kind === "heartbeat" ? ["-c", heartbeatInputs, "heartbeat-test", script] : [script, ...args], {
    encoding: "utf8", env: { ...process.env, HOME: join(scratch, "home"), PATH: `${scratch}:${process.env.PATH}`, OPS_TOKEN: "synthetic-ops-token",
      CORTEX_URL: url, UNIT: "workstation", REPORT_TEST_CAPTURE: capture, REPORT_TEST_BACKUP: 'backup "ok"\\path\nnext\tvalue',
      REPORT_TEST_HOST: 'host"\\name', ...extra },
  });
}

function capturedBody() {
  const args: string[] = JSON.parse(readFileSync(capture, "utf8"));
  expect(() => JSON.parse(args[args.indexOf("-d") + 1])).not.toThrow();
  return { args, body: JSON.parse(args[args.indexOf("-d") + 1]) };
}

describe("Ops reporter transport and serialization", () => {
  it.each(["heartbeat", "routine"] as const)("%s refuses HTTP before transmitting the Ops token", (kind) => {
    const result = report(kind, "http://example.invalid", ["start", "unit", "run"]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("CORTEX_URL must use HTTPS");
    expect(existsSync(capture)).toBe(false);
  });
  it.each(["heartbeat", "routine"] as const)("%s restricts curl to HTTPS and never follows redirects", (kind) => {
    const result = report(kind, "https://example.invalid", ["start", "unit", "run"]);
    expect(result.status, result.stderr).toBe(0);
    const args: string[] = JSON.parse(readFileSync(capture, "utf8"));
    expect(args[args.indexOf("--proto") + 1]).toBe("=https");
    expect(args).not.toContain("-L");
    expect(args).not.toContain("--location");
  });
  it("serializes heartbeat string facts as valid JSON and keeps one run key per UTC day", () => {
    const result = report("heartbeat", "https://example.invalid", [], { UNIT: 'machine"\\id' });
    expect(result.status, result.stderr).toBe(0);
    expect(capturedBody().body).toEqual({ unit: 'machine"\\id', verb: "heartbeat", run_key: "hb-20260102",
      facts: { disk_pct: 42, uptime_s: 12345, backup: 'backup "ok"\\path\nnext\tvalue', claude_sessions: 0, host: 'host"\\name' } });
  });
  it("preserves tabs, newlines, backslashes, quotes and control characters in routine reports", () => {
    const summary = 'quoted "text"\\path\nnext\titem\rreturn\bback\fform\x01control';
    const result = report("routine", "https://example.invalid", ["finish", 'unit"', "run\\key", "ok", summary, 'https://example.invalid/a?q="b",https://example.invalid/c\\d', "bad\terror\nline"]);
    expect(result.status, result.stderr).toBe(0);
    expect(capturedBody().body).toEqual({ unit: 'unit"', verb: "finish", run_key: "run\\key", ok: true, summary,
      evidence: ['https://example.invalid/a?q="b"', "https://example.invalid/c\\d"], error: "bad\terror\nline" });
  });
  it.each(["heartbeat", "routine"] as const)("%s reports an unsuccessful HTTP status as failure", (kind) => {
    const result = report(kind, "https://example.invalid", ["start", "unit", "run"], { REPORT_TEST_STATUS: "403" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("returned 403");
  });
});
