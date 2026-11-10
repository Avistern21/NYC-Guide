// Nightly updater: fetches each venue's official preview image and any events the
// venue publishes as structured data (schema.org JSON-LD). No API keys needed.
//
//   node scripts/update.mjs
//
// Env overrides (used for testing): VENUES_FILE, DATA_DIR, IMG_DIR
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const IMG = process.env.IMG_DIR || path.join(ROOT, 'img');
const VENUES_FILE = process.env.VENUES_FILE || path.join(DATA, 'venues.json');
const UA = 'Mozilla/5.0 (compatible; OurCultureGuide/1.0; personal non-commercial guide)';
const MAX_EVENTS_PER_VENUE = 8;
const MAX_IMG_BYTES = 8 * 1024 * 1024;

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { console.log('sharp not installed: images will be saved without resizing'); }

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);

fs.mkdirSync(path.join(IMG, 'venues'), { recursive: true });
fs.mkdirSync(path.join(IMG, 'shows'), { recursive: true });
fs.mkdirSync(path.join(IMG, 'manual'), { recursive: true });

const venues = readJson(VENUES_FILE, []);
// Picks (restaurants etc.) also get images: from `image` (direct link), else the og:image of `site` (their own website) or `url`.
// A file at img/manual/p-<slug-of-name>.jpg always wins.
for (const p of readJson(path.join(DATA, 'picks.json'), [])) {
  if (!p.name) continue;
  venues.push({ id: 'p-' + slug(p.name), name: p.name, url: p.site || p.url, imageUrl: /^https:/.test(p.image || '') ? p.image : undefined, picksOnly: true });
}
const curated = readJson(path.join(DATA, 'shows.json'), []);
const images = readJson(path.join(DATA, 'images.json'), { venues: {}, shows: {} });
images.venues ||= {}; images.shows ||= {};
const autoOld = readJson(path.join(DATA, 'shows.auto.json'), {});
const autoNew = {};
const log = { ran: new Date().toISOString(), venueImages: { ok: [], failed: [], manual: [] }, events: {}, showImages: { ok: 0, failed: 0 } };

async function getText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return { html: await r.text(), finalUrl: r.url };
}

function metaContent(html, names) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (key && names.includes(key.toLowerCase())) {
      const c = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
      if (c) return c.replace(/&amp;/g, '&').trim();
    }
  }
  return null;
}

