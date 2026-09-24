// Run on a teacher-only file outside the repository; outputs one environment value.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node scripts/encode-prompt.mjs private-input.txt private-value.txt');
  process.exit(1);
}
writeFileSync(output, 'gzip:' + gzipSync(readFileSync(input)).toString('base64'));
