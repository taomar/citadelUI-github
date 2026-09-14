import { EXPORT_LIMITS, exportEntryPath, exportFail } from './terraform-literals.mjs';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Deterministic stored ZIP: UTF-8, CRC-32, DOS 1980-01-01, no extras or ZIP64. */
export function createZip(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > EXPORT_LIMITS.files) {
    exportFail('zip-count', 'Choose one to three nonempty output files.');
  }
  const encoder = new TextEncoder();
  const seen = new Set();
  let dataSize = 0;
  const entries = Array.from(files, (file) => {
    if (!file || typeof file !== 'object') exportFail('zip-input', 'Every ZIP entry needs a relative path and byte content.');
    const path = exportEntryPath(file.path);
    const key = path.toLowerCase();
    if (seen.has(key)) exportFail('zip-collision', 'ZIP entries must be unique, including case-insensitive names.');
    seen.add(key);
    if (!(file.bytes instanceof Uint8Array) || !file.bytes.length || file.bytes.length > EXPORT_LIMITS.fileBytes) {
      exportFail('zip-size', 'Each ZIP entry must contain between 1 byte and 8 MiB.');
    }
    dataSize += file.bytes.length;
    if (dataSize > EXPORT_LIMITS.totalBytes) exportFail('zip-size', 'ZIP contents exceed 24 MiB.');
    return { path, name: encoder.encode(path), bytes: file.bytes, crc: crc32(file.bytes) };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const entry of entries) {
    const parts = entry.path.toLowerCase().split('/');
    for (let index = 1; index < parts.length; index++) if (seen.has(parts.slice(0, index).join('/'))) {
      exportFail('zip-collision', 'A ZIP entry cannot also be the parent directory of another entry.');
    }
  }
  const size = 22 + entries.reduce((sum, entry) => sum + 30 + 46 + entry.name.length * 2 + entry.bytes.length, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let at = 0;
  const u16 = (value) => { view.setUint16(at, value, true); at += 2; };
  const u32 = (value) => { view.setUint32(at, value, true); at += 4; };
  const write = (data) => { bytes.set(data, at); at += data.length; };
  for (const entry of entries) {
    entry.offset = at;
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(0); u16(0x21);
    u32(entry.crc); u32(entry.bytes.length); u32(entry.bytes.length);
    u16(entry.name.length); u16(0);
    write(entry.name); write(entry.bytes);
  }
  const directory = at;
  for (const entry of entries) {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(0); u16(0x21);
    u32(entry.crc); u32(entry.bytes.length); u32(entry.bytes.length);
    u16(entry.name.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(entry.offset);
    write(entry.name);
  }
  const directorySize = at - directory;
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
  u32(directorySize); u32(directory); u16(0);
  return bytes;
}