async function saveImage(imgUrl, destNoExt) {
  const r = await fetch(imgUrl, { headers: { 'user-agent': UA, accept: 'image/*' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('image HTTP ' + r.status);
  const type = (r.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('image/')) throw new Error('not an image: ' + type);
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMG_BYTES && !sharp) throw new Error('image too large and sharp unavailable');
  let ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg';
  if (sharp && !type.includes('svg')) {
    buf = await sharp(buf).rotate().resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    ext = 'jpg';
  }
  const dest = destNoExt + '.' + ext;
  fs.writeFileSync(dest, buf);
  return dest;
}

const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const relImg = p => 'img/' + path.relative(IMG, p).split(path.sep).join('/');

// ---- JSON-LD events -------------------------------------------------------
function jsonLdNodes(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1].trim())); } catch { /* ignore bad blocks */ }
  }
  const flat = [];
  const walk = n => { if (!n) return; if (Array.isArray(n)) return n.forEach(walk); if (typeof n !== 'object') return; flat.push(n); if (n['@graph']) walk(n['@graph']); if (n.itemListElement) walk(n.itemListElement); if (n.item) walk(n.item); if (n.subEvent) walk(n.subEvent); };
  out.forEach(walk);
  return flat;
}
const isEvent = n => [].concat(n['@type'] || []).some(t => /Event$/.test(String(t)));
const day = s => { const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
const firstImage = i => !i ? null : typeof i === 'string' ? i : Array.isArray(i) ? firstImage(i[0]) : i.url || i.contentUrl || null;

function extractEvents(html, pageUrl) {
  const seen = new Set(), ev = [];
  for (const n of jsonLdNodes(html).filter(isEvent)) {
    const title = String(n.name || '').replace(/&amp;/g, '&').trim();
    const start = day(n.startDate); const end = day(n.endDate) || start;
    if (!title || !start || end < today) continue;
    const key = slug(title); if (seen.has(key)) continue; seen.add(key);
    let url = null; try { url = n.url ? new URL(n.url, pageUrl).href : null; } catch {}
    let image = null; try { const i = firstImage(n.image); image = i ? new URL(i, pageUrl).href : null; } catch {}
    ev.push({ title, start, end, url, image });
  }
  return ev.sort((a, b) => (a.start < b.start ? -1 : 1)).slice(0, MAX_EVENTS_PER_VENUE);
}

// ---- main -----------------------------------------------------------------
for (const v of venues) {
  console.log('==', v.name);
  // Manual override: drop a file into img/manual/<venue-id>.(jpg|png|webp) and it always wins.
  const manual = fs.readdirSync(path.join(IMG, 'manual')).find(f => f.startsWith(v.id + '.'));
  if (manual) { images.venues[v.id] = { file: 'img/manual/' + manual, source: 'manual' }; log.venueImages.manual.push(v.id); }

  let page = null;
  try { page = await getText(v.eventsUrl || v.url); } catch (e) { console.log('  page failed:', e.message); }

  if (!manual) {
    try {
      if (!page) throw new Error('page unavailable');
      const og = v.imageUrl || metaContent(page.html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
      if (!og) throw new Error('no preview image found on page');
      const imgUrl = new URL(og, page.finalUrl).href;
      const dest = await saveImage(imgUrl, path.join(IMG, 'venues', v.id));
      images.venues[v.id] = { file: relImg(dest), source: imgUrl, fetched: today };
      log.venueImages.ok.push(v.id); console.log('  image ok');
    } catch (e) { log.venueImages.failed.push({ id: v.id, reason: e.message }); console.log('  image failed:', e.message); }
  }

  if (page && !v.picksOnly) {
    const ev = extractEvents(page.html, page.finalUrl);
    log.events[v.id] = ev.length;
    if (ev.length) autoNew[v.id] = ev; else if (autoOld[v.id]) autoNew[v.id] = autoOld[v.id].filter(e => (e.end || e.start) >= today);
  } else if (!v.picksOnly && autoOld[v.id]) autoNew[v.id] = autoOld[v.id].filter(e => (e.end || e.start) >= today);
  await sleep(600);
}

// ---- show-specific images (curated shows with their own url, and auto-found events) ----
const venueById = Object.fromEntries(venues.map(v => [v.id, v]));
const wanted = [];
for (const s of curated) { const v = venueById[s.venue]; if (v && s.url && s.url !== v.url) wanted.push({ id: slug(v.id + '-' + s.title), pageUrl: s.url, imageUrl: s.image }); }
for (const [vid, arr] of Object.entries(autoNew)) for (const s of arr) wanted.push({ id: slug(vid + '-' + s.title), pageUrl: s.url, imageUrl: s.image });
const keep = new Set();
for (const w of wanted) {
  keep.add(w.id);
  if (images.shows[w.id] && fs.existsSync(path.join(ROOT, images.shows[w.id].file))) continue; // already have it
  try {
    let imgUrl = w.imageUrl;
    if (!imgUrl && w.pageUrl) { const p = await getText(w.pageUrl); const og = metaContent(p.html, ['og:image', 'og:image:url', 'twitter:image']); if (og) imgUrl = new URL(og, p.finalUrl).href; await sleep(400); }
    if (!imgUrl) throw new Error('no image');
    const dest = await saveImage(imgUrl, path.join(IMG, 'shows', w.id));
    images.shows[w.id] = { file: relImg(dest), source: imgUrl, fetched: today }; log.showImages.ok++;
  } catch { log.showImages.failed++; }
}
// remove images for shows that no longer exist
for (const id of Object.keys(images.shows)) if (!keep.has(id)) { try { fs.unlinkSync(path.join(ROOT, images.shows[id].file)); } catch {} delete images.shows[id]; }

// ---- articles from RSS/Atom feeds (data/feeds.json): headline, blurb, link, image. Full text stays on the publisher's site. ----
const decode = t => String(t || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#8217;/g, '\u2019').replace(/&#8220;|&#8221;/g, '"').replace(/\s+/g, ' ').trim();
const tagText = (blk, tag) => { const m = blk.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i')); return m ? m[1] : ''; };
const attr = (blk, tag, a) => { const m = blk.match(new RegExp('<' + tag + '\\b[^>]*\\b' + a + '\\s*=\\s*["\']([^"\']+)["\']', 'i')); return m ? m[1].replace(/&amp;/g, '&') : ''; };
function parseFeed(xml, name) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  return blocks.map(b => {
    const title = decode(tagText(b, 'title'));
    let link = decode(tagText(b, 'link')) || attr(b, 'link', 'href');
    if (!/^https?:/i.test(link)) link = attr(b, 'link', 'href');
    const dr = decode(tagText(b, 'pubDate') || tagText(b, 'published') || tagText(b, 'updated') || tagText(b, 'dc:date')); const dd = new Date(dr); const date = isNaN(dd) ? null : dd.toISOString().slice(0, 10);
    let blurb = decode(tagText(b, 'description') || tagText(b, 'summary')); if (blurb.length > 220) blurb = blurb.slice(0, 217).replace(/\s+\S*$/, '') + '\u2026';
    const image = attr(b, 'media:thumbnail', 'url') || attr(b, 'media:content', 'url') || (/image/.test(attr(b, 'enclosure', 'type')) ? attr(b, 'enclosure', 'url') : '') || (tagText(b, 'description').match(/<img[^>]+src=["']([^"']+)/i) || [])[1] || '';
    return { source: name, title, url: link, date, blurb, image: /^https:/.test(image) ? image : '' };
  }).filter(a => a.title && /^https?:/i.test(a.url));
}
const feeds = readJson(path.join(DATA, 'feeds.json'), []);
const artOld = readJson(path.join(DATA, 'articles.json'), {});
const artNew = {};
for (const f of feeds) {
  try {
    const r = await fetch(f.url, { headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const items = parseFeed(await r.text(), f.name).filter(x => !f.match || x.url.includes(f.match)).slice(0, 12);
    if (!items.length) throw new Error('no articles found in feed');
    const have = artNew[f.name] || []; const seenU = new Set(have.map(x => x.url)); artNew[f.name] = have.concat(items.filter(x => !seenU.has(x.url))).sort((x, y) => ((y.date || '') < (x.date || '') ? -1 : 1)).slice(0, 12); console.log('feed ok:', f.name, items.length);
  } catch (e) { console.log('feed failed:', f.name, e.message); if (artOld[f.name] && !artNew[f.name]) artNew[f.name] = artOld[f.name]; log.feedsFailed = (log.feedsFailed || []).concat({ name: f.name, reason: e.message }); }
  await sleep(500);
}
writeJson(path.join(DATA, 'articles.json'), artNew);

writeJson(path.join(DATA, 'images.json'), images);
writeJson(path.join(DATA, 'shows.auto.json'), autoNew);
writeJson(path.join(DATA, 'update-log.json'), log);
console.log(`\nVenue images: ${log.venueImages.ok.length} ok, ${log.venueImages.manual.length} manual, ${log.venueImages.failed.length} failed`);
if (log.venueImages.failed.length) console.log('Failed:', log.venueImages.failed.map(f => f.id).join(', '));
