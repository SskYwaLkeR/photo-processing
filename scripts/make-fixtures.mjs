// Builds demo + load-test fixtures from one source photo. Usage: pnpm fixtures [fixtures/src/selfie.jpg]
// HEIC files are produced with macOS `sips` (sharp's prebuilt libheif can't encode HEVC).
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const src = process.argv[2] ?? 'fixtures/src/selfie.jpg';
const out = path.resolve('fixtures');
const load = path.join(out, 'load');
await mkdir(load, { recursive: true });

const base = () => sharp(src).rotate();
const heic = (from, to) => {
  try {
    execFileSync('sips', ['-s', 'format', 'heic', from, '--out', to], { stdio: 'ignore' });
  } catch {
    console.log(`skipped ${path.basename(to)} (needs macOS sips)`);
  }
};

// Demo set: one of each path through the pipeline
await base().resize(4032, 3024, { fit: 'cover' }).jpeg({ quality: 92 }).toFile(path.join(out, 'photo-12mp.jpg'));
await base().resize(2000, 1500, { fit: 'cover' }).png().toFile(path.join(out, 'screenshot.png'));
heic(path.join(out, 'photo-12mp.jpg'), path.join(out, 'iphone.heic'));
const jpeg = await readFile(path.join(out, 'photo-12mp.jpg'));
await writeFile(path.join(out, 'corrupt.jpg'), jpeg.subarray(0, Math.floor(jpeg.length * 0.35))); // valid header, truncated body
await writeFile(path.join(out, 'not-an-image.jpg'), 'definitely not a jpeg\n'.repeat(200)); // rejected at validation
await sharp({ create: { width: 12_000, height: 12_000, channels: 3, background: '#88a' } })
  .png({ compressionLevel: 9 })
  .toFile(path.join(out, 'pixel-bomb.png')); // 144 MP in a few hundred KB → TOO_MANY_PIXELS

// Load-test set: modest sizes so home upload bandwidth isn't the bottleneck
const tints = ['#ffffff', '#ffe9d6', '#d6ecff', '#e8ffd6', '#f3d6ff', '#fff6c2'];
for (const [i, tint] of tints.entries()) {
  const w = 1600 + i * 160;
  await base().resize(w, Math.round(w * 0.75), { fit: 'cover' }).tint(tint).jpeg({ quality: 88 }).toFile(path.join(load, `load-${i + 1}.jpg`));
}
await base().resize(1200, 900, { fit: "cover" }).png().toFile(path.join(load, 'load-7.png'));
heic(path.join(load, 'load-1.jpg'), path.join(load, 'load-8.heic'));
console.log('fixtures written to', out);
