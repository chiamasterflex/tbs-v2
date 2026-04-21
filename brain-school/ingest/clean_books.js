import fs from 'fs';
import path from 'path';

const OUT_DIR = path.resolve('../outputs');

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&#8211;/g, '—')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8230;/g, '...')
    .replace(/&#8242;/g, "'")
    .replace(/&#8243;/g, '"')
    .replace(/&#x2013;/gi, '—')
    .replace(/&#x2014;/gi, '—')
    .replace(/&#x2018;/gi, "'")
    .replace(/&#x2019;/gi, "'")
    .replace(/&#x201c;/gi, '"')
    .replace(/&#x201d;/gi, '"')
    .replace(/&#x2026;/gi, '...')
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2f;/gi, '/')
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    });
}

function extractArticleHtml(html) {
  const articleMatch = html.match(/<article\b[\s\S]*?<\/article>/i);
  if (articleMatch) return articleMatch[0];

  const mainMatch = html.match(/<main\b[\s\S]*?<\/main>/i);
  if (mainMatch) return mainMatch[0];

  return html;
}

function cleanHtmlToText(html) {
  const articleHtml = extractArticleHtml(html);

  return decodeEntities(
    articleHtml
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}

function trimBeforeTitle(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const idx = lines.findIndex((line) => /^Book\s+\d+\s+/i.test(line));
  if (idx === -1) return lines.join('\n').trim();

  return lines.slice(idx).join('\n').trim();
}

function trimAfterMarkers(text) {
  const markers = [
    /^Share this:?$/im,
    /^Like Loading/im,
    /^May \d{1,2}, \d{4}$/im,
    /^lotusqz$/im,
    /^Create a free website or blog/im,
    /^TBSN Migration Library$/im,
    /^Subscribe$/im,
    /^Reblog$/im,
    /^Copy shortlink$/im,
    /^Report this content$/im,
    /^View post in Reader$/im,
    /^Manage subscriptions$/im,
    /^Design a site like this with/im,
  ];

  let cutAt = text.length;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && typeof match.index === 'number') {
      cutAt = Math.min(cutAt, match.index);
    }
  }

  return text.slice(0, cutAt).trim();
}

function removeNoiseLines(text) {
  const noisePatterns = [
    /^-+$/,
    /^TBSN Migration Library$/i,
    /^Skip to content$/i,
    /^About$/i,
    /^Contacts$/i,
    /^GM Books$/i,
    /^Facebook$/i,
    /^X$/i,
    /^Sign me up$/i,
    /^Sign up$/i,
    /^Log in$/i,
    /^Already have a\s+account\?/i,
    /^Privacy$/i,
    /^Subscribed$/i,
    /^Share on /i,
    /^True Buddha School$/i,
    /^GM's Books$/i,
    /^%d$/,
    /^Get started$/i,
  ];

  const lines = text.split('\n').map((line) => line.trim());
  const kept = [];
  let lastWasBlank = false;

  for (const line of lines) {
    if (!line) {
      if (!lastWasBlank) kept.push('');
      lastWasBlank = true;
      continue;
    }

    if (noisePatterns.some((re) => re.test(line))) {
      continue;
    }

    kept.push(line);
    lastWasBlank = false;
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeText(text) {
  return text
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/`/g, "'")
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+—\s+-/g, ' — ')
    .replace(/-{2,}/g, '—')
    .replace(/\b([IVX]+\.)\s+/g, '\n\n$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function splitParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n+/g, ' ').trim())
    .filter(Boolean)
    .flatMap((p) => {
      const parts = p
        .replace(/\s+(I\.\s+)/g, '\n\n$1')
        .replace(/\s+(II\.\s+)/g, '\n\n$1')
        .replace(/\s+(III\.\s+)/g, '\n\n$1')
        .replace(/\s+(IV\.\s+)/g, '\n\n$1')
        .split(/\n\n/)
        .map((x) => x.trim())
        .filter(Boolean);

      return parts;
    })
    .filter((p) => p.length > 40);
}

function chunkParagraphs(paragraphs, maxChars = 1800) {
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if (!current) {
      current = para;
      continue;
    }

    if ((current + '\n\n' + para).length <= maxChars) {
      current += '\n\n' + para;
    } else {
      chunks.push(current);
      current = para;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function extractDisplayTitle(rawTitle, text) {
  const firstLine =
    text.split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';

  const chapterMatch = firstLine.match(
    /^Book\s+\d+\s+(Preface|Chapter\s+\d+[:\-]\s+.+?)(?:\s+—\s+TBSN Migration Library)?$/i
  );
  if (chapterMatch) return chapterMatch[1].trim();

  if (rawTitle && !/^\d+$/.test(rawTitle.trim())) {
    return rawTitle.replace(/\s+—\s+TBSN Migration Library$/i, '').trim();
  }

  return rawTitle || 'Untitled';
}

function cleanChapter(html, fallbackTitle) {
  let text = cleanHtmlToText(html);
  text = trimBeforeTitle(text);
  text = trimAfterMarkers(text);
  text = removeNoiseLines(text);
  text = normalizeText(text);

  const displayTitle = extractDisplayTitle(fallbackTitle, text);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length && /^Book\s+\d+\s+/i.test(lines[0])) {
    lines.shift();
  }

  const bodyText = lines.join('\n\n');
  const paragraphs = splitParagraphs(bodyText);
  const chunks = chunkParagraphs(paragraphs);

  return {
    title: displayTitle,
    text: paragraphs.join('\n\n'),
    paragraphs,
    chunks,
  };
}

function main() {
  const rawPath = path.join(OUT_DIR, 'book045_raw.json');
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

  const cleaned = raw.map((chapter, idx) => {
    if (chapter.error || !chapter.html) {
      return {
        chapterNumber: idx + 1,
        title: chapter.title,
        url: chapter.url,
        error: chapter.error || 'No HTML',
        text: '',
        chunks: [],
      };
    }

    const cleanedChapter = cleanChapter(chapter.html, chapter.title);

    return {
      chapterNumber: idx + 1,
      title: cleanedChapter.title,
      url: chapter.url,
      text: cleanedChapter.text,
      paragraphs: cleanedChapter.paragraphs,
      chunks: cleanedChapter.chunks.map((chunk, i) => ({
        chunkId: `book045-ch${idx + 1}-chunk${i + 1}`,
        text: chunk,
      })),
    };
  });

  fs.writeFileSync(
    path.join(OUT_DIR, 'book045_clean.json'),
    JSON.stringify(cleaned, null, 2)
  );

  console.log('Done: outputs/book045_clean.json');
}

main();