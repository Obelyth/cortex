import {createConnection} from "node:net";
export async function redisCommand(socket:string|undefined,...args: (string | number)[]): Promise<unknown> {
  if (!socket?.startsWith("/")) throw new Error("explicit absolute test Unix socket required");
  return new Promise((resolve, reject) => {
    const client = createConnection(socket); let input = Buffer.alloc(0);
    const read = (at = 0): [unknown, number] | null => {
      const end = input.indexOf("\r\n", at); if (end < 0) return null;
      const type = String.fromCharCode(input[at]); const value = input.toString("utf8", at + 1, end); let pos = end + 2;
      if (type === "-") throw new Error(value);
      if (type === "+") return [value, pos];
      if (type === ":") return [Number(value), pos];
      if (type === "$") { const n = Number(value); if (n === -1) return [null, pos]; if (input.length < pos + n + 2) return null; return [input.toString("utf8", pos, pos + n), pos + n + 2]; }
      if (type === "*") { const out: unknown[] = []; for (let i = 0; i < Number(value); i++) { const part = read(pos); if (!part) return null; out.push(part[0]); pos = part[1]; } return [out, pos]; }
      throw new Error("unknown RESP type");
    };
    client.setTimeout(3000, () => client.destroy(new Error("isolated Redis timeout")));
    client.on("error", reject);
    client.on("connect", () => client.write(`*${args.length}\r\n` + args.map(a => { const s = String(a); return `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }).join("")));
    client.on("data", chunk => { input = Buffer.concat([input, typeof chunk === "string" ? Buffer.from(chunk) : chunk]); try { const result = read(); if (result) { client.end(); resolve(result[0]); } } catch (e) { client.destroy(); reject(e); } });
  });
}
