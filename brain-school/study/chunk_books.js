import fs from 'fs';
import path from 'path';

const IN_DIR = path.resolve('../outputs');
const OUT_DIR = path.resolve('../outputs');

const INPUT_FILE = path.join(IN_DIR, 'book045_clean.json');
const OUTPUT_FILE = path.join(OUT_DIR, 'book045_chunked.json');

const DEFAULTS = {
  targetChars: 900,
  maxChars: 1400,
  minChars: 280,
  overlapParas: 0,
};

function normalizeSpace(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sentenceCount(text) {
  const matches = normalizeSpace(text).match(/[.!?]+(?:["')\]]+)?/g);
  return matches ? matches.length : 0;
}

function looksLikeHeading(text) {
  const t = normalizeSpace(text);

  if (!t) return false;
  if (/^(preface|introduction|conclusion)$/i.test(t)) return true;
  if(/^(chapter\s+\d+[:\-]\s+)/i.test(t)) return true;
  if (/^[IVX]+\.\s+/.test(t)) return true;
  if (/^[A-Z][A-Za-z0-9 ,'"()\-]{1,90}$/.test(t) && sentenceCount(t) <= 1) return true;

  return false;
}

function looksLikeBoundaryLead(text) {
  const t = normalizeSpace(text);

  return (
    /^(therefore|however|thus|hence|in this case|for this reason|on the other hand|now|next|finally|in conclusion)\b/i.test(t) ||
    /^[IVX]+\.\s+/.test(t) ||
    /^the\s+(first|second|third|fourth)\b/i.test(t)
  );
}

function paragraphWeight(text) {
  const t = normalizeSpace(text);
  if (!t) return 0;

  let score = 0;
  score += Math.min(t.length / 120, 12);
  score += sentenceCount(t) * 0.8;
  if (looksLikeHeading(t)) score += 3;
  if (looksLikeBoundaryLead(t)) score += 2;
  return score;
}

function splitLongParagraph(paragraph, chapterNumber, chunkIndexSeed) {
  const text = normalizeSpace(paragraph);
  if (text.length <= DEFAULTS.maxChars) {
    return [text];
  }

  const sentences = text
    .split(/(?<=[.!?]["')\]]?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    return [text];
  }

  const parts = [];
  let current = '';

  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
      continue;
    }

    if ((current + ' ' + sentence).length <= DEFAULTS.targetChars) {
      current += ' ' + sentence;
    } else {
      parts.push(current.trim());
      current = sentence;
    }
  }

  if (current) parts.push(current.trim());
  return parts;
}

function buildChunks(paragraphs, chapterNumber) {
  const cleanedParas = paragraphs
    .map((p) => normalizeSpace(p))
    .filter(Boolean);

  const expandedParas = cleanedParas.flatMap((p, idx) =>
    splitLongParagraph(p, chapterNumber, idx + 1)
  );

  const chunks = [];
  let currentParas = [];
  let currentLength = 0;
  let currentScore = 0;

  const flush = () => {
    if (!currentParas.length) return;

    const text = currentParas.join('\n\n').trim();
    chunks.push({
      text,
      charCount: text.length,
      paragraphCount: currentParas.length,
      score: Number(currentScore.toFixed(2)),
    });

    currentParas = [];
    currentLength = 0;
    currentScore = 0;
  };

  for (let i = 0; i < expandedParas.length; i++) {
    const para = expandedParas[i];
    const paraLen = para.length;
    const paraScore = paragraphWeight(para);

    const wouldExceedMax =
      currentParas.length > 0 && currentLength + 2 + paraLen > DEFAULTS.maxChars;

    const goodToFlush =
      currentParas.length > 0 &&
      currentLength >= DEFAULTS.targetChars &&
      (looksLikeHeading(para) || looksLikeBoundaryLead(para));

    if (wouldExceedMax || goodToFlush) {
      flush();
    }

    currentParas.push(para);
    currentLength = currentParas.join('\n\n').length;
    currentScore += paraScore;

    const nextPara = expandedParas[i + 1] || '';
    const nextLooksBoundary = looksLikeHeading(nextPara) || looksLikeBoundaryLead(nextPara);

    if (
      currentLength >= DEFAULTS.targetChars &&
      (nextLooksBoundary || currentLength >= DEFAULTS.maxChars)
    ) {
      flush();
    }
  }

  flush();

  // Merge tiny tail chunks if needed
  const merged = [];
  for (const chunk of chunks) {
    if (
      merged.length > 0 &&
      chunk.charCount < DEFAULTS.minChars
    ) {
      const prev = merged.pop();
      const mergedText = `${prev.text}\n\n${chunk.text}`.trim();

      merged.push({
        text: mergedText,
        charCount: mergedText.length,
        paragraphCount: prev.paragraphCount + chunk.paragraphCount,
        score: Number((prev.score + chunk.score).toFixed(2)),
      });
    } else {
      merged.push(chunk);
    }
  }

  return merged.map((chunk, idx) => ({
    chunkId: `book045-ch${chapterNumber}-chunk${idx + 1}`,
    text: chunk.text,
    charCount: chunk.charCount,
    paragraphCount: chunk.paragraphCount,
    score: chunk.score,
  }));
}

function main() {
  const raw = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));

  const chunked = raw.map((chapter) => {
    const chapterNumber = chapter.chapterNumber;
    const paragraphs =
      Array.isArray(chapter.paragraphs) && chapter.paragraphs.length
        ? chapter.paragraphs
        : normalizeSpace(chapter.text).split(/\n\s*\n/).filter(Boolean);

    const chunks = buildChunks(paragraphs, chapterNumber);

    return {
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      url: chapter.url,
      text: chapter.text,
      paragraphs,
      chunks,
      stats: {
        paragraphCount: paragraphs.length,
        chunkCount: chunks.length,
        avgChunkChars:
          chunks.length > 0
            ? Math.round(chunks.reduce((sum, c) => sum + c.charCount, 0) / chunks.length)
            : 0,
      },
    };
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(chunked, null, 2));
  console.log(`Done: ${OUTPUT_FILE}`);
}

main();