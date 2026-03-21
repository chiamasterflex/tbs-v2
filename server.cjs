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

const asrMishearLogPath = path.join(resourcesDir, 'asr_mishear_log.json');
let asrMishearLog = readJson(asrMishearLogPath, []);

const correctionMemoryPath = path.join(resourcesDir, 'correction_memory.json');
let correctionMemory = readJson(correctionMemoryPath, []);

const retrievalConfig = readJson(path.join(resourcesDir, 'retrieval_config.json'), {
  top_sacred_entities: 6,
  top_phrase_matches: 4,
  top_ceremony_matches: 4,
  min_phrase_score: 2,
  min_entity_score: 2,
});

console.log(
  `[Resources] glossary=${generatedGlossary.length} corrections=${generatedCorrections.length} phrases=${generatedPhrases.length} deities=${generatedDeities.length} phonetic=${generatedPhoneticCorrections.length} tbsTerms=${generatedTbsTerms.length} sacredNames=${generatedSacredNames.length} ceremonyPhrases=${generatedCeremonyPhrases.length} sacredEntities=${sacredEntities.length} phraseMemory=${phraseMemory.length} ceremonyMemory=${ceremonyMemory.length} correctionMemory=${correctionMemory.length}`
);

let sessions = [];

function getOrCreateSession(id = 'live-session') {
  let session = sessions.find((s) => s.id === id);

  if (!session) {
    session = {
      id,
      title: 'TBS Live Session',
      eventMode: 'Dharma Talk',
      sourceLanguage: 'Mandarin',
      targetLanguage: 'English',
      lines: [],
    };
    sessions.unshift(session);
  }

  return session;
}

getOrCreateSession('live-session');

function normalizeSpaces(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
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

function runBrainNormalization(text) {
  let out = normalizeChineseText(text);
  out = applyPhoneticBrain(out);
  out = applySacredNameBrain(out);
  out = applyContextBias(out);
  return normalizeSpaces(out);
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
  if (t.length < 6) return false;
  if (/[，。！？、,.!?]$/.test(t)) return true;
  if (t.length >= 12) return true;
  return false;
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
    .slice(0, retrievalConfig.top_sacred_entities || 6);
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
    if (candidateCn.includes(text) && text.length >= 8) score += text.length;
    score += stringOverlapLoose(text, candidateCn);

    if (row?.event_mode === eventMode || row?.eventMode === eventMode) score += 2;
    score += sourceWeightBonus(row);

    if (score >= (retrievalConfig.min_phrase_score || 2)) {
      results.push({ ...row, _score: score });
    }
  }

  return results
    .sort((a, b) => b._score - a._score || (b.cn?.length || 0) - (a.cn?.length || 0))
    .slice(0, retrievalConfig.top_phrase_matches || 4);
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

async function translateWithDeepSeek(text, hits, mode = 'final', retrieval = {}, eventMode = 'Dharma Talk') {
  if (!text || !text.trim()) return '';

  const phraseMatch = findPhraseMatch(text, mode);
  if (phraseMatch?.en) return phraseMatch.en;

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

  const systemPrompt =
    mode === 'interim'
      ? `
You are the official translator for True Buddha School (TBS).
Translate spoken Chinese into short, conservative live subtitle English.

Rules:
1. Output English only.
2. Be literal and restrained.
3. Do not guess missing context.
4. Preserve TBS terms exactly from the glossary and sacred entity list.
5. If the input is fragmentary, translate only what is clearly present.
6. Keep it very short.
7. Prefer retrieved sacred names and phrase memory over generic wording.
`.trim()
      : `
You are the official translator for True Buddha School (TBS).
Translate spoken Chinese into natural English for final subtitles.

Rules:
1. Output English only.
2. Preserve TBS terminology exactly when given in the glossary and sacred entity list.
3. No explanations.
4. Keep it clear, natural, and subtitle-friendly.
5. Prefer accuracy over flourish.
6. Do not invent implied meanings.
7. Prefer retrieved phrase examples and ceremony language where relevant.
8. Use culturally and doctrinally appropriate TBS English wording.
Event mode: ${eventMode}
`.trim();

  const userPrompt = `
Mode: ${mode}

Chinese:
${text}

Glossary:
${glossaryBlock}

Sacred entity matches:
${sacredBlock}

Phrase memory matches:
${phraseBlock}

Ceremony phrase matches:
${ceremonyBlock}
`.trim();

  try {
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
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[DeepSeek] HTTP error', errText);
      return mode === 'interim'
        ? conservativeInterimTranslate(text, hits)
        : literalFallbackTranslate(text, hits);
    }

    const data = await res.json();
    const out = data?.choices?.[0]?.message?.content?.trim();

    if (!out) {
      return mode === 'interim'
        ? conservativeInterimTranslate(text, hits)
        : literalFallbackTranslate(text, hits);
    }

    return out;
  } catch (err) {
    console.error('[DeepSeek] request failed', err.message);
    return mode === 'interim'
      ? conservativeInterimTranslate(text, hits)
      : literalFallbackTranslate(text, hits);
  }
}

