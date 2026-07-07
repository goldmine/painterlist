import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { get, request } from 'node:https';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const BASE_DIR = resolve(dirname(__filename), '..');
const PAINTERS_FILE = join(BASE_DIR, 'painters.json');
const PAINTINGS_DIR = join(BASE_DIR, 'paintings');
const PAINTINGS_FILE = join(BASE_DIR, 'paintings.json');
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const SPARQL_URL = 'https://query.wikidata.org/sparql';
const UA = 'PainterList/1.0 (https://github.com/goldmine/painterlist)';
const MAX_PAINTINGS_PER_ARTIST = 100;
const QID_BATCH_SIZE = 15;

function sanitizeFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { 'User-Agent': UA } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/sparql-results+json',
      },
    };
    const req = request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function apiCallWithRetry(url, retries = 5) {
  for (let a = 1; a <= retries; a++) {
    const { status, body } = await httpsGet(url);
    if (status === 200) return JSON.parse(body.toString());
    if (status === 429) {
      const wait = Math.min(60, a * 10);
      console.log(`    429 — waiting ${wait}s (${a}/${retries})`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`HTTP ${status}`);
  }
  throw new Error('Exhausted retries');
}

async function sparqlQuery(query, retries = 5) {
  for (let a = 1; a <= retries; a++) {
    const { status, body } = await httpsPost(SPARQL_URL, `query=${encodeURIComponent(query)}`);
    if (status === 200) return JSON.parse(body.toString());
    if (status === 429) {
      const wait = Math.min(60, a * 10);
      console.log(`    SPARQL 429 — waiting ${wait}s (${a}/${retries})`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const snippet = body.toString().slice(0, 200);
    throw new Error(`SPARQL HTTP ${status}: ${snippet}`);
  }
  throw new Error('Exhausted SPARQL retries');
}

function getWikimediaFullResUrl(imageUrl) {
  const parts = imageUrl.split('Special:FilePath/');
  if (parts.length < 2) return null;
  const decoded = decodeURIComponent(parts[1]);
  const canonical = decoded.replace(/ /g, '_');
  const hash = createHash('md5').update(canonical).digest('hex');
  return `https://upload.wikimedia.org/wikipedia/commons/${hash[0]}/${hash.slice(0, 2)}/${canonical}`;
}

function getExtension(url) {
  const p = new URL(url).pathname;
  const e = p.split('.').pop().toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff'].includes('.' + e) ? '.' + e : '.jpg';
}

function downloadImage(url, filepath) {
  return new Promise((resolve) => {
    get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadImage(res.headers.location, filepath).then(resolve);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve(`HTTP ${res.statusCode}`);
        return;
      }
      const ws = createWriteStream(filepath);
      res.pipe(ws);
      ws.on('finish', () => resolve(true));
      ws.on('error', (e) => resolve(`Write: ${e.message}`));
    }).on('error', (e) => resolve(`Req: ${e.message}`));
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { rankStart: 1, rankEnd: 1000 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rank' && i + 1 < args.length) {
      const val = args[++i];
      const m = val.match(/^(\d+)(?:-(\d+))?$/);
      if (m) {
        opts.rankStart = parseInt(m[1], 10);
        opts.rankEnd = m[2] ? parseInt(m[2], 10) : opts.rankStart;
      }
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  console.log(`Rank range: ${opts.rankStart}–${opts.rankEnd}`);

  await mkdir(PAINTINGS_DIR, { recursive: true });

  const raw = await readFile(PAINTERS_FILE, 'utf-8');
  const painters = JSON.parse(raw).filter(
    (p) => p.rank >= opts.rankStart && p.rank <= opts.rankEnd
  );
  console.log(`Processing ${painters.length} painters in rank range`);

  // === Step 1: Resolve QIDs ===
  console.log('=== Step 1: Resolving Wikidata QIDs ===');

  const needsQid = painters.filter((p) => !p.wikidata_qid);
  console.log(`  ${painters.length - needsQid.length} already have QID, ${needsQid.length} to resolve`);

  for (let s = 0; s < needsQid.length; s += 50) {
    const batch = needsQid.slice(s, s + 50);
    const titles = batch.map((p) => p.name);
    const params = new URLSearchParams({
      action: 'query',
      prop: 'pageprops',
      ppprop: 'wikibase_item',
      titles: titles.join('|'),
      redirects: '1',
      format: 'json',
      origin: '*',
    });

    try {
      const data = await apiCallWithRetry(`${WIKIPEDIA_API}?${params}`);

      const redirectMap = {};
      for (const r of data.query?.redirects ?? []) redirectMap[r.from] = r.to;

      const titleQid = {};
      for (const pd of Object.values(data.query?.pages ?? {})) {
        if (pd.pageprops?.wikibase_item) titleQid[pd.title] = pd.pageprops.wikibase_item;
      }

      for (const painter of batch) {
        painter.wikidata_qid = titleQid[painter.name] || titleQid[redirectMap[painter.name]] || null;
      }

      await writeFile(PAINTERS_FILE, JSON.stringify(painters, null, 2));
    } catch (err) {
      console.log(`  Batch QID failed: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  const qidCount = painters.filter((p) => p.wikidata_qid).length;
  console.log(`  ${qidCount}/${painters.length} painters with QID`);

  // === Step 2: SPARQL ===
  console.log('\n=== Step 2: Fetching paintings via SPARQL ===');

  const allPaintings = [];
  const qidToPainter = {};
  for (const p of painters) {
    if (p.wikidata_qid) qidToPainter[p.wikidata_qid] = p;
  }
  const qids = Object.keys(qidToPainter);
  const totalBatches = Math.ceil(qids.length / QID_BATCH_SIZE);

  for (let s = 0; s < qids.length; s += QID_BATCH_SIZE) {
    const batch = qids.slice(s, s + QID_BATCH_SIZE);
    const qidList = batch.map((q) => `wd:${q}`).join(' ');

    const query = `
      SELECT ?painting ?paintingLabel ?image ?inception ?collectionLabel ?materialLabel ?genreLabel WHERE {
        VALUES ?artist { ${qidList} }
        ?painting wdt:P31 wd:Q3305213;
                  wdt:P170 ?artist;
                  wdt:P18 ?image.
        OPTIONAL { ?painting wdt:P571 ?inception. }
        OPTIONAL { ?painting wdt:P195 ?collection. }
        OPTIONAL { ?painting wdt:P186 ?material. }
        OPTIONAL { ?painting wdt:P136 ?genre. }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
    `;

    try {
      const result = await sparqlQuery(query);
      const bindings = result.results?.bindings || [];

      // Group by artist QID then cap per artist
      const byArtist = {};
      for (const b of bindings) {
        const aQid = b.artist?.value?.split('/').pop();
        if (!aQid) continue;
        if (!byArtist[aQid]) byArtist[aQid] = [];
        byArtist[aQid].push({
          painting_url: b.painting?.value || '',
          painting_qid: b.painting?.value?.split('/').pop() || '',
          title: b.paintingLabel?.value || 'Unknown',
          image_url: b.image?.value || '',
          year: b.inception?.value ? parseInt(b.inception.value, 10) : null,
          collection: b.collectionLabel?.value || '',
          material: b.materialLabel?.value || '',
          genre: b.genreLabel?.value || '',
        });
      }

      for (const [aQid, list] of Object.entries(byArtist)) {
        const painter = qidToPainter[aQid];
        if (!painter) continue;
        const capped = list.slice(0, MAX_PAINTINGS_PER_ARTIST);
        for (const painting of capped) {
          allPaintings.push({
            ...painting,
            painter_id: painter.id,
            painter_name: painter.name,
            painter_qid: aQid,
          });
        }
      }

      console.log(`  SPARQL ${s / QID_BATCH_SIZE + 1}/${totalBatches}: ${bindings.length} results`);
    } catch (err) {
      console.log(`  SPARQL batch ${s / QID_BATCH_SIZE + 1}/${totalBatches} failed: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`  Total: ${allPaintings.length} paintings`);

  // === Step 3: Download images ===
  console.log('\n=== Step 3: Downloading images ===');

  let dlCount = 0;
  let skCount = 0;
  let flCount = 0;

  for (let i = 0; i < allPaintings.length; i++) {
    const p = allPaintings[i];

    if (!p.image_url) {
      flCount++;
      continue;
    }

    const fullUrl = getWikimediaFullResUrl(p.image_url);
    if (!fullUrl) {
      flCount++;
      continue;
    }

    const ext = getExtension(fullUrl);
    const safeName = sanitizeFilename(p.painter_name);
    const safeTitle = sanitizeFilename(p.title);
    const filename = `${String(p.painter_id).padStart(4, '0')}_${safeName}_${String(i).padStart(5, '0')}_${safeTitle}${ext}`;
    const filepath = join(PAINTINGS_DIR, filename);

    if (existsSync(filepath)) {
      p.local_path = filepath;
      skCount++;
      continue;
    }

    let result;
    for (let a = 1; a <= 3; a++) {
      result = await downloadImage(fullUrl, filepath);
      if (result === true) break;
      if (a < 3) {
        console.log(`    Retry ${filename} — attempt ${a + 1}/3 (${result})`);
        await new Promise((r) => setTimeout(r, 2000 * a));
      }
    }

    if (result === true) {
      p.local_path = filepath;
      dlCount++;
      if (dlCount % 20 === 0) console.log(`  Downloaded: ${dlCount}/${allPaintings.length}`);
    } else {
      flCount++;
      console.log(`  FAILED: ${filename} (${result})`);
    }

    if ((dlCount + skCount + flCount) % 100 === 0) {
      await writeFile(PAINTINGS_FILE, JSON.stringify(allPaintings, null, 2));
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  // === Save ===
  console.log('\n=== Saving ===');
  await writeFile(PAINTINGS_FILE, JSON.stringify(allPaintings, null, 2));

  const total = allPaintings.length;
  const withPic = allPaintings.filter((p) => p.local_path).length;
  console.log(`\nDone. ${total} paintings total, ${dlCount} downloaded, ${skCount} skipped, ${flCount} failed.`);
  console.log(`  ${withPic} have local files in ${PAINTINGS_DIR}/`);
  console.log(`  Metadata saved to ${PAINTINGS_FILE}`);
}

main().catch(console.error);
