// Zip the built extension/ folder for people who want to install Rove without Node.
// Usage: npm run package  ->  release/rove-<version>.zip (contains one folder, rove-<version>/, with manifest.json).
import { deflateRawSync, crc32 } from "node:zlib";
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const source = join(root, "extension");
if (!existsSync(join(source, "manifest.json"))) throw new Error("extension/manifest.json is missing. Run npm run build first.");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
if (manifest.version !== version) throw new Error(`extension/manifest.json is ${manifest.version} but package.json is ${version}. Run npm run build first.`);

const files = [];
(function walk(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (!name.endsWith(".map")) files.push(path); // source maps are for debugging the build, not for installing
  }
})(source);

const folder = `rove-${version}`;
const local = [], central = [];
let offset = 0;
// A fixed timestamp keeps the zip reproducible for a given build.
const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (10 << 5) | 21;
for (const path of files) {
  const name = Buffer.from(`${folder}/${relative(source, path).split(sep).join("/")}`);
  const data = readFileSync(path);
  const packed = deflateRawSync(data, { level: 9 });
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // UTF-8 names
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc32(data) >>> 0, 14);
  header.writeUInt32LE(packed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  local.push(header, name, packed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(dosTime, 12);
  entry.writeUInt16LE(dosDate, 14);
  entry.writeUInt32LE(crc32(data) >>> 0, 16);
  entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += header.length + name.length + packed.length;
}
const centralSize = central.reduce((total, part) => total + part.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(root, "release"), { recursive: true });
const output = join(root, "release", `${folder}.zip`);
writeFileSync(output, Buffer.concat([...local, ...central, end]));
console.log(`${relative(root, output)}  ${files.length} files  ${(statSync(output).size / 1024).toFixed(0)} KB`);