function buildLine(rawCn, normalizedCn, en, hits, retrieval = {}) {
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    rawCn,
    normalizedCn,
    en,
    hits,
    retrieval,
    time: new Date().toLocaleTimeString(),
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
  } = req.body || {};

  session.title = title;
  session.eventMode = eventMode;
  session.sourceLanguage = sourceLanguage;
  session.targetLanguage = targetLanguage;

  res.json(session);
});

app.post('/api/session/:id/line', async (req, res) => {
  const session = getOrCreateSession(req.params.id);

  const rawCn = (req.body?.rawCn || '').trim();
  if (!rawCn) return res.status(400).json({ error: 'rawCn required' });

  const normalizedCn = runBrainNormalization(rawCn);
  const hits = applyGlossary(normalizedCn);

  const retrieval = {
    sacredEntities: retrieveSacredEntities(normalizedCn, session.eventMode),
    phraseMatches: retrievePhraseMemory(normalizedCn, session.eventMode),
    ceremonyMatches: retrieveCeremonyMemory(normalizedCn, session.eventMode),
  };

  const en = await translateWithDeepSeek(
    normalizedCn,
    hits,
    'final',
    retrieval,
    session.eventMode
  );

  const line = buildLine(rawCn, normalizedCn, en, hits, retrieval);
  session.lines.unshift(line);
  session.lines = session.lines.slice(0, 100);

  res.json(line);
});

app.post('/api/translate-interim', async (req, res) => {
  const rawCn = (req.body?.rawCn || '').trim();
  const eventMode = req.body?.eventMode || 'Dharma Talk';

  if (!rawCn) return res.json({ en: '', normalizedCn: '', hits: [] });

  const normalizedCn = runBrainNormalization(rawCn);
  const hits = applyGlossary(normalizedCn);

  if (!isStableEnoughForInterim(normalizedCn)) {
    return res.json({ en: '', normalizedCn, hits });
  }

  const retrieval = {
    sacredEntities: retrieveSacredEntities(normalizedCn, eventMode),
    phraseMatches: retrievePhraseMemory(normalizedCn, eventMode),
    ceremonyMatches: retrieveCeremonyMemory(normalizedCn, eventMode),
  };

  const en = await translateWithDeepSeek(
    normalizedCn,
    hits,
    'interim',
    retrieval,
    eventMode
  );

  res.json({ en, normalizedCn, hits, retrieval });
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
    category = 'unknown',
    eventMode = 'Dharma Talk',
    notes = '',
  } = req.body || {};

  if (!heard || !corrected) {
    return res.status(400).json({ error: 'heard and corrected are required' });
  }

  const row = appendCorrectionMemory({ heard, corrected, category, eventMode, notes });
  res.json({ ok: true, row });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (browserWs) => {
  console.log('[Browser] connected');

  let frameCount = 0;
  let totalBytes = 0;
  let keepAliveTimer = null;
  let dg = null;
  let shuttingDown = false;
  let deepgramClosedLogged = false;

  let lastInterimSourceSent = '';
  let lastInterimSentAt = 0;

  const activeSession = getOrCreateSession('live-session');

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
      language: 'zh-CN',
      interim_results: true,
      punctuate: true,
      smart_format: true,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
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

        const normalizedCn = runBrainNormalization(rawText);
        const hits = applyGlossary(normalizedCn);

        if (data.is_final) {
          const retrieval = {
            sacredEntities: retrieveSacredEntities(normalizedCn, activeSession.eventMode),
            phraseMatches: retrievePhraseMemory(normalizedCn, activeSession.eventMode),
            ceremonyMatches: retrieveCeremonyMemory(normalizedCn, activeSession.eventMode),
          };

          const en = await translateWithDeepSeek(
            normalizedCn,
            hits,
            'final',
            retrieval,
            activeSession.eventMode
          );

          const line = buildLine(rawText, normalizedCn, en, hits, retrieval);

          activeSession.lines.unshift(line);
          activeSession.lines = activeSession.lines.slice(0, 100);

          lastInterimSourceSent = '';
          lastInterimSentAt = 0;

          sendToBrowser({ type: 'final', line });
        } else {
          const now = Date.now();

          const hasMeaningfulChange =
            normalizedCn !== lastInterimSourceSent &&
            normalizedCn.length >= Math.max(4, lastInterimSourceSent.length);

          const respectsThrottle = now - lastInterimSentAt >= 350;

          if (hasMeaningfulChange && respectsThrottle) {
            lastInterimSourceSent = normalizedCn;
            lastInterimSentAt = now;
            sendToBrowser({ type: 'live_cn', text: rawText, normalizedCn });
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
app.post('/api/session/:id/clear', (req, res) => {
  const { id } = req.params;

  if (!sessions[id]) {
    return res.status(404).json({ error: 'Session not found' });
  }

  sessions[id].lines = [];

  res.json({ ok: true });
});