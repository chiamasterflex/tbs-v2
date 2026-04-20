require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { DeepgramClient } = require('@deepgram/sdk');
const fetch = require('cross-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8787;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!DEEPGRAM_API_KEY) {
  console.error('Missing DEEPGRAM_API_KEY in environment variables');
  process.exit(1);
}

const deepgram = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err.message);
    return fallback;
  }
}

function writeJson(filePath, value) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`Failed to write ${filePath}:`, err.message);
    return false;
  }
}

const resourcesDir = path.join(__dirname, 'Resources');

const generatedGlossary = readJson(path.join(resourcesDir, 'glossary.generated.json'), []);
const generatedCorrections = readJson(path.join(resourcesDir, 'corrections.generated.json'), []);
const generatedPhrases = readJson(path.join(resourcesDir, 'phrases.generated.json'), []);

const generatedDeities = readJson(path.join(resourcesDir, 'deities.generated.json'), []);
const generatedPhoneticCorrections = readJson(
  path.join(resourcesDir, 'phonetic_corrections.generated.json'),
  []
);
const generatedTbsTerms = readJson(path.join(resourcesDir, 'tbs_terms.generated.json'), []);
const generatedSacredNames = readJson(path.join(resourcesDir, 'sacred_names.generated.json'), []);
const generatedCeremonyPhrases = readJson(
  path.join(resourcesDir, 'ceremony_phrases.generated.json'),
  []
);

const sacredEntities = readJson(path.join(resourcesDir, 'sacred_entities.json'), []);
const phraseMemory = readJson(path.join(resourcesDir, 'phrase_memory.json'), []);
const ceremonyMemory = readJson(path.join(resourcesDir, 'ceremony_memory.json'), []);
const glossaryIdEn = readJson(path.join(resourcesDir, 'glossary.id_en.json'), {});
const phraseMemoryId = readJson(path.join(resourcesDir, 'phrase_memory.id.json'), []);
const correctionMemoryId = readJson(path.join(resourcesDir, 'correction_memory.id.json'), []);
const hotwordsId = readJson(path.join(resourcesDir, 'hotwords.id.generated.json'), []);

const asrMishearLogPath = path.join(resourcesDir, 'asr_mishear_log.json');
let asrMishearLog = readJson(asrMishearLogPath, []);

const correctionMemoryPath = path.join(resourcesDir, 'correction_memory.json');
let correctionMemory = readJson(correctionMemoryPath, []);

const retrievalConfig = readJson(path.join(resourcesDir, 'retrieval_config.json'), {
  top_sacred_entities: 8,
  top_phrase_matches: 6,
  top_ceremony_matches: 4,
  top_correction_matches: 5,
  min_phrase_score: 2,
  min_entity_score: 2,
  min_correction_score: 2,
  interim_min_chars: 6,
  context_window_lines: 5,
});

console.log(
  `[Resources] glossary=${generatedGlossary.length} corrections=${generatedCorrections.length} phrases=${generatedPhrases.length} deities=${generatedDeities.length} phonetic=${generatedPhoneticCorrections.length} tbsTerms=${generatedTbsTerms.length} sacredNames=${generatedSacredNames.length} ceremonyPhrases=${generatedCeremonyPhrases.length} sacredEntities=${sacredEntities.length} phraseMemory=${phraseMemory.length} ceremonyMemory=${ceremonyMemory.length} correctionMemory=${correctionMemory.length} idGlossary=${Object.keys(glossaryIdEn).length} idPhraseMemory=${phraseMemoryId.length} idCorrectionMemory=${correctionMemoryId.length} idHotwords=${hotwordsId.length}`
);


let sessions = [];

const ROUTES = {
  zh_en: {
    key: 'zh_en',
    sourceLanguage: 'Mandarin',
    targetLanguage: 'English',
    asrLanguage: 'zh-CN',
  },
  id_en: {
    key: 'id_en',
    sourceLanguage: 'Bahasa Indonesia',
    targetLanguage: 'English',
    asrLanguage: 'id',
    hotwords: hotwordsId,
  },
};

const bahasaGlossary = Object.entries(glossaryIdEn).map(([cn, en]) => ({ cn, en }));

function deriveTranslationRoute(sourceLanguage = 'Mandarin', targetLanguage = 'English') {
  const source = String(sourceLanguage || '').toLowerCase();
  const target = String(targetLanguage || '').toLowerCase();

  if ((source.includes('bahasa') || source.includes('indones')) && target.includes('english')) {
    return 'id_en';
  }

  return 'zh_en';
}

function getRouteConfig(routeKey = 'zh_en') {
  return ROUTES[routeKey] || ROUTES.zh_en;
}


function getOrCreateSession(id = 'live-session') {
  let session = sessions.find((s) => s.id === id);

  if (!session) {
    session = {
      id,
      title: 'TBS Live Session',
      eventMode: 'Dharma Talk',
      sourceLanguage: 'Mandarin',
      targetLanguage: 'English',
      translationRoute: 'zh_en',
      lines: [],
      brainState: {
        activeTopic: null,
        activeTopicEn: null,
        activeTopicType: null,
        activeTopicConfidence: 0,
        lockedUntilLineCount: 0,
        lastTopics: [],
      },
    };
    sessions.unshift(session);
  }

  return session;
}

function ensureSessionBrainState(session) {
  if (!session) return null;

  if (!session.brainState) {
    session.brainState = {
      activeTopic: null,
      activeTopicEn: null,
      activeTopicType: null,
      activeTopicConfidence: 0,
      lockedUntilLineCount: 0,
      lastTopics: [],
    };
  }

  return session.brainState;
}

function getSessionLineCount(session) {
  return Array.isArray(session?.lines) ? session.lines.length : 0;
}

function scoreTopicCandidate(entity = {}, normalizedCn = '', eventMode = 'Dharma Talk') {
  if (!entity?.cn) return 0;

  let score = 0;
  const cn = entity.cn || '';
  const aliases = []
    .concat(entity?.aliases || [])
    .concat(entity?.mishears || [])
    .concat(entity?.variants || [])
    .filter(Boolean);

  if (normalizedCn === cn) score += 100;
  if (normalizedCn.includes(cn)) score += cn.length * 3;
  score += overlapScore(normalizedCn, aliases);
  score += sourceWeightBonus(entity);

  if (Array.isArray(entity?.event_modes) && entity.event_modes.includes(eventMode)) {
    score += 4;
  }

  return score;
}

