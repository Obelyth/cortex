// CPU-only synthetic benchmark. Run each size in a fresh process from the repository root:
// node --expose-gc scripts/benchmark-lexical.cjs SIZE [baseline-json]
// The fixture/query sequence matches the controller's synthetic-2048-ascii-v1 baseline.
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createServer } = require('vite');
const { readRepositoryJson } = require('./benchmark-support.cjs');
const { resolveTrustedExecutable } = require('./command-path.cjs');

(async () => {
  const size = Number(process.argv[2]);
  if (![200, 2000, 10000].includes(size) || !global.gc) throw new Error('Use --expose-gc and size 200, 2000, or 10000');
  global.fetch = async () => { throw new Error('Synthetic benchmark must not use network fetch'); };
  const git = resolveTrustedExecutable('git');
  const head = execFileSync(git, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const status = execFileSync(git, ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  const dirty = status.split('\n').filter(Boolean).some(line => line !== '?? supabase/.temp/');
  const loader = await createServer({ root: process.cwd(), configFile: false, logLevel: 'silent', server: { middlewareMode: true, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  let narrowDetail, prepareLexical;
  try {
    ({ narrowDetail } = await loader.ssrLoadModule('/lib/narrow.ts'));
    ({ prepareLexical } = await loader.ssrLoadModule('/lib/lexical.ts'));
  } finally { await loader.close(); }
  const topics = ['deploy', 'storage', 'memory', 'index', 'router', 'timeout', 'database', 'recall'];
  const files = new Map();
  for (let i = 0; i < size; i++) {
    const header = `# project p${i % 97} note ${i}\n`;
    const sentence = `${topics[i % topics.length]} project p${i % 97} checkpoint ${i % 31} configuration verified source document ${topics[(i + 3) % topics.length]} details bounded context handoff. `;
    const body = (header + sentence.repeat(Math.ceil(2048 / sentence.length))).slice(0, 2048);
    if (Buffer.byteLength(body) !== 2048) throw new Error('Fixture body must be exactly 2048 bytes');
    files.set(`notes/synthetic-${String(i).padStart(5, '0')}.md`, body);
  }
  const options = { budgetBytes: 400000, maxPartsPerPage: 2 };
  const queries = Array.from({ length: 12 }, (_, i) => `project p${(17 + i * 7) % 97} ${topics[i % topics.length]} ${topics[(i + 3) % topics.length]} checkpoint ${i % 31}`);
  const jit = new Map([['notes/jit.md', 'project p17 deploy timeout checkpoint']]);
  for (let i = 0; i < 20; i++) narrowDetail(jit, queries[0], 15, options);
  global.gc(); const before = process.memoryUsage();
  const start = performance.now(), prepared = prepareLexical(files);
  const coldPreparationMs = performance.now() - start;
  const scoreStart = performance.now(); prepared.score(queries[0]);
  const coldScoringMs = performance.now() - scoreStart;
  global.gc(); const afterPreparation = process.memoryUsage();
  const validationMs = [], scoringMs = [], wholeMs = [], paths = [];
  for (const query of queries) {
    const p = performance.now(), current = prepareLexical(files); validationMs.push(performance.now() - p);
    if (current !== prepared) throw new Error('Measured corpus did not retain its prepared index');
    const s = performance.now(); current.score(query); scoringMs.push(performance.now() - s);
    const w = performance.now(), result = narrowDetail(files, query, 15, options); wholeMs.push(performance.now() - w); paths.push(result.paths);
  }
  global.gc(); const after = process.memoryUsage();
  const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[5] + sorted[6]) / 2; };
  let selectionsMatchBaseline = null;
  if (process.argv[3]) {
    const parsed = readRepositoryJson(path.join(__dirname, '..'), process.argv[3]);
    if (!Array.isArray(parsed)) throw new Error('Comparable baseline must be a JSON array');
    const baseline = parsed.find(row => row && typeof row === 'object' && row.size === size);
    if (!baseline || baseline.fixtureVersion !== 'synthetic-2048-ascii-v1') throw new Error('Comparable baseline size/fixture missing');
    selectionsMatchBaseline = JSON.stringify(paths) === JSON.stringify(baseline.warmPaths);
    if (!selectionsMatchBaseline) process.exitCode = 1;
  }
  console.log(JSON.stringify({ fixtureVersion: 'synthetic-2048-ascii-v1', at: new Date().toISOString(), head, source: dirty ? 'working-tree' : 'committed', node: process.version, icu: process.versions.icu,
    platform: `${os.platform()} ${os.arch()} ${os.release()}`, cpu: os.cpus()[0]?.model, loadAverage: os.loadavg(), size, bodyBytes: 2048,
    coldPreparationMs, coldScoringMs, validationMs, scoringMs, wholeMs, warmValidationMedianMs: median(validationMs), warmScoringMedianMs: median(scoringMs), warmWholeMedianMs: median(wholeMs),
    heapWithCorpusBytes: before.heapUsed, heapAfterPreparationBytes: afterPreparation.heapUsed, heapAfterWarmBytes: after.heapUsed,
    retainedAfterPreparationBytes: afterPreparation.heapUsed - before.heapUsed, retainedAfterWarmBytes: after.heapUsed - before.heapUsed, rssAfterWarmBytes: after.rss,
    selectionsMatchBaseline, warmPaths: paths,
    note: 'One cold preparation and cold score; twelve warm validation/scoring/whole samples. Whole samples follow explicit scoring and are not cold-call measurements. GC/host noise applies; no accuracy claim.' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
