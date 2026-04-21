import fs from 'fs';
import path from 'path';

const BASE = 'https://lotusqz.wordpress.com';
const INDEX_URL = `${BASE}/en-gm-books/`;

const OUT_DIR = path.resolve('../outputs');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(html) {
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    links.push({
      href: m[2],
      text: stripHtml(m[3]),
    });
  }
  return links;
}

function absolutize(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `${BASE}${url}`;
  return `${BASE}/${url.replace(/^\.?\//, '')}`;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 BrainSchool/1.0',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed ${url}: ${res.status}`);
  }

  return await res.text();
}

function findBookTocLinks(indexHtml) {
  const matches = [];
  const re = /href\s*=\s*(["'])([^"']*book-045-toc[^"']*)\1/gi;
  let m;

  while ((m = re.exec(indexHtml)) !== null) {
    matches.push({
      text: 'TOC',
      href: absolutize(m[2]),
    });
  }

  const dedup = new Map();
  for (const item of matches) {
    dedup.set(item.href, item);
  }

  return [...dedup.values()];
}

function findChapterLinksFromIndex(indexHtml) {
  const matches = [];
  const re = /<a\b[^>]*href\s*=\s*(["'])([^"']*book-045-(?!toc)[^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = re.exec(indexHtml)) !== null) {
    const href = absolutize(m[2]);
    const text = stripHtml(m[3]).trim();

    if (!href.toLowerCase().includes('/book-045-')) continue;
    if (href.toLowerCase().includes('book-045-toc')) continue;
    if ((text || '').toLowerCase().includes('toc')) continue;
    if ((text || '').toLowerCase().includes('publisher')) continue;

    matches.push({ text: text || href.split('/').filter(Boolean).pop(), href });
  }

  const dedup = new Map();
  for (const item of matches) {
    dedup.set(item.href, item);
  }

  return [...dedup.values()];
}

function findChapterLinks(tocHtml) {
  const links = extractLinks(tocHtml);

  const chapterLinks = links
    .map((l) => ({
      text: (l.text || '').trim(),
      href: absolutize(l.href),
    }))
    .filter((l) => {
      const href = l.href.toLowerCase();
      const text = l.text.toLowerCase();

      return (
        href.includes('/book-045-') &&
        !href.includes('book-045-toc') &&
        !text.includes('back') &&
        !text.includes('next') &&
        !text.includes('toc')
      );
    });

  const dedup = new Map();
  for (const link of chapterLinks) {
    dedup.set(link.href, link);
  }

  return [...dedup.values()];
}

async function main() {
  ensureDir(OUT_DIR);

  console.log('Fetching GM Books index...');
  const indexHtml = await fetchHtml(INDEX_URL);
  fs.writeFileSync(path.join(OUT_DIR, 'gm_books_index.raw.html'), indexHtml);

  const tocCandidates = findBookTocLinks(indexHtml);
  console.log('TOC candidates:', tocCandidates.slice(0, 10));

  let chapterLinks = findChapterLinksFromIndex(indexHtml);
  console.log(`Found ${chapterLinks.length} chapter links directly from index`);
  console.log('Sample chapter links:', chapterLinks.slice(0, 5));

  if (!chapterLinks.length) {
    if (!tocCandidates.length) {
      throw new Error('Could not find Book 045 TOC link or chapter links on index page');
    }

    const toc = tocCandidates[0];
    console.log('Found TOC:', toc);

    console.log('Fetching TOC...');
    const tocHtml = await fetchHtml(toc.href);
    fs.writeFileSync(path.join(OUT_DIR, 'book045_toc.raw.html'), tocHtml);

    chapterLinks = findChapterLinks(tocHtml);
    console.log(`Found ${chapterLinks.length} chapter links from TOC page`);
  }

  if (!chapterLinks.length) {
    throw new Error('Could not find any Book 045 chapter links');
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'book045_chapter_links.json'),
    JSON.stringify(chapterLinks, null, 2)
  );

  const chapters = [];
  for (let i = 0; i < chapterLinks.length; i++) {
    const link = chapterLinks[i];
    console.log(`Fetching chapter ${i + 1}/${chapterLinks.length}: ${link.text}`);

    try {
      const html = await fetchHtml(link.href);
      chapters.push({
        title: link.text,
        url: link.href,
        html,
      });
    } catch (err) {
      chapters.push({
        title: link.text,
        url: link.href,
        error: err.message,
        html: '',
      });
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'book045_raw.json'),
    JSON.stringify(chapters, null, 2)
  );

  console.log('Done: outputs/book045_raw.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});