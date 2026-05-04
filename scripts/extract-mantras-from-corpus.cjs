#!/usr/bin/env node

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_SCAN_CHUNKS = Number.parseInt(process.env.MAX_MANTRA_SCAN_CHUNKS || '5000', 10);
const OUT_DIR = path.join(__dirname, '..', 'brain-school', 'outputs');
const CANDIDATES_PATH = path.join(OUT_DIR, 'mantra-candidates.json');
const SUMMARY_PATH = path.join(OUT_DIR, 'mantra-candidates-summary.txt');

const INDICATORS = [
  'mantra',
  'heart mantra',
  'dharani',
  'recite',
  'Om',
  'Hom',
  'Hum',
  'Hung',
  'Svaha',
  'Soha',
  '嗡',
  '吽',
  '咒',
  '心咒',
  '陀羅尼',
  '持誦',
  '念誦',
];

const ENDING_TOKENS = /\b(?:hom|hum|hung|hong|svaha|soha|phat)\b/i;
const LABEL_PATTERN = /\b(?:heart\s+mantra|mantra|dharani)\s*[:：-]\s*([^.\n\r。]{2,240})/gi;
const ROMANIZED_OM_PATTERN = /\bOm\b[\sA-Za-z'’-]{2,220}?\b(?:Hom|Hum|Hung|Hong|Svaha|Soha|Phat)\b/gi;
const ROMANIZED_ENDING_PATTERN = /\b[A-Z][A-Za-z'’-]*(?:\s+[A-Za-z'’-]+){1,24}\s+(?:Hom|Hum|Hung|Hong|Svaha|Soha|Phat)\b/g;
const CHINESE_MANTRA_PATTERN = /[「“]?[^「」“”\n\r。]{0,80}嗡[^「」“”\n\r]{0,180}?(?:吽|娑哈|梭哈)[^「」“”\n\r。]{0,40}[」”]?/g;

