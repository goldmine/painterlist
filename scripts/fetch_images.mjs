/**
 * Fetch Wikipedia page images for all painters in painters.json
 * and download them to a local images/ directory.
 *
 * Usage:
 *   node scripts/fetch_images.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { get } from 'node:https';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const BASE_DIR = resolve(dirname(__filename), '..');
const PAINTERS_FILE = join(BASE_DIR, 'painters.json');
const IMAGES_DIR = join(BASE_DIR, 'images');
const BATCH_SIZE = 50;
const API_URL = 'https://en.wikipedia.org/w/api.php';

function sanitizeFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { 'User-Agent': 'PainterList/1.0' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function downloadImage(url, filepath) {
  try {
    const data = await httpsGet(url);
    return new Promise((resolve) => {
      const ws = createWriteStream(filepath);
      ws.write(data);
      ws.end();
      ws.on('finish', () => resolve(true));
      ws.on('error', () => resolve(false));
    });
  } catch {
    return false;
  }
}

function getExtension(url) {
  const pathname = new URL(url).pathname;
  const ext = extname(pathname).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext) ? ext : '.jpg';
}

async function main() {
  await mkdir(IMAGES_DIR, { recursive: true });

  const raw = await readFile(PAINTERS_FILE, 'utf-8');
  const painters = JSON.parse(raw);

  const hasAll = painters.every((p) => p.image_path);
  if (hasAll) {
    console.log('All painters already have image_path. Nothing to do.');
    return;
  }

  const total = painters.length;
  console.log(`Processing ${total} painters...`);

  for (let start = 0; start < total; start += BATCH_SIZE) {
    const batch = painters.slice(start, start + BATCH_SIZE);
    const titles = batch.map((p) => p.name);

    // Step 1: Fetch image URLs from Wikipedia API
    const params = new URLSearchParams({
      action: 'query',
      prop: 'pageimages',
      pithumbsize: '200',
      titles: titles.join('|'),
      redirects: '1',
      format: 'json',
      origin: '*',
    });
    const apiUrl = `${API_URL}?${params}`;

    try {
      const buf = await httpsGet(apiUrl);
      const data = JSON.parse(buf.toString());

      const redirectMap = {};
      for (const r of data.query?.redirects ?? []) {
        redirectMap[r.from] = r.to;
      }

      const titleThumb = {};
      for (const pageData of Object.values(data.query?.pages ?? {})) {
        if (pageData.title && pageData.thumbnail?.source) {
          titleThumb[pageData.title] = pageData.thumbnail.source;
        }
      }

      for (const painter of batch) {
        const url =
          titleThumb[painter.name] ?? titleThumb[redirectMap[painter.name]];
        if (url) painter.image_url = url;
      }
    } catch (err) {
      console.log(`  Batch API call failed: ${err.message}`);
    }

    // Step 2: Download images
    for (const painter of batch) {
      const imgUrl = painter.image_url;
      if (!imgUrl) continue;

      const ext = getExtension(imgUrl);
      const safeName = sanitizeFilename(painter.name);
      const filename = `${String(painter.id).padStart(4, '0')}_${safeName}${ext}`;
      const filepath = join(IMAGES_DIR, filename);

      if (existsSync(filepath)) {
        painter.image_path = filepath;
        continue;
      }

      const ok = await downloadImage(imgUrl, filepath);
      if (ok) {
        painter.image_path = filepath;
        console.log(`    Downloaded: ${filename}`);
      } else {
        delete painter.image_url;
      }
    }

    await new Promise((r) => setTimeout(r, 500));

    const withUrl = painters.filter((p) => p.image_url).length;
    const withFile = painters.filter((p) => p.image_path).length;
    const done = Math.min(start + BATCH_SIZE, total);
    console.log(`  ${done}/${total} — ${withUrl} URLs, ${withFile} files`);
  }

  await writeFile(PAINTERS_FILE, JSON.stringify(painters, null, 2), 'utf-8');

  const withUrl = painters.filter((p) => p.image_url).length;
  const withFile = painters.filter((p) => p.image_path).length;
  console.log(`\nDone. ${withUrl}/${total} painters with image_url, ${withFile} files in ${IMAGES_DIR}/`);
}

main().catch(console.error);