function updateSessionTopic(session, normalizedCn, retrieval = {}, eventMode = 'Dharma Talk') {
  const brainState = ensureSessionBrainState(session);
  if (!brainState) return null;

  const candidates = [];

  for (const entity of retrieval.sacredEntities || []) {
    const score = scoreTopicCandidate(entity, normalizedCn, eventMode);
    if (score > 0) {
      candidates.push({
        cn: entity.cn,
        en: entity.en,
        type: entity.category || 'entity',
        confidence: score,
      });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0] || null;

  const lineCount = getSessionLineCount(session);
  const lockActive = brainState.lockedUntilLineCount > lineCount;

  if (best && best.confidence >= 8) {
    brainState.activeTopic = best.cn;
    brainState.activeTopicEn = best.en;
    brainState.activeTopicType = best.type;
    brainState.activeTopicConfidence = best.confidence;
    brainState.lockedUntilLineCount = lineCount + 5;
    brainState.lastTopics.unshift({
      cn: best.cn,
      en: best.en,
      type: best.type,
      confidence: best.confidence,
      at: new Date().toISOString(),
    });
    brainState.lastTopics = brainState.lastTopics.slice(0, 10);
    return brainState;
  }

  if (lockActive && brainState.activeTopic) {
    return brainState;
  }

  if (!lockActive) {
    brainState.activeTopic = null;
    brainState.activeTopicEn = null;
    brainState.activeTopicType = null;
    brainState.activeTopicConfidence = 0;
  }

  return brainState;
}

function getActiveTopicContext(brainState) {
  if (!brainState?.activeTopic) return null;

  return {
    cn: brainState.activeTopic,
    en: brainState.activeTopicEn || '',
    type: brainState.activeTopicType || 'entity',
    confidence: brainState.activeTopicConfidence || 0,
    lockedUntilLineCount: brainState.lockedUntilLineCount || 0,
  };
}

getOrCreateSession('live-session');

function normalizeSpaces(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function containsChinese(text) {
  return /[\u3400-\u9fff]/.test(text || '');
}

function containsEnglish(text) {
  return /[A-Za-z]/.test(text || '');
}

function classifyInputMode(text) {
  const hasCn = containsChinese(text);
  const hasEn = containsEnglish(text);

  if (hasCn && hasEn) return 'mixed';
  if (hasCn) return 'chinese';
  if (hasEn) return 'english';
  return 'unknown';
}


function classifyInputModeForRoute(text, routeKey = 'zh_en') {
  if (routeKey === 'id_en') {
    const normalized = normalizeSpaces(text);
    if (!normalized) return 'unknown';
    return 'indonesian';
  }

  return classifyInputMode(text);
}

function segmentMixedText(text = '') {
  const src = text || '';
  if (!src.trim()) return [];

  const segments = [];
  let current = '';
  let currentType = null;

  function detectCharType(ch) {
    if (/[\u3400-\u9fff]/.test(ch)) return 'chinese';
    if (/[A-Za-z]/.test(ch)) return 'english';
    if (/\s/.test(ch)) return 'space';
    return 'other';
  }

  function flush() {
    if (!current) return;
    const raw = current;
    const trimmed = raw.trim();
    if (!trimmed) {
      segments.push({ type: 'space', text: raw });
    } else {
      const mode = classifyInputMode(trimmed);
      segments.push({
        type: mode === 'unknown' ? currentType || 'other' : mode,
        text: raw,
      });
    }
    current = '';
    currentType = null;
  }

  for (const ch of src) {
    const charType = detectCharType(ch);

    if (charType === 'space') {
      current += ch;
      continue;
    }

    if (!current) {
      current = ch;
      currentType = charType;
      continue;
    }

    if (charType === currentType || charType === 'other' || currentType === 'other') {
      current += ch;
      if (currentType === 'other' && charType !== 'other') currentType = charType;
      continue;
    }

    flush();
    current = ch;
    currentType = charType;
  }

  flush();
  return segments;
}

function normalizeSegmentSpacing(segments = []) {
  const out = [];

  for (const seg of segments) {
    if (!seg || typeof seg.text !== 'string') continue;
    if (seg.type === 'space') {
      out.push(seg);
      continue;
    }

    const previous = out[out.length - 1];
    if (
      previous &&
      previous.type !== 'space' &&
      seg.type !== 'space' &&
      previous.type === 'english' &&
      seg.type === 'english'
    ) {
      out.push({ type: 'space', text: ' ' });
    }

    out.push(seg);
  }

  return out;
}

async function translateMixedSegments({
  text,
  hits,
  mode,
  retrieval,
  eventMode,
  contextWindow,
  activeTopic = null,
  routeKey = 'zh_en',
}) {
  const rawSegments = normalizeSegmentSpacing(segmentMixedText(text));
  if (!rawSegments.length) return text;

  const translatedSegments = [];

  for (const seg of rawSegments) {
    const rawText = seg.text || '';
    const trimmed = rawText.trim();

    if (!trimmed) {
      translatedSegments.push(rawText);
      continue;
    }

    if (seg.type === 'english') {
      translatedSegments.push(rawText);
      continue;
    }

    if (seg.type !== 'chinese') {
      translatedSegments.push(rawText);
      continue;
    }

    const segmentHits = applyGlossary(trimmed);
    const segmentRetrieval = {
      sacredEntities: retrieveSacredEntities(trimmed, eventMode),
      phraseMatches: retrievePhraseMemory(trimmed, eventMode),
      ceremonyMatches: retrieveCeremonyMemory(trimmed, eventMode),
      correctionMatches: retrieveCorrectionMemory(trimmed, eventMode),
    };

    const translated = await translateWithDeepSeek(
      trimmed,
      segmentHits.length ? segmentHits : hits,
      mode,
      {
        sacredEntities: segmentRetrieval.sacredEntities.length
          ? segmentRetrieval.sacredEntities
          : retrieval.sacredEntities || [],
        phraseMatches: segmentRetrieval.phraseMatches.length
          ? segmentRetrieval.phraseMatches
          : retrieval.phraseMatches || [],
        ceremonyMatches: segmentRetrieval.ceremonyMatches.length
          ? segmentRetrieval.ceremonyMatches
          : retrieval.ceremonyMatches || [],
        correctionMatches: segmentRetrieval.correctionMatches.length
          ? segmentRetrieval.correctionMatches
          : retrieval.correctionMatches || [],
      },
      eventMode,
      contextWindow,
      'chinese',
      activeTopic
    );

    translatedSegments.push(translated || trimmed);
  }

  return normalizeSpaces(
    translatedSegments
      .join('')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
  );
}

const PROTECTED_ENGLISH_TERMS = [
  'karma',
  'blessing',
  'empowerment',
  'dedicate the merit',
  'dedication',
  'lineage',
  'Guru Rinpoche',
  'Padmasambhava',
  'Vajrasattva',
  'homa',
  'refuge',
  'offering',
  'mantra',
  'mudra',
  'dharani',
  'Root Guru',
  'Living Buddha Lian Sheng',
  'True Buddha School',
  'Golden Mother',
  'Drashi Lhamo',
  'Mahamayuri',
  'Dharma protector',
  'Dharma protectors',
  'begin the homa',
];

function protectKnownEnglishTerms(text) {
  let out = text || '';
  const replacements = [];
  const sorted = [...PROTECTED_ENGLISH_TERMS].sort((a, b) => b.length - a.length);

  sorted.forEach((term, idx) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');

    if (re.test(out)) {
      const token = `__ENG_${idx}__`;
      out = out.replace(re, token);
      replacements.push({ token, value: term });
    }
  });

  return { text: out, replacements };
}

function restoreKnownEnglishTerms(text, replacements = []) {
  let out = text || '';
  for (const row of replacements) {
    out = out.replaceAll(row.token, row.value);
  }
  return out;
}

function normalizeChineseText(text) {
  if (!text) return '';
  let out = normalizeSpaces(text);

  for (const rule of generatedCorrections) {
    if (rule?.wrong && rule?.correct && out.includes(rule.wrong)) {
      out = out.replaceAll(rule.wrong, rule.correct);
    }
  }

  return out;
}


function normalizeIndonesianText(text) {
  if (!text) return '';
  let out = normalizeSpaces(text);

  const replacements = [
    [/\bnggak\b/gi, 'tidak'],
    [/\bgak\b/gi, 'tidak'],
    [/\bga\b/gi, 'tidak'],
    [/\baja\b/gi, 'saja'],
    [/\bguru akar\b/gi, 'guru akar'],
    [/\bbuddha hidup lian sheng\b/gi, 'Buddha Hidup Lian Sheng'],
    [/\blian sheng\b/gi, 'Lian Sheng'],
  ];

  for (const [pattern, value] of replacements) {
    out = out.replace(pattern, value);
  }

  return normalizeSpaces(out);
}

function applyPhoneticBrain(text) {
  if (!text) return '';
  let out = normalizeSpaces(text);

  for (const rule of generatedPhoneticCorrections) {
    const wrongs = Array.isArray(rule?.wrong) ? rule.wrong : rule?.wrong ? [rule.wrong] : [];
    const correct = rule?.correct || '';
    if (!correct) continue;

    for (const wrong of wrongs) {
      if (wrong && out.includes(wrong)) {
        out = out.replaceAll(wrong, correct);
      }
    }
  }

  return out;
}

function applyAliasSet(text, canonical, aliases = []) {
  let out = text;
  for (const alias of aliases.filter(Boolean)) {
    if (alias && out.includes(alias) && !out.includes(canonical)) {
      out = out.replaceAll(alias, canonical);
    }
  }
  return out;
}

function applySacredNameBrain(text) {
  if (!text) return '';
  let out = text;

  for (const deity of generatedDeities) {
    const canonicalCn = deity?.cn || '';
    if (!canonicalCn) continue;

    const aliases = []
      .concat(deity?.aliases || [])
      .concat(deity?.mishears || [])
      .filter(Boolean);

    out = applyAliasSet(out, canonicalCn, aliases);
  }

  for (const entry of generatedSacredNames) {
    const canonicalCn = entry?.cn || '';
    if (!canonicalCn) continue;

    const aliases = []
      .concat(entry?.aliases || [])
      .concat(entry?.mishears || [])
      .concat(entry?.variants || [])
      .filter(Boolean);

    out = applyAliasSet(out, canonicalCn, aliases);
  }

  for (const term of generatedTbsTerms) {
    const canonicalCn = term?.cn || '';
    if (!canonicalCn) continue;

    const aliases = []
      .concat(term?.aliases || [])
      .concat(term?.mishears || [])
      .filter(Boolean);

    out = applyAliasSet(out, canonicalCn, aliases);
  }

  for (const entity of sacredEntities) {
    const canonicalCn = entity?.cn || '';
    if (!canonicalCn) continue;

    const aliases = []
      .concat(entity?.aliases || [])
      .concat(entity?.mishears || [])
      .concat(entity?.variants || [])
      .filter(Boolean);

    out = applyAliasSet(out, canonicalCn, aliases);
  }

  return normalizeSpaces(out);
}

function applyContextBias(text) {
  if (!text) return '';
  let out = text;

  const biasRules = [
    {
      canonical: '吉祥天母',
      triggers: ['炸雞', '炸鸡', '炸西', '札西', '扎西', '拉姆', '天母'],
      minTriggerCount: 2,
    },
    {
      canonical: '大白蓮花童子',
      triggers: ['蓮花童子', '白蓮花童子', '莲花童子', '白莲花童子'],
      minTriggerCount: 1,
    },
    {
      canonical: '咕嚕咕咧佛母',
      triggers: ['咕嚕咕咧', '咕噜咕咧', '佛母'],
      minTriggerCount: 2,
    },
    {
      canonical: '瑪哈嘎拉',
      triggers: ['瑪哈', '玛哈', '嘎拉', '伽拉'],
      minTriggerCount: 2,
    },
    {
      canonical: '大白傘蓋佛母',
      triggers: ['白傘蓋', '白伞盖', '佛母'],
      minTriggerCount: 2,
    },
    {
      canonical: '佛母大孔雀明王',
      triggers: ['孔雀', '明王', '佛母'],
      minTriggerCount: 2,
    },
    {
      canonical: '蓮生活佛',
      triggers: ['蓮生', '活佛', '莲生', '活佛'],
      minTriggerCount: 2,
    },
  ];

  for (const rule of biasRules) {
    const hitCount = rule.triggers.reduce(
      (count, t) => count + (out.includes(t) ? 1 : 0),
      0
    );

    if (hitCount >= rule.minTriggerCount && !out.includes(rule.canonical)) {
      out = `${rule.canonical} ${out}`;
    }
  }

  return normalizeSpaces(out);
}

function sourceWeightBonus(row = {}) {
  let bonus = 0;

  if (row.weight && Number.isFinite(Number(row.weight))) {
    bonus += Number(row.weight);
  }

  const sourceType = String(row.source_type || '').toLowerCase();

  if (sourceType.includes('tbsn')) bonus += 3;
  if (sourceType.includes('official')) bonus += 2;
  if (sourceType.includes('seed')) bonus += 1;

  return bonus;
}

function stringOverlapLoose(a, b) {
  if (!a || !b) return 0;
  const aa = normalizeSpaces(a);
  const bb = normalizeSpaces(b);
  if (!aa || !bb) return 0;

  let score = 0;
  const chunks = aa.length > 12 ? aa.match(/.{1,4}/g) || [aa] : [aa];

  for (const chunk of chunks) {
    if (chunk.length >= 2 && bb.includes(chunk)) {
      score += chunk.length;
    }
  }

  return score;
}

function overlapScore(text, candidates = []) {
  const normalized = normalizeSpaces(text);
  if (!normalized) return 0;

  let score = 0;
  for (const c of candidates.filter(Boolean)) {
    if (normalized.includes(c)) score += Math.max(1, c.length);
  }
  return score;
}

function retrieveCorrectionMemory(text, eventMode = 'Dharma Talk') {
  const normalized = normalizeSpaces(text);
  if (!normalized) return [];

  const results = [];

  for (const row of correctionMemory) {
    const heard = normalizeSpaces(row?.heard || '');
    const intendedChinese = normalizeSpaces(row?.intendedChinese || row?.corrected || '');
    const correctedEnglish = normalizeSpaces(
      row?.correctedEnglish || row?.corrected || ''
    );

    if (!heard && !intendedChinese) continue;

    let score = 0;

    if (heard && normalized === heard) score += 100;
    if (heard && normalized.includes(heard)) score += heard.length * 2;
    if (heard) score += stringOverlapLoose(normalized, heard);

    if (intendedChinese && normalized.includes(intendedChinese)) {
      score += intendedChinese.length * 2;
    }

    if ((row?.eventMode || row?.event_mode) === eventMode) score += 2;
    if (Number.isFinite(Number(row?.weight))) score += Number(row.weight);

    if (score >= (retrievalConfig.min_correction_score || 2)) {
      results.push({
        ...row,
        correctedEnglish,
        _score: score,
      });
    }
  }

  return results
    .sort((a, b) => b._score - a._score)
    .slice(0, retrievalConfig.top_correction_matches || 5);
}

function applyCorrectionMemory(text, eventMode = 'Dharma Talk') {
  let out = normalizeSpaces(text);
  const hits = retrieveCorrectionMemory(out, eventMode);

  for (const hit of hits) {
    const heard = normalizeSpaces(hit?.heard || '');
    const intendedChinese = normalizeSpaces(hit?.intendedChinese || hit?.corrected || '');

    if (heard && intendedChinese && out.includes(heard)) {
      out = out.replaceAll(heard, intendedChinese);
    }
  }

  return { text: out, hits };
}

function runBrainNormalization(text, eventMode = 'Dharma Talk') {
  const protectedEnglish = protectKnownEnglishTerms(text);
  let out = protectedEnglish.text;

  out = normalizeChineseText(out);
  out = applyPhoneticBrain(out);
  out = applySacredNameBrain(out);
  out = applyContextBias(out);

  const correctionApplied = applyCorrectionMemory(out, eventMode);
  out = correctionApplied.text;

  out = restoreKnownEnglishTerms(out, protectedEnglish.replacements);
  out = normalizeSpaces(out);

  return {
    normalizedText: out,
    correctionHits: correctionApplied.hits || [],
    inputMode: classifyInputMode(out),
    protectedEnglish: protectedEnglish.replacements || [],
  };
}

function runRouteNormalization(text, eventMode = 'Dharma Talk', routeKey = 'zh_en') {
  if (routeKey === 'id_en') {
    let normalizedText = normalizeIndonesianText(text);
    const correctionApplied = applyIndonesianCorrections(normalizedText);
    normalizedText = correctionApplied.text;

    return {
      normalizedText,
      correctionHits: correctionApplied.hits || [],
      phraseHints: retrieveIndonesianPhraseMemory(normalizedText),
      inputMode: classifyInputModeForRoute(normalizedText, routeKey),
      protectedEnglish: [],
    };
  }

  return runBrainNormalization(text, eventMode);
}

function buildCanonicalGlossary() {
  const deityEntries = generatedDeities
    .filter((d) => d?.cn && d?.en)
    .map((d) => ({ cn: d.cn, en: d.en }));

  const tbsEntries = generatedTbsTerms
    .filter((t) => t?.cn && t?.en)
    .map((t) => ({ cn: t.cn, en: t.en }));

  const sacredEntries = generatedSacredNames
    .filter((s) => s?.cn && s?.en)
    .map((s) => ({ cn: s.cn, en: s.en }));

  const corpusEntries = sacredEntities
    .filter((s) => s?.cn && s?.en)
    .map((s) => ({ cn: s.cn, en: s.en }));

  const merged = [
    ...generatedGlossary,
    ...deityEntries,
    ...tbsEntries,
    ...sacredEntries,
    ...corpusEntries,
  ];

  const seen = new Set();
  const deduped = [];

  for (const entry of merged) {
    const key = `${entry.cn}|||${entry.en}`;
    if (!entry?.cn || !entry?.en || seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

const canonicalGlossary = buildCanonicalGlossary();

function applyGlossary(text) {
  const hits = [];
  const sorted = [...canonicalGlossary].sort(
    (a, b) => (b.cn?.length || 0) - (a.cn?.length || 0)
  );

  for (const term of sorted) {
    if (term?.cn && text.includes(term.cn)) {
      hits.push(term);
    }
  }

  return hits;
}

function applyRouteGlossary(text, routeKey = 'zh_en') {
  if (routeKey === 'id_en') return applyIndonesianGlossary(text);
  return applyGlossary(text);
}

function applyGlossaryToEnglish(text, hits) {
  let out = text;
  for (const term of hits) {
    if (term?.cn && term?.en) {
      out = out.replaceAll(term.cn, term.en);
    }
  }
  return out;
}

function isShortFragment(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  if (t.length <= 2) return true;
  if (t.length <= 4 && !/[，。！？、,.!?]/.test(t)) return true;
  return false;
}

function isStableEnoughForInterim(text) {
  if (!text) return false;
  const t = text.trim();
  const minChars = retrievalConfig.interim_min_chars || 6;
  if (t.length < minChars) return false;
  if (/[，。！？、,.!?]$/.test(t)) return true;
  if (t.length >= Math.max(12, minChars * 2)) return true;
  return false;
}

function retrieveSacredEntities(text, eventMode = 'Dharma Talk') {
  const results = [];

  for (const entity of sacredEntities) {
    const candidateCn = entity?.cn || '';
    const aliases = []
      .concat(entity?.aliases || [])
      .concat(entity?.mishears || [])
      .concat(entity?.variants || [])
      .filter(Boolean);

    let score = 0;
    score += overlapScore(text, [candidateCn]);
    score += overlapScore(text, aliases);

    if (Array.isArray(entity?.event_modes) && entity.event_modes.includes(eventMode)) {
      score += 2;
    }

    score += sourceWeightBonus(entity);

    if (score >= (retrievalConfig.min_entity_score || 2)) {
      results.push({ ...entity, _score: score });
    }
  }

  return results
    .sort((a, b) => b._score - a._score || (b.cn?.length || 0) - (a.cn?.length || 0))
    .slice(0, retrievalConfig.top_sacred_entities || 8);
}

function retrievePhraseMemory(text, eventMode = 'Dharma Talk') {
  const pools = [...phraseMemory, ...generatedPhrases];
  const results = [];

  for (const row of pools) {
    const candidateCn = row?.cn || '';
    if (!candidateCn) continue;

    let score = 0;
    if (text === candidateCn) score += 100;
    if (text.includes(candidateCn)) score += candidateCn.length * 2;
    if (candidateCn.includes(text) && text.length >= 4) score += text.length;
    score += stringOverlapLoose(text, candidateCn);

    if (row?.event_mode === eventMode || row?.eventMode === eventMode) score += 2;
    score += sourceWeightBonus(row);

    if (score >= (retrievalConfig.min_phrase_score || 2)) {
      results.push({ ...row, _score: score });
    }
  }

  return results
    .sort((a, b) => b._score - a._score || (b.cn?.length || 0) - (a.cn?.length || 0))
    .slice(0, retrievalConfig.top_phrase_matches || 6);
}

function retrieveCeremonyMemory(text, eventMode = 'Dharma Talk') {
  const pools = [...ceremonyMemory, ...generatedCeremonyPhrases];
  const results = [];

  for (const row of pools) {
    const candidateCn = row?.cn || '';
    if (!candidateCn) continue;

    let score = 0;
    if (text === candidateCn) score += 100;
    if (text.includes(candidateCn)) score += candidateCn.length * 2;
    score += stringOverlapLoose(text, candidateCn);

    const mode = row?.event_mode || row?.eventMode || row?.category;
    if (mode && String(mode).toLowerCase().includes(String(eventMode).toLowerCase())) {
      score += 3;
    }

    score += sourceWeightBonus(row);

    if (score >= (retrievalConfig.min_phrase_score || 2)) {
      results.push({ ...row, _score: score });
    }
  }

  return results
    .sort((a, b) => b._score - a._score || (b.cn?.length || 0) - (a.cn?.length || 0))
    .slice(0, retrievalConfig.top_ceremony_matches || 4);
}

function findPhraseMatch(text, mode = 'final') {
  if (!text) return null;

  const normalized = text.trim();
  if (!normalized) return null;
  if (isShortFragment(normalized)) return null;

  const allPhraseSources = [
    ...generatedPhrases,
    ...generatedCeremonyPhrases,
    ...phraseMemory,
    ...ceremonyMemory,
  ];

  for (const phrase of allPhraseSources) {
    if (!phrase?.cn || !phrase?.en) continue;
    const candidate = phrase.cn.trim();
    if (!candidate) continue;

    if (normalized === candidate) {
      return { ...phrase, confidence: 'exact' };
    }
  }

  const minLength = mode === 'interim' ? 14 : 10;
  let best = null;

  for (const phrase of allPhraseSources) {
    if (!phrase?.cn || !phrase?.en) continue;
    const candidate = phrase.cn.trim();
    if (!candidate || candidate.length < minLength) continue;

    if (normalized.includes(candidate)) {
      const score = candidate.length;
      if (!best || score > best.score) {
        best = { ...phrase, score, confidence: 'contains' };
      }
    } else if (mode === 'final' && candidate.includes(normalized)) {
      const ratio = normalized.length / candidate.length;
      if (ratio >= 0.8) {
        const score = normalized.length;
        if (!best || score > best.score) {
          best = { ...phrase, score, confidence: 'near-complete' };
        }
      }
    }
  }

  return best;
}

function computeConfidenceBand(score = 0) {
  if (score >= 80) return 'high';
  if (score >= 55) return 'medium';
  return 'low';
}

function buildTranslationMeta({
  normalizedCn,
  en,
  hits = [],
  retrieval = {},
  inputMode = 'unknown',
  activeTopic = null,
  mode = 'final',
}) {
  const phraseMatch = findPhraseMatch(normalizedCn, mode);
  const correctionCount = (retrieval.correctionMatches || []).length;
  const entityCount = (retrieval.sacredEntities || []).length;
  const phraseCount = (retrieval.phraseMatches || []).length;
  const ceremonyCount = (retrieval.ceremonyMatches || []).length;
  const glossaryCount = hits.length;

  let score = 20;

  if (inputMode === 'english') score = 95;
  if (inputMode === 'mixed') score += 8;
  if (containsChinese(normalizedCn)) score += 8;
  if (glossaryCount > 0) score += Math.min(18, glossaryCount * 4);
  if (entityCount > 0) score += Math.min(20, entityCount * 5);
  if (phraseCount > 0) score += Math.min(20, phraseCount * 5);
  if (ceremonyCount > 0) score += Math.min(12, ceremonyCount * 4);
  if (correctionCount > 0) score += Math.min(16, correctionCount * 4);
  if (phraseMatch?.en) score += 18;
  if (activeTopic?.cn) score += Math.min(12, 4 + Math.floor((activeTopic.confidence || 0) / 6));
  if (looksAbsurdOutput(en)) score -= 45;
  if (!en || !en.trim()) score -= 25;
  if (en && normalizedCn && normalizeSpaces(en) === normalizeSpaces(normalizedCn)) score -= 18;

  score = Math.max(0, Math.min(100, score));
  const band = computeConfidenceBand(score);

  return {
    score,
    band,
    phraseMatched: Boolean(phraseMatch?.en),
    activeTopic: activeTopic?.cn || null,
    activeTopicEn: activeTopic?.en || null,
    glossaryCount,
    entityCount,
    phraseCount,
    ceremonyCount,
    correctionCount,
    shouldShowSourceProminently: band === 'low',
    recommendedDisplayMode: band === 'low' ? 'source_plus_translation' : 'translation_primary',
  };
}

function literalFallbackTranslate(text, hits) {
  let out = text;
  out = applyGlossaryToEnglish(out, hits);

  out = out
    .replaceAll('今天講解', 'today explains')
    .replaceAll('修持重點', 'the key points of practice')
    .replaceAll('我們先', 'let us first')
    .replaceAll('接下來是', 'next is')
    .replaceAll('開示', 'teaching')
    .replaceAll('法會', 'Dharma ceremony')
    .replaceAll('修行', 'practice')
    .replaceAll('眾生', 'sentient beings')
    .replaceAll('離苦得樂', 'be freed from suffering and attain happiness')
    .replaceAll('一心敬禮', 'wholeheartedly pay homage')
    .replaceAll('為什麼', 'why')
    .replaceAll('不知道', 'do not know');

  return out;
}


function conservativeInterimTranslate(text, hits) {
  const t = text.trim();
  if (!t) return '';
  if (t.length <= 1) return '';
  if (t.length <= 2) return applyGlossaryToEnglish(t, hits);
  return literalFallbackTranslate(t, hits);
}

function looksAbsurdOutput(text = '') {
  const t = (text || '').trim();
  if (!t) return false;

  const absurdPatterns = [
    /butt gods?/i,
    /ass gods?/i,
    /屁股神/,
    /臀部神/,
    /anus/i,
    /toilet gods?/i,
    /buttocks/i,
    /god of butt/i,
    /we all become butt/i,
    /everyone becomes butt/i,
  ];

  if (absurdPatterns.some((re) => re.test(t))) return true;

  const weirdLiteralPairs = [
    ['butt', 'god'],
    ['ass', 'god'],
    ['toilet', 'buddha'],
    ['toilet', 'bodhisattva'],
  ];

  for (const [a, b] of weirdLiteralPairs) {
    if (t.toLowerCase().includes(a) && t.toLowerCase().includes(b)) {
      return true;
    }
  }

  return false;
}

function buildDeepSeekPrompts({
  text,
  hits,
  mode,
  retrieval,
  eventMode,
  contextWindow,
  inputMode,
  forceAntiLiteral = false,
  activeTopic = null,
  routeKey = 'zh_en',
}) {
  const glossaryBlock =
    hits.length > 0
      ? hits.map((t) => `${t.cn} => ${t.en}`).join('\n')
      : 'No glossary hits';

  const sacredBlock =
    (retrieval.sacredEntities || []).length > 0
      ? retrieval.sacredEntities
          .map((x) => `${x.cn} => ${x.en}${x.category ? ` [${x.category}]` : ''}`)
          .join('\n')
      : 'No sacred entity hits';

  const phraseBlock =
    (retrieval.phraseMatches || []).length > 0
      ? retrieval.phraseMatches.map((x) => `${x.cn} => ${x.en}`).join('\n')
      : 'No phrase memory hits';

  const ceremonyBlock =
    (retrieval.ceremonyMatches || []).length > 0
      ? retrieval.ceremonyMatches.map((x) => `${x.cn} => ${x.en}`).join('\n')
      : 'No ceremony phrase hits';

  const correctionBlock =
    (retrieval.correctionMatches || []).length > 0
      ? retrieval.correctionMatches
          .map((x) => {
            const intended = x.intendedChinese || x.corrected || '';
            const correctedEn = x.correctedEnglish || '';
            return `${x.heard} => ${intended}${correctedEn ? ` => ${correctedEn}` : ''}`;
          })
          .join('\n')
      : 'No correction memory hits';

  const contextBlock =
    contextWindow.length > 0
      ? contextWindow.map((x, i) => `${i + 1}. CN: ${x.cn} || EN: ${x.en}`).join('\n')
      : 'No recent context';

  const activeTopicBlock = activeTopic?.cn
    ? `Active topic: ${activeTopic.cn}${activeTopic.en ? ` => ${activeTopic.en}` : ''}\nType: ${activeTopic.type || 'entity'}\nConfidence: ${activeTopic.confidence || 0}`
    : 'No active topic';

  const antiLiteralRule = forceAntiLiteral
    ? '\n10. The previous draft looked absurd or over-literal. Prefer the intended religious meaning over literal nonsense.\n11. Never output comic body-part deity phrases or other obviously cursed literal renderings.\n12. If correction memory suggests a likely intended phrase, follow it.\n13. If an active topic is present, prefer that interpretation when the input is ambiguous.'
    : '';

  if (routeKey === 'id_en') {
    const phraseBlock =
      (retrieval.phraseMatches || []).length > 0
        ? retrieval.phraseMatches.map((x) => `${x.idn || x.cn} => ${x.en}`).join('\n')
        : 'No phrase memory hits';

    const correctionBlock =
      (retrieval.correctionMatches || []).length > 0
        ? retrieval.correctionMatches
            .map((x) => `${x.heard} => ${x.intendedIndonesian || ''}${x.correctedEnglish ? ` => ${x.correctedEnglish}` : ''}`)
            .join('\n')
        : 'No correction memory hits';

    const systemPrompt =
      mode === 'interim'
        ? `
You are the official translator for True Buddha School (TBS).
Translate spoken Bahasa Indonesia into short, conservative live subtitle English.

Rules:
1. Output English only.
2. Use standard True Buddha School English terminology.
3. Preserve sacred names, titles, and ritual terms in their established TBS English forms.
4. Prefer canonical renderings such as Root Guru, Lineage Guru, Living Buddha Lian Sheng, Dharma Protector, Pure Land, and Dedication of Merits.
5. Do not paraphrase into generic religious language.
6. Keep it short and subtitle-safe.
7. No explanations, no notes, no brackets unless essential.
8. Prefer natural devotional or teaching English, not robotic literal wording.
`.trim()
        : `
You are the official translator for True Buddha School (TBS).
Translate spoken Bahasa Indonesia into natural subtitle English.

Rules:
1. Output English only.
2. Use standard True Buddha School English terminology.
3. Preserve sacred names, titles, and ritual terms in their established TBS English forms.
4. Prefer canonical renderings such as Root Guru, Lineage Guru, Living Buddha Lian Sheng, Dharma Protector, Pure Land, and Dedication of Merits.
5. Do not paraphrase into generic religious language.
6. No explanations, no notes, no brackets unless essential.
7. Keep it clear, natural, and subtitle-friendly.
8. Prefer natural devotional or teaching English, not robotic literal wording.
Event mode: ${eventMode}
Input mode: ${inputMode}
`.trim();

    const userPrompt = `
Mode: ${mode}

Input:
${text}

Recent context:
${contextBlock}

Glossary:
${glossaryBlock}

Phrase memory matches:
${phraseBlock}

Correction memory matches:
${correctionBlock}
`.trim();

    return { systemPrompt, userPrompt };
  }

  const systemPrompt =
    mode === 'interim'
      ? `
You are the official translator for True Buddha School (TBS).
Translate spoken Chinese into short, conservative live subtitle English.

Rules:
1. Output English only.
2. If the source already contains English words or phrases, preserve them in English.
3. Translate only the Chinese parts.
4. Preserve TBS terms exactly from the glossary, sacred entity list, and correction memory.
5. If ASR looks noisy, prefer the correction memory and nearby context over absurd literal output.
6. Keep it very short and subtitle-safe.
7. Do not re-translate English into different English.
8. Avoid absurd literal output.
9. Prefer clean devotional or teaching language over strange word-for-word renderings.
10. If an active topic is present, prefer that interpretation when the input is ambiguous.${antiLiteralRule}
`.trim()
      : `
You are the official translator for True Buddha School (TBS).
Translate spoken Chinese into natural subtitle English.

Rules:
1. Output English only.
2. If the source already contains English words or phrases, preserve them in English.
3. Translate only the Chinese portions.
4. Preserve TBS terminology exactly when given in the glossary, sacred entity list, phrase memory, ceremony memory, and correction memory.
5. Use recent context to repair likely ASR errors when the intended meaning is clear.
6. Avoid absurd literal output.
7. No explanations, no notes, no brackets unless essential.
8. Keep it clear, natural, and subtitle-friendly.
9. Use culturally and doctrinally appropriate TBS English wording.
10. If an active topic is present, prefer that interpretation when the input is ambiguous.${antiLiteralRule}
Event mode: ${eventMode}
Input mode: ${inputMode}
`.trim();

  const userPrompt = `
Mode: ${mode}

Input:
${text}

Recent context:
${contextBlock}

Active topic:
${activeTopicBlock}

Glossary:
${glossaryBlock}

Sacred entity matches:
${sacredBlock}

Phrase memory matches:
${phraseBlock}

Ceremony phrase matches:
${ceremonyBlock}

Correction memory matches:
${correctionBlock}
`.trim();

  return { systemPrompt, userPrompt };
}

function getContextWindow(session, limit = retrievalConfig.context_window_lines || 5) {
  if (!session || !Array.isArray(session.lines)) return [];
  return session.lines.slice(0, limit).map((line) => ({
    cn: line.normalizedCn || line.rawCn || '',
    en: line.en || '',
  }));
}

async function translateWithDeepSeek(
  text,
  hits,
  mode = 'final',
  retrieval = {},
  eventMode = 'Dharma Talk',
  contextWindow = [],
  inputMode = 'chinese',
  activeTopic = null,
  routeKey = 'zh_en'
) {
  if (!text || !text.trim()) return '';

  const phraseMatch = findPhraseMatch(text, mode);
  if (phraseMatch?.en) return phraseMatch.en;

  if (routeKey !== 'id_en' && inputMode === 'english') {
    return text.trim();
  }
  if (inputMode === 'mixed') {
    return translateMixedSegments({
      text,
      hits,
      mode,
      retrieval,
      eventMode,
      contextWindow,
      activeTopic,
      routeKey,
    });
  }

  if (mode === 'interim') {
    if (!DEEPSEEK_API_KEY || isShortFragment(text)) {
      return conservativeInterimTranslate(text, hits);
    }
  }

  if (!DEEPSEEK_API_KEY) {
    return mode === 'interim'
      ? conservativeInterimTranslate(text, hits)
      : literalFallbackTranslate(text, hits);
  }

  let { systemPrompt, userPrompt } = buildDeepSeekPrompts({
    text,
    hits,
    mode,
    retrieval,
    eventMode,
    contextWindow,
    inputMode,
    forceAntiLiteral: false,
    activeTopic,
    routeKey,
  });

  try {
    async function requestOnce(currentSystemPrompt, currentUserPrompt) {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: mode === 'interim' ? 0.0 : 0.1,
          messages: [
            { role: 'system', content: currentSystemPrompt },
            { role: 'user', content: currentUserPrompt },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`[DeepSeek] HTTP error ${errText}`);
      }

      const data = await res.json();
      return data?.choices?.[0]?.message?.content?.trim() || '';
    }

    let out = await requestOnce(systemPrompt, userPrompt);

    if (!out) {
      return mode === 'interim'
        ? conservativeInterimTranslate(text, hits)
        : literalFallbackTranslate(text, hits);
    }

    if (mode !== 'interim' && looksAbsurdOutput(out)) {
      console.warn('[DeepSeek] absurd output detected, retrying once with stronger anti-literal guard');

      ({ systemPrompt, userPrompt } = buildDeepSeekPrompts({
        text,
        hits,
        mode,
        retrieval,
        eventMode,
        contextWindow,
        inputMode,
        forceAntiLiteral: true,
        activeTopic,
      }));

      const retryOut = await requestOnce(systemPrompt, userPrompt);
      if (retryOut && !looksAbsurdOutput(retryOut)) {
        out = retryOut;
      }
    }

    return out;
  } catch (err) {
    console.error('[DeepSeek] request failed', err.message);
    return mode === 'interim'
      ? conservativeInterimTranslate(text, hits)
      : literalFallbackTranslate(text, hits);
  }
}

function buildLine(rawCn, normalizedCn, en, hits, retrieval = {}, extra = {}) {
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    rawCn,
    normalizedCn,
    en,
    hits,
    retrieval,
    inputMode: extra.inputMode || 'unknown',
    correctionHits: extra.correctionHits || [],
    translationMeta: extra.translationMeta || null,
    time: new Date().toLocaleTimeString(),
    at: new Date().toISOString(),
  };
}

function appendCorrectionMemory(entry) {
  const row = {
    id: Date.now(),
    at: new Date().toISOString(),
    ...entry,
  };
  correctionMemory.unshift(row);
  correctionMemory = correctionMemory.slice(0, 1000);
  writeJson(correctionMemoryPath, correctionMemory);
  return row;
}

function appendMishearLog(entry) {
  const row = {
    id: Date.now(),
    at: new Date().toISOString(),
    ...entry,
  };
  asrMishearLog.unshift(row);
  asrMishearLog = asrMishearLog.slice(0, 500);
  writeJson(asrMishearLogPath, asrMishearLog);
  return row;
}

app.get('/api/session/:id', (req, res) => {
  const session = getOrCreateSession(req.params.id);
  res.json(session);
});

app.post('/api/session', (req, res) => {
  const requestedId = req.body?.id || 'live-session';
  const session = getOrCreateSession(requestedId);

  const {
    title = session.title,
    eventMode = session.eventMode,
    sourceLanguage = session.sourceLanguage,
    targetLanguage = session.targetLanguage,
    translationRoute = deriveTranslationRoute(sourceLanguage, targetLanguage),
  } = req.body || {};

  session.title = title;
  session.eventMode = eventMode;
  session.sourceLanguage = sourceLanguage;
  session.targetLanguage = targetLanguage;
  session.translationRoute = translationRoute;

  res.json(session);
});

app.post('/api/session/:id/line', async (req, res) => {
  const session = getOrCreateSession(req.params.id);

  const rawCn = (req.body?.rawCn || '').trim();
  if (!rawCn) return res.status(400).json({ error: 'rawCn required' });

  const routeKey = req.body?.translationRoute || session.translationRoute || deriveTranslationRoute(session.sourceLanguage, session.targetLanguage);
  const prepared = runRouteNormalization(rawCn, session.eventMode, routeKey);
  const normalizedCn = prepared.normalizedText;
  const hits = applyRouteGlossary(normalizedCn, routeKey);

  const retrieval = routeKey === 'id_en'
    ? {
        sacredEntities: [],
        phraseMatches: prepared.phraseHints || retrieveIndonesianPhraseMemory(normalizedCn),
        ceremonyMatches: [],
        correctionMatches: prepared.correctionHits || [],
      }
    : {
        sacredEntities: retrieveSacredEntities(normalizedCn, session.eventMode),
        phraseMatches: retrievePhraseMemory(normalizedCn, session.eventMode),
        ceremonyMatches: retrieveCeremonyMemory(normalizedCn, session.eventMode),
        correctionMatches:
          prepared.correctionHits || retrieveCorrectionMemory(normalizedCn, session.eventMode),
      };

  const activeTopic = routeKey === 'id_en'
    ? null
    : getActiveTopicContext(
        updateSessionTopic(session, normalizedCn, retrieval, session.eventMode)
      );

  const en = await translateWithDeepSeek(
    normalizedCn,
    hits,
    'final',
    retrieval,
    session.eventMode,
    getContextWindow(session),
    prepared.inputMode,
    activeTopic,
    routeKey
  );

  const translationMeta = buildTranslationMeta({
    normalizedCn,
    en,
    hits,
    retrieval,
    inputMode: prepared.inputMode,
    activeTopic,
    mode: 'final',
  });

  const line = buildLine(rawCn, normalizedCn, en, hits, retrieval, {
    inputMode: prepared.inputMode,
    correctionHits: prepared.correctionHits,
    translationMeta,
  });
  session.lines.unshift(line);
  session.lines = session.lines.slice(0, 100);

  res.json(line);
});

app.post('/api/translate-interim', async (req, res) => {
  const rawCn = (req.body?.rawCn || '').trim();
  const eventMode = req.body?.eventMode || 'Dharma Talk';
  const session = getOrCreateSession('live-session');
  const routeKey = req.body?.translationRoute || session.translationRoute || deriveTranslationRoute(req.body?.sourceLanguage, req.body?.targetLanguage);

  if (!rawCn) return res.json({ en: '', normalizedCn: '', hits: [] });

  const prepared = runRouteNormalization(rawCn, eventMode, routeKey);
  const normalizedCn = prepared.normalizedText;
  const hits = applyRouteGlossary(normalizedCn, routeKey);

  if (!isStableEnoughForInterim(normalizedCn)) {
    return res.json({
      en: prepared.inputMode === 'english' ? normalizedCn : '',
      normalizedCn,
      hits,
      inputMode: prepared.inputMode,
    });
  }

  const retrieval = routeKey === 'id_en'
    ? {
        sacredEntities: [],
        phraseMatches: prepared.phraseHints || retrieveIndonesianPhraseMemory(normalizedCn),
        ceremonyMatches: [],
        correctionMatches: prepared.correctionHits || [],
      }
    : {
        sacredEntities: retrieveSacredEntities(normalizedCn, eventMode),
        phraseMatches: retrievePhraseMemory(normalizedCn, eventMode),
        ceremonyMatches: retrieveCeremonyMemory(normalizedCn, eventMode),
        correctionMatches:
          prepared.correctionHits || retrieveCorrectionMemory(normalizedCn, eventMode),
      };

  const activeTopic = routeKey === 'id_en'
    ? null
    : getActiveTopicContext(
        updateSessionTopic(session, normalizedCn, retrieval, eventMode)
      );

  const en = await translateWithDeepSeek(
    normalizedCn,
    hits,
    'interim',
    retrieval,
    eventMode,
    getContextWindow(session),
    prepared.inputMode,
    activeTopic,
    routeKey
  );

  const translationMeta = buildTranslationMeta({
    normalizedCn,
    en,
    hits,
    retrieval,
    inputMode: prepared.inputMode,
    activeTopic,
    mode: 'interim',
  });

  res.json({
    en,
    normalizedCn,
    hits,
    retrieval,
    inputMode: prepared.inputMode,
    translationMeta,
  });
});

app.get('/api/asr-mishear-log', (req, res) => {
  res.json(asrMishearLog);
});

app.post('/api/asr-mishear-log', (req, res) => {
  const { heard, corrected, category = 'unknown', notes = '' } = req.body || {};
  if (!heard || !corrected) {
    return res.status(400).json({ error: 'heard and corrected are required' });
  }

  const row = appendMishearLog({ heard, corrected, category, notes });
  res.json({ ok: true, row });
});

app.get('/api/correction-memory', (req, res) => {
  res.json(correctionMemory);
});

app.post('/api/correction-memory', (req, res) => {
  const {
    heard,
    corrected,
    correctedEnglish,
    intendedChinese,
    category = 'unknown',
    eventMode = 'Dharma Talk',
    notes = '',
    tags = [],
    weight = 5,
  } = req.body || {};

  if (!heard || !(corrected || correctedEnglish || intendedChinese)) {
    return res.status(400).json({
      error: 'heard and one of corrected/correctedEnglish/intendedChinese are required',
    });
  }

  const row = appendCorrectionMemory({
    heard,
    corrected: corrected || intendedChinese || correctedEnglish,
    correctedEnglish: correctedEnglish || corrected || '',
    intendedChinese: intendedChinese || corrected || '',
    category,
    eventMode,
    notes,
    tags,
    weight,
  });
  res.json({ ok: true, row });
});

app.post('/api/session/:id/clear', (req, res) => {
  const { id } = req.params;

  const session = sessions.find((s) => s.id === id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.lines = [];

  res.json({ ok: true });
});
const viewerClientsBySession = new Map();

function addViewerClient(sessionId, ws) {
  if (!viewerClientsBySession.has(sessionId)) {
    viewerClientsBySession.set(sessionId, new Set());
  }
  viewerClientsBySession.get(sessionId).add(ws);
}

function removeViewerClient(sessionId, ws) {
  const set = viewerClientsBySession.get(sessionId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    viewerClientsBySession.delete(sessionId);
  }
}

function broadcastToViewers(sessionId, payload) {
  const set = viewerClientsBySession.get(sessionId);
  if (!set) return;

  const message = JSON.stringify(payload);

  for (const ws of set) {
    if (ws.readyState === 1) {
      ws.send(message);
    }
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (browserWs, req) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const isViewer = requestUrl.searchParams.get('viewer') === '1';
  const sessionId = requestUrl.searchParams.get('sessionId') || 'live-session';
  const routeKey = requestUrl.searchParams.get('route') || 'zh_en';
  const routeConfig = getRouteConfig(routeKey);

  if (isViewer) {
    console.log('[Viewer] connected', sessionId);
    addViewerClient(sessionId, browserWs);

    const session = getOrCreateSession(sessionId);
    if (browserWs.readyState === 1) {
      browserWs.send(JSON.stringify({ type: 'session', session }));
    }

    browserWs.on('close', () => {
      console.log('[Viewer] disconnected', sessionId);
      removeViewerClient(sessionId, browserWs);
    });

    browserWs.on('error', () => {
      removeViewerClient(sessionId, browserWs);
    });

    return;
  }

  console.log('[Browser] connected', routeKey, sessionId);

  let frameCount = 0;
  let totalBytes = 0;
  let keepAliveTimer = null;
  let dg = null;
  let shuttingDown = false;
  let deepgramClosedLogged = false;

  let lastInterimSourceSent = '';
  let lastInterimSentAt = 0;

  const activeSession = getOrCreateSession(sessionId);
  activeSession.translationRoute = routeKey;

  function sendToBrowser(obj) {
    if (browserWs.readyState === 1) {
      browserWs.send(JSON.stringify(obj));
    }
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    stopKeepAlive();

    try {
      if (dg && typeof dg.sendClose === 'function') {
        dg.sendClose({ type: 'CloseStream' });
      }
    } catch (err) {
      console.error('[Deepgram] sendClose failed', err.message);
    }
  }

  try {
    dg = await deepgram.listen.v1.connect({
      model: 'nova-2',
      language: routeConfig.asrLanguage,
      interim_results: true,
      punctuate: true,
      smart_format: true,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      ...(routeKey === 'id_en' && Array.isArray(routeConfig.hotwords) && routeConfig.hotwords.length
        ? { keywords: routeConfig.hotwords }
        : {}),
    });

    dg.on('open', () => {
      if (shuttingDown) return;

      console.log('[Deepgram] open');
      sendToBrowser({ type: 'status', status: 'deepgram_ready' });

      stopKeepAlive();
      keepAliveTimer = setInterval(() => {
        try {
          if (!shuttingDown && dg && typeof dg.sendKeepAlive === 'function') {
            dg.sendKeepAlive({ type: 'KeepAlive' });
          }
        } catch (err) {
          console.error('[Deepgram] sendKeepAlive failed', err.message);
        }
      }, 3000);
    });

    dg.on('message', async (data) => {
      try {
        if (!data || data.type !== 'Results') return;

        const rawText = data?.channel?.alternatives?.[0]?.transcript || '';
        if (!rawText.trim()) return;

        const prepared = runRouteNormalization(rawText, activeSession.eventMode, routeKey);
        const normalizedCn = prepared.normalizedText;
        const hits = applyRouteGlossary(normalizedCn, routeKey);

        if (data.is_final) {
          const retrieval = routeKey === 'id_en'
            ? {
                sacredEntities: [],
                phraseMatches: prepared.phraseHints || retrieveIndonesianPhraseMemory(normalizedCn),
                ceremonyMatches: [],
                correctionMatches: prepared.correctionHits || [],
              }
            : {
                sacredEntities: retrieveSacredEntities(normalizedCn, activeSession.eventMode),
                phraseMatches: retrievePhraseMemory(normalizedCn, activeSession.eventMode),
                ceremonyMatches: retrieveCeremonyMemory(normalizedCn, activeSession.eventMode),
                correctionMatches:
                  prepared.correctionHits ||
                  retrieveCorrectionMemory(normalizedCn, activeSession.eventMode),
              };

          const activeTopic = routeKey === 'id_en'
            ? null
            : getActiveTopicContext(
                updateSessionTopic(activeSession, normalizedCn, retrieval, activeSession.eventMode)
              );

          const en = await translateWithDeepSeek(
            normalizedCn,
            hits,
            'final',
            retrieval,
            activeSession.eventMode,
            getContextWindow(activeSession),
            prepared.inputMode,
            activeTopic,
            routeKey
          );

          const translationMeta = buildTranslationMeta({
            normalizedCn,
            en,
            hits,
            retrieval,
            inputMode: prepared.inputMode,
            activeTopic,
            mode: 'final',
          });

          const line = buildLine(rawText, normalizedCn, en, hits, retrieval, {
            inputMode: prepared.inputMode,
            correctionHits: prepared.correctionHits,
            translationMeta,
          });

          activeSession.lines.unshift(line);
          activeSession.lines = activeSession.lines.slice(0, 100);

          lastInterimSourceSent = '';
          lastInterimSentAt = 0;

          sendToBrowser({ type: 'final', line });
          broadcastToViewers(sessionId, { type: 'final', line });
          broadcastToViewers(sessionId, { type: 'session', session: activeSession });
        } else {
          const now = Date.now();

          const hasMeaningfulChange =
            normalizedCn !== lastInterimSourceSent &&
            normalizedCn.length >= Math.max(4, lastInterimSourceSent.length);

          const respectsThrottle = now - lastInterimSentAt >= 350;

          if (hasMeaningfulChange && respectsThrottle) {
            lastInterimSourceSent = normalizedCn;
            lastInterimSentAt = now;

            const livePayload = {
              type: 'live_cn',
              text: rawText,
              rawCn: rawText,
              cn: normalizedCn,
              normalizedCn,
              inputMode: prepared.inputMode,
            };

            sendToBrowser(livePayload);
            broadcastToViewers(sessionId, livePayload);
          }
        }
      } catch (err) {
        console.error('[Deepgram] transcript handler failed', err.message);
      }
    });

    dg.on('error', (err) => {
      if (shuttingDown) return;
      console.error('[Deepgram] error', err);
      sendToBrowser({ type: 'error', message: 'Deepgram error' });
    });

    dg.on('close', () => {
      stopKeepAlive();

      if (!deepgramClosedLogged) {
        deepgramClosedLogged = true;
        console.log('[Deepgram] closed');
      }

      if (!shuttingDown) {
        sendToBrowser({ type: 'status', status: 'deepgram_closed' });
      }
    });

    dg.connect();
    await dg.waitForOpen();
  } catch (err) {
    console.error('[Deepgram] failed to initialize', err.message);
    sendToBrowser({ type: 'error', message: `Deepgram init failed: ${err.message}` });
    try {
      browserWs.close();
    } catch {}
    return;
  }

  browserWs.on('message', (data, isBinary) => {
    if (isBinary) {
      frameCount += 1;
      totalBytes += data.length;

      if (frameCount % 30 === 0) {
        console.log(
          `[Browser audio] frames=${frameCount} totalBytes=${totalBytes} lastBytes=${data.length}`
        );
      }

      sendToBrowser({
        type: 'audio_debug',
        frameCount,
        totalBytes,
        lastBytes: data.length,
      });

      try {
        if (dg && typeof dg.sendMedia === 'function') {
          dg.sendMedia(data);
        }
      } catch (err) {
        console.error('[Deepgram] sendMedia failed', err.message);
      }
      return;
    }

    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        sendToBrowser({ type: 'pong', t: Date.now() });
      }
    } catch {
      console.log('[Browser] bad text message');
    }
  });

  browserWs.on('close', () => {
    console.log('[Browser] disconnected');
    shutdown();
  });

  browserWs.on('error', (err) => {
    console.error('[Browser] error', err.message);
    shutdown();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TBS V2 API running on http://0.0.0.0:${PORT}`);
  console.log(`TBS V2 WS bridge running on ws://0.0.0.0:${PORT}/ws`);
});
function applyIndonesianCorrections(text) {
  if (!text) return { text: '', hits: [] };

  let out = text;
  const hits = [];

  for (const row of correctionMemoryId) {
    const heard = normalizeSpaces(row?.heard || '');
    const intendedIndonesian = normalizeSpaces(row?.intendedIndonesian || '');
    const correctedEnglish = normalizeSpaces(row?.correctedEnglish || '');
    if (!heard || !intendedIndonesian) continue;

    const escaped = heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');

    if (re.test(out)) {
      out = out.replace(re, intendedIndonesian);
      hits.push({
        ...row,
        correctedEnglish,
        _score: Number(row?.weight || 0) || 0,
      });
    }
  }

  return { text: normalizeSpaces(out), hits };
}

function retrieveIndonesianPhraseMemory(text) {
  const normalized = normalizeSpaces(text).toLowerCase();
  if (!normalized) return [];

  return phraseMemoryId
    .filter((row) => row?.idn && normalized.includes(String(row.idn).toLowerCase()))
    .map((row) => ({
      ...row,
      cn: row.idn,
      _score: Number(row?.weight || 0) || String(row.idn || '').length,
    }))
    .sort((a, b) => b._score - a._score)
    .slice(0, retrievalConfig.top_phrase_matches || 6);
}

function applyIndonesianGlossary(text) {
  if (!text) return [];

  const normalized = String(text || '').toLowerCase();
  const hits = [];
  const sorted = [...bahasaGlossary].sort((a, b) => (b.cn?.length || 0) - (a.cn?.length || 0));

  for (const term of sorted) {
    if (term?.cn && normalized.includes(String(term.cn).toLowerCase())) {
      hits.push(term);
    }
  }

  return hits;
}