function normalizeSpaces(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function cleanCandidateText(text = '') {
  return normalizeSpaces(
    String(text || '')
      .replace(/^[「“"'：:\-\s]+/, '')
      .replace(/[」”"'\s]+$/, '')
      .replace(/\s+([,.;:!?])/g, '$1')
  );
}

function stripHtml(text = '') {
  return String(text || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function hasIndicator(text = '') {
  const lower = String(text || '').toLowerCase();
  return INDICATORS.some((indicator) => lower.includes(indicator.toLowerCase()));
}

function looksTooLargeOrBroken(text = '') {
  const clean = cleanCandidateText(text);
  if (clean.length < 3 || clean.length > 240) return true;
  if ((clean.match(/[<>]/g) || []).length > 2) return true;
  if (clean.split(/\s+/).length > 36) return true;
  return false;
}

function getLikelyDeity(row = {}) {
  const title = normalizeSpaces(row.source_title || row.title || '');
  if (!title) return '';

  return title
    .replace(/[-–|].*$/, '')
    .replace(/\b(?:Practice|Mantra|Dharani|Sadhana|Ritual)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSurroundingContext(chunkText = '', rawText = '') {
  const cleanChunk = normalizeSpaces(stripHtml(chunkText));
  const cleanRaw = normalizeSpaces(rawText);
  const idx = cleanRaw ? cleanChunk.toLowerCase().indexOf(cleanRaw.toLowerCase()) : -1;
  if (idx < 0) return cleanChunk.slice(0, 420);

  const start = Math.max(0, idx - 180);
  const end = Math.min(cleanChunk.length, idx + cleanRaw.length + 180);
  return cleanChunk.slice(start, end).trim();
}

function extractChineseText(rawText = '', context = '') {
  const combined = `${rawText} ${context}`;
  const match = combined.match(/[^。；;,.，\n\r]{0,40}(?:嗡|吽|娑哈|梭哈)[^。；;,.，\n\r]{0,120}/);
  return match ? cleanCandidateText(match[0]) : '';
}

function suggestCanonical(rawText = '') {
  const clean = cleanCandidateText(rawText);
  if (!clean) return '';

  if (/[\u3400-\u9fff]/.test(clean) && !/[A-Za-z]/.test(clean)) {
    return '';
  }

  return clean
    .split(/\s+/)
    .map((word) => {
      if (/^om$/i.test(word)) return 'Om';
      if (/^ah$/i.test(word)) return 'Ah';
      if (/^(hom|hum|hung|hong)$/i.test(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      if (/^(svaha|soha|phat)$/i.test(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function scoreCandidate({ rawText = '', context = '', row = {}, source = '' } = {}) {
  const signals = [];
  let score = 0;
  const raw = String(rawText || '');
  const combined = `${raw} ${context}`;

  if (row.source_title && /Buddha|Bodhisattva|Tara|Vajra|Mother|Guru|Padmakumara|Cundi|Amitabha|Medicine|Mahapratisara/i.test(row.source_title)) {
    score += 0.2;
    signals.push('source_title_deity');
  }

  if (/\b(?:heart\s+mantra|mantra|dharani)\b|心咒|陀羅尼|咒/i.test(context)) {
    score += 0.25;
    signals.push('near_mantra_label');
  }

  if (/^\s*Om\b/i.test(raw) || /^\s*嗡/.test(raw)) {
    score += 0.2;
    signals.push('starts_with_om');
  }

  if (ENDING_TOKENS.test(raw) || /(?:吽|娑哈|梭哈)/.test(raw)) {
    score += 0.2;
    signals.push('mantra_ending');
  }

  if (/\b(?:recite|chant|repeat|times)\b|持誦|念誦|遍/.test(combined)) {
    score += 0.1;
    signals.push('recitation_context');
  }

  if (source) {
    score += 0.05;
    signals.push(source);
  }

  return {
    confidence: Math.min(1, Number(score.toFixed(2))),
    signals,
  };
}

function addCandidate(candidates, seen, row, rawText, source) {
  const clean = cleanCandidateText(rawText);
  if (looksTooLargeOrBroken(clean)) return;

  const context = getSurroundingContext(row.chunk_text, clean);
  const key = `${row.source_url || ''}|${clean.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);

  const scored = scoreCandidate({ rawText: clean, context, row, source });

  candidates.push({
    sourceTitle: normalizeSpaces(row.source_title || row.title || 'Untitled source'),
    sourceUrl: row.source_url || row.url || '',
    sourceKey: row.metadata?.source_key || row.source_key || '',
    likelyDeity: getLikelyDeity(row),
    rawMantraText: clean,
    chineseText: extractChineseText(clean, context),
    suggestedCanonical: suggestCanonical(clean),
    surroundingContext: context,
    confidence: scored.confidence,
    signals: scored.signals,
    reviewStatus: 'pending',
  });
}

function extractCandidatesFromRow(row = {}) {
  const chunkText = stripHtml(row.chunk_text || '');
  const candidates = [];
  const seen = new Set();

  if (!hasIndicator(chunkText)) return candidates;

  for (const match of chunkText.matchAll(LABEL_PATTERN)) {
    addCandidate(candidates, seen, row, match[1], 'label_match');
  }

  for (const match of chunkText.matchAll(ROMANIZED_OM_PATTERN)) {
    addCandidate(candidates, seen, row, match[0], 'starts_with_om_pattern');
  }

  for (const match of chunkText.matchAll(ROMANIZED_ENDING_PATTERN)) {
    addCandidate(candidates, seen, row, match[0], 'ending_token_pattern');
  }

  for (const match of chunkText.matchAll(CHINESE_MANTRA_PATTERN)) {
    addCandidate(candidates, seen, row, match[0], 'chinese_mantra_pattern');
  }

  return candidates;
}

function createSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

async function fetchCandidateRows(supabase) {
  const limit = Number.isFinite(MAX_SCAN_CHUNKS) && MAX_SCAN_CHUNKS > 0 ? MAX_SCAN_CHUNKS : 5000;
  const indicatorQuery = [
    'chunk_text.ilike.%mantra%',
    'chunk_text.ilike.%heart mantra%',
    'chunk_text.ilike.%dharani%',
    'chunk_text.ilike.%recite%',
    'chunk_text.ilike.%Om%',
    'chunk_text.ilike.%Hom%',
    'chunk_text.ilike.%Hum%',
    'chunk_text.ilike.%Hung%',
    'chunk_text.ilike.%Svaha%',
    'chunk_text.ilike.%Soha%',
    'chunk_text.ilike.%嗡%',
    'chunk_text.ilike.%吽%',
    'chunk_text.ilike.%咒%',
    'chunk_text.ilike.%心咒%',
    'chunk_text.ilike.%陀羅尼%',
    'chunk_text.ilike.%持誦%',
    'chunk_text.ilike.%念誦%',
  ].join(',');

  const { data, error } = await supabase
    .from('tbs_knowledge_chunks')
    .select('chunk_key, chunk_text, source_title, source_url, category, metadata, source_id, tbs_sources(source_key, title, url)')
    .or(indicatorQuery)
    .limit(limit);

  if (error) {
    throw new Error(`Failed to fetch corpus chunks: ${error.message}`);
  }

  return (data || []).map((row) => ({
    ...row,
    source_title: row.source_title || row.tbs_sources?.title || '',
    source_url: row.source_url || row.tbs_sources?.url || '',
    source_key: row.metadata?.source_key || row.tbs_sources?.source_key || '',
  }));
}

function writeOutputs(candidates = []) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(candidates, null, 2), 'utf8');

  const bySource = new Map();
  for (const candidate of candidates) {
    const key = candidate.sourceTitle || 'Unknown source';
    bySource.set(key, (bySource.get(key) || 0) + 1);
  }

  const lines = [
    'Mantra Candidate Extraction Summary',
    `Generated: ${new Date().toISOString()}`,
    `Candidates: ${candidates.length}`,
    '',
    'Top sources:',
    ...[...bySource.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([source, count]) => `- ${source}: ${count}`),
    '',
    'Highest confidence candidates:',
    ...candidates
      .slice(0, 25)
      .map((candidate) => `- ${candidate.confidence.toFixed(2)} ${candidate.sourceTitle}: ${candidate.rawMantraText}`),
  ];

  fs.writeFileSync(SUMMARY_PATH, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const supabase = createSupabaseClient();
  const rows = await fetchCandidateRows(supabase);
  const candidates = rows
    .flatMap(extractCandidatesFromRow)
    .sort((a, b) => b.confidence - a.confidence || a.sourceTitle.localeCompare(b.sourceTitle));

  writeOutputs(candidates);

  console.log(`[MantraExtract] scanned chunks=${rows.length}`);
  console.log(`[MantraExtract] candidates=${candidates.length}`);
  console.log(`[MantraExtract] wrote ${path.relative(process.cwd(), CANDIDATES_PATH)}`);
  console.log(`[MantraExtract] wrote ${path.relative(process.cwd(), SUMMARY_PATH)}`);
}

main().catch((err) => {
  console.error('[MantraExtract] failed:', err.message);
  process.exitCode = 1;
});
