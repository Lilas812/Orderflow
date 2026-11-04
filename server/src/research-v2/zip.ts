import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { crc32 } from "node:zlib";
export const ENTRIES = ["samples.csv", "features.csv", "history.csv", "annotations.csv", "targets.csv",
  "splits.csv", "quality.json", "manifest.json", "columns.md", "README.md", "config.json"] as const;
/** Independent v2 ZIP32 writer. The v1 three-entry allowlist remains unchanged. */
export async function zipV2(output: string, directory: string) {
  const out = await fs.open(output, "wx", 0o600), central: Buffer[] = [];
  let offset = 0;
  const write = async (b: Buffer) => {
    for (let n = 0; n < b.length;) {
      const r = await out.write(b.subarray(n)); if (!r.bytesWritten) throw Error("zip_short_write"); n += r.bytesWritten;
    }
    offset += b.length; if (offset > 0xffffffff) throw Error("zip32_limit");
  };
  try {
    for (const name of ENTRIES) {
      const bytes = Buffer.from(name), start = offset, local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6); local.writeUInt16LE(bytes.length, 26);
      await write(local); await write(bytes);
      let crc = 0, size = 0;
      const input = createReadStream(`${directory}/${name}`);
      try { for await (const b of input) { crc = crc32(b, crc); size += b.length; await write(b); } }
      finally { input.destroy(); }
      const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc >>> 0, 4); descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12); await write(descriptor);
      const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
      c.writeUInt16LE(8, 8); c.writeUInt32LE(crc >>> 0, 16); c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24);
      c.writeUInt16LE(bytes.length, 28); c.writeUInt32LE(start, 42); central.push(Buffer.concat([c, bytes]));
    }
    const start = offset; for (const c of central) await write(c);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(ENTRIES.length, 8);
    end.writeUInt16LE(ENTRIES.length, 10); end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16); await write(end);
  } finally { await out.close(); }
}
