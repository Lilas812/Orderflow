import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { crc32 } from "node:zlib";
import { finished } from "node:stream/promises";

/** ZIP32, stored entries, streamed from request-owned files; no raw market-data entries. */
export async function zipFiles(output: string, files: { name: string; file: string }[]) {
  const out = await fs.open(output, "wx", 0o600);
  const central: Buffer[] = [];
  let offset = 0;
  const write = async (b: Buffer) => {
    let written = 0;
    while (written < b.length) {
      const result = await out.write(b.subarray(written));
      if (result.bytesWritten <= 0) throw Error("labels_zip_short_write");
      written += result.bytesWritten;
    }
    offset += b.length;
  };
  try {
    for (const { name, file } of files) {
      if (!["events.csv", "columns.md", "summary.json"].includes(name)) throw Error("invalid_zip_entry");
      const bytes = Buffer.from(name), start = offset;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6);
      local.writeUInt16LE(bytes.length, 26);
      await write(local); await write(bytes);
      let crc = 0, size = 0;
      const input = createReadStream(file);
      try {
        for await (const b of input) {
          crc = crc32(b, crc); size += b.length;
          if (size > 0xffffffff || offset + b.length > 0xffffffff) throw Error("zip32_limit");
          await write(b);
        }
      } finally { input.destroy(); await finished(input).catch(() => {}); }
      const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc >>> 0, 4); descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
      c.writeUInt16LE(8, 8); c.writeUInt32LE(crc >>> 0, 16);
      c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(bytes.length, 28);
      c.writeUInt32LE(start, 42); central.push(Buffer.concat([c, bytes]));
    }
    const start = offset;
    for (const c of central) await write(c);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    await write(end);
  } finally { await out.close(); }
}
