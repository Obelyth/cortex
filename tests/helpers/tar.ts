/**
 * Minimal ustar builder for fixtures — real headers, real checksums, because lib/corpus.ts's
 * untar refuses anything less, and a fixture that bypassed the checksum would be testing a
 * parser nobody runs. Names are written verbatim, so callers include the `repo-sha/` wrapper
 * directory exactly as GitHub emits it.
 */
function seal(h: Buffer): Buffer {
  h.write(" ".repeat(8), 148, 8, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

export function tarOf(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(Buffer.byteLength(body).toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("0", 156, 1, "ascii");
    blocks.push(seal(header));
    const data = Buffer.from(body, "utf8");
    blocks.push(data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
}
