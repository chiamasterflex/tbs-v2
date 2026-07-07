require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { DeepgramClient } = require('@deepgram/sdk');
const { createClient } = require('@supabase/supabase-js');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
} = require('docx');
const fetch = require('cross-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8787;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-3';
const DEEPSEEK_CHAT_COMPLETIONS_URL = 'https://api.deepseek.com/chat/completions';
const ROLLING_CONTEXT_MIN_NEW_LINES = 8;
const ROLLING_CONTEXT_COOLDOWN_MS = 20000;
const ROLLING_CONTEXT_SLOW_FALLBACK_MS = 30000;
const ROLLING_CONTEXT_SLOW_FALLBACK_MIN_LINES = 5;
const TBS_KNOWLEDGE_MAX_CHUNKS = 3;
const TBS_KNOWLEDGE_MAX_CONTEXT_CHARS = 1500;

if (!DEEPGRAM_API_KEY) {
  console.error('Missing DEEPGRAM_API_KEY in environment variables');
  process.exit(1);
}

const deepgram = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      })
    : null;

if (!supabase) {
  console.warn('[Supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; archive persistence disabled');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function deepSeekChatCompletions(body, { timeoutMs = 20000, maxAttempts = 2 } = {}) {
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetchWithTimeout(
        DEEPSEEK_CHAT_COMPLETIONS_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify(body),
        },
        timeoutMs
      );

      if (res.ok) {
        return await res.json();
      }

      const status = res.status;
      const errText = await res.text().catch(() => '');
      const transient = status === 429 || (status >= 500 && status <= 599);

      if (!transient || attempt === maxAttempts) {
        throw new Error(`[DeepSeek] HTTP ${status} ${errText}`);
      }

      const backoffMs = 200 * attempt + Math.floor(Math.random() * 150);
      await sleep(backoffMs);
    } catch (err) {
      lastErr = err;

      if (attempt === maxAttempts) {
        throw err;
      }

      const isAbort = String(err?.name || '').toLowerCase().includes('abort');
      if (isAbort) {
        const backoffMs = 200 * attempt + Math.floor(Math.random() * 150);
        await sleep(backoffMs);
        continue;
      }

      const backoffMs = 200 * attempt + Math.floor(Math.random() * 150);
      await sleep(backoffMs);
    }
  }

  throw lastErr || new Error('[DeepSeek] unknown error');
}

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

const baseGlossary = readJson(path.join(resourcesDir, 'glossary.json'), []);
const generatedGlossary = readJson(path.join(resourcesDir, 'glossary.generated.json'), []);
const generatedCorrectionsPath = path.join(resourcesDir, 'corrections.generated.json');
let generatedCorrections = readJson(generatedCorrectionsPath, []);
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
const mantraResources = readJson(path.join(resourcesDir, 'mantras.json'), []);

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
  `[Resources] glossary=${generatedGlossary.length} corrections=${generatedCorrections.length} phrases=${generatedPhrases.length} deities=${generatedDeities.length} phonetic=${generatedPhoneticCorrections.length} tbsTerms=${generatedTbsTerms.length} sacredNames=${generatedSacredNames.length} ceremonyPhrases=${generatedCeremonyPhrases.length} mantras=${mantraResources.length} sacredEntities=${sacredEntities.length} phraseMemory=${phraseMemory.length} ceremonyMemory=${ceremonyMemory.length} correctionMemory=${correctionMemory.length} idGlossary=${Object.keys(glossaryIdEn).length} idPhraseMemory=${phraseMemoryId.length} idCorrectionMemory=${correctionMemoryId.length} idHotwords=${hotwordsId.length}`
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

function warnSupabaseFailure(label, err) {
  const message = err?.message || String(err || 'unknown error');
  console.warn(`[Supabase] ${label} failed: ${message}`);
}

function escapeMarkdown(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/([*_`#[\]])/g, '\\$1');
}

function formatExportDate(value) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function safeExportFilename(value) {
  return (
    String(value || 'session-export')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '') || 'session-export'
  );
}

function persistLiveSession(session) {
  if (!supabase || !session?.id) return;

  const row = {
    session_id: session.id,
    title: session.title || session.sessionName || 'TBS Live Session',
    description: session.description || session.eventMode || '',
    event_mode: session.eventMode || session.description || 'Dharma Talk',
    translation_route:
      session.translationRoute ||
      deriveTranslationRoute(session.sourceLanguage, session.targetLanguage),
    source_language: session.sourceLanguage || 'Mandarin',
    target_language: session.targetLanguage || 'English',
    status: session.status || 'idle',
    created_at: session.createdAt || new Date().toISOString(),
    updated_at: session.updatedAt || new Date().toISOString(),
    ended_at: session.endedAt || null,
    deleted_at: session.deletedAt || null,
    created_by_email: session.createdByEmail || null,
  };

  supabase
    .from('live_sessions')
    .upsert(row, { onConflict: 'session_id' })
    .then(({ error }) => {
      if (error) warnSupabaseFailure('live_sessions upsert', error);
    })
    .catch((err) => warnSupabaseFailure('live_sessions upsert', err));
}

function persistSessionStatus(session, status, extra = {}) {
  if (!session) return;
  const now = new Date().toISOString();
  session.status = status;
  session.updatedAt = now;
  if (status === 'ended' && !session.endedAt) {
    session.endedAt = now;
  } else if (status === 'listening') {
    session.endedAt = null;
  }
  Object.assign(session, extra);
  persistLiveSession(session);
}

function persistSessionLine(session, line, routeKey, retrieval) {
  if (!supabase || !session?.id || !line) return;

  const row = {
    session_id: session.id,
    at: line.at || new Date().toISOString(),
    raw_source: line.rawCn || '',
    normalized_source: line.normalizedCn || '',
    english: line.en || '',
    translation_route: routeKey || session.translationRoute || 'zh_en',
    input_mode: line.inputMode || line.translationMeta?.inputMode || null,
    translation_meta: line.translationMeta || null,
    retrieval: retrieval || null,
  };

  supabase
    .from('session_lines')
    .insert(row)
    .then(({ error }) => {
      if (error) warnSupabaseFailure('session_lines insert', error);
    })
    .catch((err) => warnSupabaseFailure('session_lines insert', err));
}

function persistSessionBrainState(session) {
  if (!supabase || !session?.id) return;

  const brainState = ensureSessionBrainState(session);
  const brainStateHistory = Array.isArray(session.brainStateHistory)
    ? session.brainStateHistory.slice(0, 24)
    : [];
  const row = {
    session_id: session.id,
    brain_state: brainState,
    brain_state_history: brainStateHistory,
    rolling_summary: brainState.rollingSummary || '',
    rolling_intent: brainState.rollingIntent || '',
    rolling_topic: brainState.rollingTopic || '',
    rolling_doctrinal_theme: brainState.rollingDoctrinalTheme || '',
    rolling_ritual_context: brainState.rollingRitualContext || '',
    rolling_guidance: brainState.rollingGuidance || '',
    rolling_entities: brainState.rollingEntities || [],
    updated_at: brainState.rollingUpdatedAt || new Date().toISOString(),
  };

  supabase
    .from('session_brain_state')
    .upsert(row, { onConflict: 'session_id' })
    .then(({ error }) => {
      if (error) warnSupabaseFailure('session_brain_state upsert', error);
    })
    .catch((err) => warnSupabaseFailure('session_brain_state upsert', err));
}

function normalizePersistedBrainState(row = {}) {
  const jsonState =
    row.brain_state && typeof row.brain_state === 'object' ? row.brain_state : {};

  return {
    activeTopic: jsonState.activeTopic || null,
    activeTopicEn: jsonState.activeTopicEn || '',
    activeTopicType: jsonState.activeTopicType || null,
    activeTopicConfidence: jsonState.activeTopicConfidence || 0,
    lockedUntilLineCount: jsonState.lockedUntilLineCount || 0,
    lastTopics: Array.isArray(jsonState.lastTopics) ? jsonState.lastTopics : [],
    rollingSummary: jsonState.rollingSummary || row.rolling_summary || '',
    rollingIntent: jsonState.rollingIntent || row.rolling_intent || '',
    rollingTopic: jsonState.rollingTopic || row.rolling_topic || '',
    rollingDoctrinalTheme:
      jsonState.rollingDoctrinalTheme || row.rolling_doctrinal_theme || '',
    rollingRitualContext: jsonState.rollingRitualContext || row.rolling_ritual_context || '',
    rollingGuidance: jsonState.rollingGuidance || row.rolling_guidance || '',
    rollingEntities: Array.isArray(jsonState.rollingEntities)
      ? jsonState.rollingEntities
      : Array.isArray(row.rolling_entities)
      ? row.rolling_entities
      : [],
    rollingUpdatedAt: jsonState.rollingUpdatedAt || row.updated_at || null,
    lastSummaryLineCount: jsonState.lastSummaryLineCount || 0,
    lastSummarySeq: jsonState.lastSummarySeq || jsonState.lastSummaryLineCount || 0,
  };
}

function normalizePersistedBrainStateHistory(row = {}) {
  const history = Array.isArray(row.brain_state_history) ? row.brain_state_history : [];

  return history
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: String(entry.id || `${entry.rollingUpdatedAt || Date.now()}-${entry.rollingTopic || ''}-${entry.rollingIntent || ''}`),
      rollingSummary: entry.rollingSummary || '',
      rollingIntent: entry.rollingIntent || '',
      rollingTopic: entry.rollingTopic || '',
      rollingDoctrinalTheme: entry.rollingDoctrinalTheme || '',
      rollingRitualContext: entry.rollingRitualContext || '',
      rollingGuidance: entry.rollingGuidance || '',
      rollingEntities: Array.isArray(entry.rollingEntities) ? entry.rollingEntities : [],
      rollingUpdatedAt: entry.rollingUpdatedAt || new Date().toISOString(),
      confidence: entry.confidence,
    }))
    .slice(0, 24);
}

function buildBrainStateHistoryEntry(brainState = {}, confidence) {
  if (!hasRollingBrainState(brainState)) return null;

  return {
    id: `${brainState.rollingUpdatedAt || Date.now()}-${brainState.rollingTopic || ''}-${brainState.rollingIntent || ''}`,
    rollingSummary: brainState.rollingSummary || '',
    rollingIntent: brainState.rollingIntent || '',
    rollingTopic: brainState.rollingTopic || '',
    rollingDoctrinalTheme: brainState.rollingDoctrinalTheme || '',
    rollingRitualContext: brainState.rollingRitualContext || '',
    rollingGuidance: brainState.rollingGuidance || '',
    rollingEntities: Array.isArray(brainState.rollingEntities) ? brainState.rollingEntities : [],
    rollingUpdatedAt: brainState.rollingUpdatedAt || new Date().toISOString(),
    confidence,
  };
}

function addBrainStateHistoryEntry(session, brainState, confidence) {
  if (!session) return [];

  const entry = buildBrainStateHistoryEntry(brainState, confidence);
  if (!entry) return Array.isArray(session.brainStateHistory) ? session.brainStateHistory : [];

  const current = Array.isArray(session.brainStateHistory) ? session.brainStateHistory : [];
  if (current[0]?.id === entry.id) return current;

  session.brainStateHistory = [entry, ...current].slice(0, 24);
  return session.brainStateHistory;
}

function hasRollingBrainState(brainState = {}) {
  return Boolean(
    brainState.rollingSummary ||
      brainState.rollingIntent ||
      brainState.rollingTopic ||
      brainState.rollingDoctrinalTheme ||
      brainState.rollingRitualContext ||
      brainState.rollingGuidance ||
      (Array.isArray(brainState.rollingEntities) && brainState.rollingEntities.length)
  );
}

function exposeRollingBrainState(session) {
  const brainState = session?.brainState || {};
  const brainStateHistory = Array.isArray(session?.brainStateHistory)
    ? session.brainStateHistory
    : [];
  return {
    ...session,
    brainState,
    brainStateHistory,
    brain_state_history: brainStateHistory,
    rollingSummary: brainState.rollingSummary || '',
    rollingIntent: brainState.rollingIntent || '',
    rollingTopic: brainState.rollingTopic || '',
    rollingDoctrinalTheme: brainState.rollingDoctrinalTheme || '',
    rollingRitualContext: brainState.rollingRitualContext || '',
    rollingGuidance: brainState.rollingGuidance || '',
    rollingEntities: Array.isArray(brainState.rollingEntities)
      ? brainState.rollingEntities
      : [],
  };
}

async function hydrateSessionBrainState(session) {
  if (!supabase || !session?.id) return session?.brainState || null;

  try {
    const { data, error } = await supabase
      .from('session_brain_state')
      .select('*')
      .eq('session_id', session.id)
      .maybeSingle();

    if (error) {
      warnSupabaseFailure('session_brain_state fetch', error);
      return session.brainState || null;
    }

    if (!data) return session.brainState || null;

    const persistedBrainState = normalizePersistedBrainState(data);
    const currentBrainState = ensureSessionBrainState(session);

    if (!hasRollingBrainState(currentBrainState) || data.updated_at) {
      session.brainState = {
        ...currentBrainState,
        ...persistedBrainState,
      };
      repairStaleLastSummarySeq(session.brainState, session, session.id);
    }

    const persistedBrainStateHistory = normalizePersistedBrainStateHistory(data);
    if (persistedBrainStateHistory.length) {
      session.brainStateHistory = persistedBrainStateHistory;
    } else if (!Array.isArray(session.brainStateHistory)) {
      session.brainStateHistory = [];
    }

    return session.brainState;
  } catch (err) {
    warnSupabaseFailure('session_brain_state fetch', err);
    return session.brainState || null;
  }
}

function summarizeBrainStateForExport(brainState = {}) {
  if (!hasRollingBrainState(brainState)) {
    return ['## Live Context', '', 'No live context captured.', ''];
  }

  const entities = Array.isArray(brainState.rollingEntities)
    ? brainState.rollingEntities.filter(Boolean).join(', ')
    : '';

  return [
    '## Live Context',
    '',
    `- Topic: ${escapeMarkdown(brainState.rollingTopic || '')}`,
    `- Intent: ${escapeMarkdown(brainState.rollingIntent || '')}`,
    `- Doctrinal theme: ${escapeMarkdown(brainState.rollingDoctrinalTheme || '')}`,
    `- Ritual context: ${escapeMarkdown(brainState.rollingRitualContext || '')}`,
    `- Guidance: ${escapeMarkdown(brainState.rollingGuidance || '')}`,
    `- Entities: ${escapeMarkdown(entities)}`,
    `- Summary: ${escapeMarkdown(brainState.rollingSummary || '')}`,
    '',
  ];
}

async function getSessionExportData(id) {
  if (!supabase) {
    const err = new Error('Supabase export storage is not configured.');
    err.statusCode = 503;
    throw err;
  }

  const { data: persistedSession, error: sessionError } = await supabase
    .from('live_sessions')
    .select('*')
    .eq('session_id', id)
    .maybeSingle();

  if (sessionError) {
    warnSupabaseFailure('live_sessions export fetch', sessionError);
    const err = new Error('Unable to export session.');
    err.statusCode = 500;
    throw err;
  }

  const memorySession = sessions.find((s) => s.id === id);
  const session = persistedSession || (memorySession ? summarizeSession(memorySession) : null);

  if (!session || session.deleted_at || session.deletedAt) {
    const err = new Error('Session not found.');
    err.statusCode = 404;
    throw err;
  }

  const { data: lines = [], error: linesError } = await supabase
    .from('session_lines')
    .select('*')
    .eq('session_id', id)
    .order('at', { ascending: true });

  if (linesError) {
    warnSupabaseFailure('session_lines export fetch', linesError);
    const err = new Error('Unable to export session lines.');
    err.statusCode = 500;
    throw err;
  }

  const { data: persistedBrainState, error: brainStateError } = await supabase
    .from('session_brain_state')
    .select('*')
    .eq('session_id', id)
    .maybeSingle();

  if (brainStateError) {
    warnSupabaseFailure('session_brain_state export fetch', brainStateError);
  }

  const sourceLanguage = session.source_language || session.sourceLanguage || 'Mandarin';
  const targetLanguage = session.target_language || session.targetLanguage || 'English';
  const brainState = persistedBrainState
    ? normalizePersistedBrainState(persistedBrainState)
    : memorySession?.brainState || null;

  return {
    id,
    title: session.title || session.sessionName || session.session_id || session.sessionId || id,
    description: session.description || session.event_mode || session.eventMode || '',
    sourceLanguage,
    targetLanguage,
    translationRoute:
      session.translation_route ||
      session.translationRoute ||
      deriveTranslationRoute(sourceLanguage, targetLanguage),
    status: session.status || 'idle',
    createdAt: session.created_at || session.createdAt,
    endedAt: session.ended_at || session.endedAt,
    brainState,
    lines,
  };
}

function renderSessionMarkdown(exportData) {
  const {
    title,
    description,
    sourceLanguage,
    targetLanguage,
    translationRoute,
    status,
    createdAt,
    endedAt,
    brainState,
    lines,
  } = exportData;

  return [
    `# ${escapeMarkdown(title)}`,
    '',
    description ? `**Description:** ${escapeMarkdown(description)}` : null,
    `**Language:** ${escapeMarkdown(sourceLanguage)} -> ${escapeMarkdown(targetLanguage)}`,
    `**Route:** ${escapeMarkdown(translationRoute)}`,
    `**Status:** ${escapeMarkdown(status)}`,
    `**Created:** ${escapeMarkdown(formatExportDate(createdAt))}`,
    `**Ended:** ${escapeMarkdown(formatExportDate(endedAt))}`,
    '',
    ...summarizeBrainStateForExport(brainState),
    '## Transcript',
    '',
    ...(lines.length
      ? lines.flatMap((line, index) => {
          const source = line.normalized_source || line.raw_source || '';
          const rawSource = line.raw_source && line.raw_source !== source ? line.raw_source : '';
          return [
            `### ${index + 1}. ${escapeMarkdown(formatExportDate(line.at))}`,
            '',
            '**Source**',
            '',
            source ? escapeMarkdown(source) : '_No source text recorded._',
            rawSource ? '' : null,
            rawSource ? `Raw source: ${escapeMarkdown(rawSource)}` : null,
            '',
            '**English**',
            '',
            line.english ? escapeMarkdown(line.english) : '_No English translation recorded._',
            '',
          ].filter((part) => part !== null);
        })
      : ['_No transcript lines were recorded for this session._', '']),
  ]
    .filter((part) => part !== null)
    .join('\n');
}

function docParagraph(text = '', options = {}) {
  return new Paragraph({
    ...options,
    children: [new TextRun(String(text || ''))],
  });
}

function labeledDocParagraph(label, value) {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: `, bold: true }),
      new TextRun(String(value || '')),
    ],
  });
}

async function renderSessionDocx(exportData) {
  const {
    title,
    description,
    sourceLanguage,
    targetLanguage,
    translationRoute,
    status,
    createdAt,
    endedAt,
    brainState,
    lines,
  } = exportData;

  const entities = Array.isArray(brainState?.rollingEntities)
    ? brainState.rollingEntities.filter(Boolean).join(', ')
    : '';
  const liveContextChildren = hasRollingBrainState(brainState)
    ? [
        labeledDocParagraph('Topic', brainState.rollingTopic || ''),
        labeledDocParagraph('Intent', brainState.rollingIntent || ''),
        labeledDocParagraph('Doctrinal theme', brainState.rollingDoctrinalTheme || ''),
        labeledDocParagraph('Ritual context', brainState.rollingRitualContext || ''),
        labeledDocParagraph('Guidance', brainState.rollingGuidance || ''),
        labeledDocParagraph('Entities', entities),
        labeledDocParagraph('Summary', brainState.rollingSummary || ''),
      ]
    : [docParagraph('No live context captured.')];

  const transcriptChildren = lines.length
    ? lines.flatMap((line, index) => {
        const source = line.normalized_source || line.raw_source || '';
        const rawSource = line.raw_source && line.raw_source !== source ? line.raw_source : '';
        return [
          docParagraph(`${index + 1}. ${formatExportDate(line.at)}`, {
            heading: HeadingLevel.HEADING_3,
          }),
          labeledDocParagraph('Source', source || 'No source text recorded.'),
          rawSource ? labeledDocParagraph('Raw source', rawSource) : null,
          labeledDocParagraph('English', line.english || 'No English translation recorded.'),
          docParagraph(''),
        ].filter(Boolean);
      })
    : [docParagraph('No transcript lines were recorded for this session.')];

  const doc = new Document({
    sections: [
      {
        children: [
          docParagraph(title, { heading: HeadingLevel.TITLE }),
          description ? labeledDocParagraph('Description', description) : null,
          labeledDocParagraph('Language', `${sourceLanguage} -> ${targetLanguage}`),
          labeledDocParagraph('Route', translationRoute),
          labeledDocParagraph('Status', status),
          labeledDocParagraph('Created', formatExportDate(createdAt)),
          labeledDocParagraph('Ended', formatExportDate(endedAt)),
          docParagraph('Live Context', { heading: HeadingLevel.HEADING_1 }),
          ...liveContextChildren,
          docParagraph('Transcript', { heading: HeadingLevel.HEADING_1 }),
          ...transcriptChildren,
        ].filter(Boolean),
      },
    ],
  });

  return Packer.toBuffer(doc);
}

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

function getDeepgramVocabularyOptions(routeConfig) {
  const hotwords = Array.isArray(routeConfig?.hotwords)
    ? routeConfig.hotwords.filter(Boolean)
    : [];
  const mantraKeyterms = getMantraDeepgramKeyterms();
  const combinedHotwords = sanitizeDeepgramKeyterms([...hotwords, ...mantraKeyterms]);
  if (!combinedHotwords.length) return {};

  console.log('[Deepgram] keyterms count=' + combinedHotwords.length, {
    routeKey: routeConfig?.key || 'unknown',
  });

  const model = String(DEEPGRAM_MODEL || '').toLowerCase();

  // Nova-3 uses keyterm prompting instead of keywords.
  if (model.startsWith('nova-3')) {
    return { keyterm: combinedHotwords };
  }

  return { keywords: combinedHotwords };
}


function applySessionMetadata(session, metadata = {}) {
  if (!session || !metadata || typeof metadata !== 'object') return session;

  if (metadata.title !== undefined || metadata.sessionName !== undefined) {
    session.title = metadata.title || metadata.sessionName || session.title;
  }
  if (metadata.description !== undefined || metadata.eventMode !== undefined) {
    const description = metadata.description ?? metadata.eventMode;
    session.description = description || session.description || '';
    session.eventMode = metadata.eventMode || description || session.eventMode;
  }
  if (metadata.sourceLanguage !== undefined) {
    session.sourceLanguage = metadata.sourceLanguage || session.sourceLanguage;
  }
  if (metadata.targetLanguage !== undefined) {
    session.targetLanguage = metadata.targetLanguage || session.targetLanguage;
  }
  if (metadata.translationRoute !== undefined || metadata.routeKey !== undefined) {
    session.translationRoute = metadata.translationRoute || metadata.routeKey || session.translationRoute;
  }
  if (metadata.status !== undefined) {
    session.status = metadata.status || session.status;
  }
  if (metadata.createdByEmail !== undefined || metadata.created_by_email !== undefined) {
    session.createdByEmail = metadata.createdByEmail || metadata.created_by_email || session.createdByEmail;
  }

  return session;
}

function getOrCreateSession(id = 'live-session', metadata = {}) {
  let session = sessions.find((s) => s.id === id);

  if (!session) {
    const now = new Date().toISOString();
    session = {
      id,
      title: 'TBS Live Session',
      description: 'Dharma Talk',
      eventMode: 'Dharma Talk',
      sourceLanguage: 'Mandarin',
      targetLanguage: 'English',
      translationRoute: 'zh_en',
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      endedAt: null,
      deletedAt: null,
      createdByEmail: null,
      totalFinalLinesSeen: 0,
      lines: [],
      brainStateHistory: [],
      brainState: {
        activeTopic: null,
        activeTopicEn: null,
        activeTopicType: null,
        activeTopicConfidence: 0,
        lockedUntilLineCount: 0,
        lastTopics: [],
        rollingSummary: '',
        rollingIntent: '',
        rollingTopic: '',
        rollingDoctrinalTheme: '',
        rollingRitualContext: '',
        rollingGuidance: '',
        rollingEntities: [],
        rollingUpdatedAt: null,
        lastSummaryLineCount: 0,
        lastSummarySeq: 0,
      },
    };
    sessions.unshift(session);
  }

  applySessionMetadata(session, metadata);
  persistLiveSession(session);

  return session;
}

function summarizeSession(session) {
  const lines = Array.isArray(session?.lines) ? session.lines : [];
  return {
    sessionId: session?.id || 'live-session',
    title: session?.title || 'TBS Live Session',
    description: session?.description || session?.eventMode || 'Dharma Talk',
    eventMode: session?.eventMode || 'Dharma Talk',
    sourceLanguage: session?.sourceLanguage || 'Mandarin',
    targetLanguage: session?.targetLanguage || 'English',
    translationRoute:
      session?.translationRoute ||
      deriveTranslationRoute(session?.sourceLanguage, session?.targetLanguage),
    createdAt: session?.createdAt || null,
    updatedAt: session?.updatedAt || lines[0]?.at || session?.createdAt || null,
    endedAt: session?.endedAt || null,
    deletedAt: session?.deletedAt || null,
    status: session?.status || 'idle',
    lineCount: lines.length,
  };
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
      rollingSummary: '',
      rollingIntent: '',
      rollingTopic: '',
      rollingDoctrinalTheme: '',
      rollingRitualContext: '',
      rollingGuidance: '',
      rollingEntities: [],
      rollingUpdatedAt: null,
      lastSummaryLineCount: 0,
      lastSummarySeq: 0,
    };
  }

  if (!Array.isArray(session.brainStateHistory)) {
    session.brainStateHistory = [];
  }

  return session.brainState;
}

function getSessionLineCount(session) {
  return Array.isArray(session?.lines) ? session.lines.length : 0;
}

function getSessionTotalFinalLinesSeen(session) {
  if (!session) return 0;
  if (!Number.isFinite(Number(session.totalFinalLinesSeen))) {
    session.totalFinalLinesSeen = getSessionLineCount(session);
  }
  return Number(session.totalFinalLinesSeen) || 0;
}

function addFinalLineToSession(session, line) {
  if (!session || !line) return;
  session.totalFinalLinesSeen = getSessionTotalFinalLinesSeen(session) + 1;
  line.seq = session.totalFinalLinesSeen;
  session.lines.unshift(line);
  session.lines = session.lines.slice(0, 100);
  session.updatedAt = line.at;
}

function repairStaleLastSummarySeq(brainState, session, sessionId = 'live-session') {
  if (!brainState) return 0;

  const totalFinalLinesSeen = getSessionTotalFinalLinesSeen(session);
  const currentBufferLength = getSessionLineCount(session);
  const previousLastSummarySeq =
    Number(brainState.lastSummarySeq ?? brainState.lastSummaryLineCount ?? 0) || 0;

  if (previousLastSummarySeq <= totalFinalLinesSeen) {
    brainState.lastSummarySeq = Math.max(0, previousLastSummarySeq);
    return brainState.lastSummarySeq;
  }

  const repairedLastSummarySeq = Math.max(0, totalFinalLinesSeen - currentBufferLength);
  brainState.lastSummarySeq = repairedLastSummarySeq;

  console.log('[RollingContext] repaired stale lastSummarySeq', {
    sessionId,
    previousLastSummarySeq,
    repairedLastSummarySeq,
    totalFinalLinesSeen,
  });

  return repairedLastSummarySeq;
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

  const lineCount = getSessionTotalFinalLinesSeen(session);
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

const MANTRA_REQUIRED_TRIGGERS = new Set([
  'om',
  'ah',
  'guru',
  'lian',
  'liansheng',
  'sheng',
  'seng',
  'siddhi',
  'siti',
  'city',
  'hom',
  'hum',
  'hung',
  'hong',
  'mani',
  'padme',
  'peme',
  'cundi',
  'chundi',
  'cale',
  'cule',
  'chale',
  'chule',
  'svaha',
  'soha',
  'amitabha',
  'amitaba',
  'ami',
  'dewa',
  'deva',
  'hrih',
  'hri',
  'tayata',
  'tayatha',
  'tadyatha',
  'bekandze',
  'bekanze',
  'bhekandze',
  'radza',
  'samudgate',
  'mahapratisara',
  'pratisare',
  'pratisara',
  'vajrini',
  'dhari',
  'phat',
  'vajrapani',
  'bo',
  'ru',
  'lan',
  'zhe',
  'li',
  'boru',
  'lanzheli',
  'baru',
  'bolu',
  'prelancri',
  'prelanci',
  'berilansri',
  'namo',
  'gulu',
  'bei',
  'buda',
  'budaye',
  'damo',
  'damoye',
  'sengjia',
  'sengjiaye',
  'sharwa',
  'sarwa',
  'yidamu',
  'zhala',
  'niliye',
  'dayemi',
]);

const MANTRA_CONTEXT_TRIGGERS = new Set([
  'guru',
  'lian',
  'liansheng',
  'sheng',
  'seng',
  'siddhi',
  'siti',
  'city',
  'hom',
  'hum',
  'hung',
  'hong',
  'mani',
  'padme',
  'peme',
  'cundi',
  'chundi',
  'cale',
  'cule',
  'chale',
  'chule',
  'svaha',
  'soha',
  'amitabha',
  'amitaba',
  'ami',
  'dewa',
  'deva',
  'hrih',
  'hri',
  'tayata',
  'tayatha',
  'tadyatha',
  'bekandze',
  'bekanze',
  'bhekandze',
  'radza',
  'samudgate',
  'mahapratisara',
  'pratisare',
  'pratisara',
  'vajrini',
  'dhari',
  'phat',
  'vajrapani',
  'bo',
  'ru',
  'lan',
  'zhe',
  'li',
  'boru',
  'lanzheli',
  'baru',
  'bolu',
  'prelancri',
  'prelanci',
  'berilansri',
  'namo',
  'gulu',
  'bei',
  'buda',
  'budaye',
  'damo',
  'damoye',
  'sengjia',
  'sengjiaye',
  'sharwa',
  'sarwa',
  'yidamu',
  'zhala',
  'niliye',
  'dayemi',
]);

const MANTRA_SYLLABLE_KEYTERMS = [
  'Om',
  'Ah',
  'Hom',
  'Hum',
  'Guru',
  'Lian Sheng',
  'Siddhi',
  'Padme',
  'Cundi',
  'Amitabha',
  'Bo Ru Lan Zhe Li',
  'Vajrapani',
];

const MANDARIN_ROUTE_MANTRA_FALLBACK_TRIGGERS = new Set([
  'om',
  'ah',
  'hom',
  'hum',
  'guru',
  'lian',
  'sheng',
  'siddhi',
  'prelancri',
  'prelanci',
  'berilansri',
  'boru',
  'lanzheli',
  'vajrapani',
]);

function getMantraDeepgramKeyterms() {
  return MANTRA_SYLLABLE_KEYTERMS;
}

function sanitizeDeepgramKeyterms(terms = []) {
  const seen = new Set();
  const out = [];

  for (const term of terms) {
    const clean = normalizeSpaces(term);
    if (!clean || clean.length > 40) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 20) break;
  }

  return out;
}

function normalizeMantraCandidate(text = '') {
  return normalizeSpaces(
    String(text || '')
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ')
  );
}

function getMantraTokens(text = '') {
  return normalizeMantraCandidate(text).split(' ').filter(Boolean);
}

function hasMantraTrigger(text = '') {
  const tokens = getMantraTokens(text);
  if (!tokens.length) return false;
  const hasOm = tokens.includes('om');
  const hasChineseSeedSyllable = /(?:嗡|唵|吽)/.test(text);
  const contextualHits = tokens.filter((token) => MANTRA_CONTEXT_TRIGGERS.has(token)).length;
  return hasOm || hasChineseSeedSyllable || contextualHits >= 2;
}

function hasStrongMantraTrigger(text = '') {
  const tokens = getMantraTokens(text);
  if (!tokens.length) return false;
  const hasOm = tokens.includes('om');
  const hasChineseSeedSyllable = /(?:嗡|唵|吽)/.test(text);
  const contextualHits = tokens.filter((token) => MANTRA_CONTEXT_TRIGGERS.has(token)).length;
  if (hasChineseSeedSyllable) return true;
  return hasOm ? contextualHits >= 1 : contextualHits >= 3;
}

function hasMandarinRouteMantraFallbackTrigger(text = '') {
  const tokens = getMantraTokens(text);
  if (tokens.length === 0 || tokens.length > 8) return false;
  const hits = tokens.filter((token) => MANDARIN_ROUTE_MANTRA_FALLBACK_TRIGGERS.has(token)).length;
  return tokens.includes('om') ? hits >= 1 : hits >= 2;
}

function levenshteinDistance(a = '', b = '') {
  const aa = String(a || '');
  const bb = String(b || '');
  if (aa === bb) return 0;
  if (!aa) return bb.length;
  if (!bb) return aa.length;

  const prev = Array.from({ length: bb.length + 1 }, (_, idx) => idx);
  const curr = new Array(bb.length + 1);

  for (let i = 1; i <= aa.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= bb.length; j += 1) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= bb.length; j += 1) prev[j] = curr[j];
  }

  return prev[bb.length];
}

function mantraSimilarity(a = '', b = '') {
  const aa = normalizeMantraCandidate(a);
  const bb = normalizeMantraCandidate(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) {
    const ratio = Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length);
    return Math.max(0.88, ratio);
  }
  const maxLen = Math.max(aa.length, bb.length);
  return maxLen ? 1 - levenshteinDistance(aa, bb) / maxLen : 0;
}

function getMantraAliases(mantra = {}) {
  const aliases = [
    mantra.canonical,
    mantra.display,
    ...(mantra.aliases || []),
    ...(mantra.asr_variants || []),
    ...(mantra.asrVariants || []),
    ...(mantra.chinese || []),
    ...(mantra.pinyin || []),
  ].filter(Boolean);

  const expanded = [];
  for (const alias of aliases) {
    const normalized = normalizeMantraCandidate(alias);
    if (!normalized) continue;
    expanded.push(normalized);
    if (normalized.startsWith('om ')) {
      expanded.push(normalized.replace(/^om\s+/, ''));
    }
  }

  return [...new Set(expanded)];
}

function findBestMantraMatch(text = '', { allowContextCarry = false, routeKey = 'zh_en' } = {}) {
  const candidate = normalizeMantraCandidate(text);
  const allowMandarinFallback =
    routeKey === 'zh_en' && hasMandarinRouteMantraFallbackTrigger(candidate);
  if (!candidate || (!hasMantraTrigger(candidate) && !allowContextCarry && !allowMandarinFallback)) {
    return null;
  }

  let best = null;

  for (const mantra of Array.isArray(mantraResources) ? mantraResources : []) {
    if (mantra?.placeholder) continue;
    if (!mantra?.canonical || mantra.preserve === false) continue;
    for (const alias of getMantraAliases(mantra)) {
      const confidence = mantraSimilarity(candidate, alias);
      if (!best || confidence > best.confidence) {
        best = {
          id: mantra.id || mantra.canonical,
          canonical: mantra.canonical,
          deity: mantra.deity || '',
          confidence,
          matchedText: text,
        };
      }
    }
  }

  if (!best) return null;
  const threshold = getMantraTokens(candidate).includes('om') ? 0.78 : 0.84;
  const effectiveThreshold = allowMandarinFallback ? Math.min(threshold, 0.72) : threshold;
  if (allowContextCarry && best.confidence >= 0.9) return best;
  if (allowMandarinFallback && best.confidence >= effectiveThreshold) return best;
  if (best.confidence < effectiveThreshold || !hasStrongMantraTrigger(candidate)) return null;
  return best;
}

function normalizeRepeatedMantraText(original = '', { routeKey = 'zh_en', mode = 'final' } = {}) {
  const trimmed = normalizeSpaces(original);
  if (!/[，,;；]/.test(trimmed)) return null;

  const rawSegments = trimmed
    .split(/([，,;；]+)/)
    .filter((segment) => segment && !/^[，,;；]+$/.test(segment))
    .map((segment) => normalizeSpaces(segment));

  if (rawSegments.length < 2 || rawSegments.length > 7) return null;

  const matches = [];
  let canonical = '';

  for (let idx = 0; idx < rawSegments.length; idx += 1) {
    const match = findBestMantraMatch(rawSegments[idx], {
      allowContextCarry: idx > 0 && Boolean(canonical),
      routeKey,
    });

    if (!match) return null;
    if (!canonical) canonical = match.canonical;
    if (match.canonical !== canonical) return null;
    matches.push({ ...match, pure: true, repeated: true });
  }

  if (!matches.length || !canonical) return null;

  const output = `${matches.map(() => canonical).join(', ')}.`;
  const bestConfidence = Math.min(...matches.map((match) => match.confidence || 0));

  console.log('[MantraMatch] detected', {
    id: matches[0].id,
    canonical,
    confidence: Number(bestConfidence.toFixed(3)),
    routeKey,
    mode,
  });

  return {
    text: output,
    matches,
    pureMantra: true,
  };
}

function findBestMantraSegment(text = '', { routeKey = 'zh_en' } = {}) {
  const tokens = getMantraTokens(text);
  if (tokens.length < 2) return null;

  let best = null;
  const maxWindow = Math.min(8, tokens.length);

  for (let start = 0; start < tokens.length; start += 1) {
    for (let end = start + 2; end <= Math.min(tokens.length, start + maxWindow); end += 1) {
      const segment = tokens.slice(start, end).join(' ');
      if (!hasMantraTrigger(segment)) continue;
      const match = findBestMantraMatch(segment, { routeKey });
      if (match && (!best || match.confidence > best.confidence)) {
        best = { ...match, tokenStart: start, tokenEnd: end, segment };
      }
    }
  }

  return best;
}

function normalizeMantraText(text = '', { routeKey = 'zh_en', mode = 'final' } = {}) {
  const original = normalizeSpaces(text);
  if (!original) {
    return { text: original, matches: [], pureMantra: false };
  }

  const repeatedMantra = normalizeRepeatedMantraText(original, { routeKey, mode });
  if (repeatedMantra) return repeatedMantra;

  const wholeMatch = findBestMantraMatch(original, { routeKey });
  const originalTokens = getMantraTokens(original);
  const canonicalTokens = wholeMatch ? getMantraTokens(wholeMatch.canonical) : [];
  const pureMantra =
    Boolean(wholeMatch) &&
    originalTokens.length <= Math.max(8, canonicalTokens.length + 2) &&
    wholeMatch.confidence >= 0.8;

  if (pureMantra) {
    console.log('[MantraMatch] detected', {
      id: wholeMatch.id,
      canonical: wholeMatch.canonical,
      confidence: Number(wholeMatch.confidence.toFixed(3)),
      routeKey,
      mode,
    });

    return {
      text: wholeMatch.canonical,
      matches: [{ ...wholeMatch, pure: true }],
      pureMantra: true,
    };
  }

  const segmentMatch = findBestMantraSegment(original, { routeKey });
  if (!segmentMatch || segmentMatch.confidence < 0.86) {
    if (routeKey === 'zh_en' && hasMandarinRouteMantraFallbackTrigger(original)) {
      console.log('[MantraMatch] no match', {
        routeKey,
        mode,
        tokenCount: getMantraTokens(original).length,
      });
    }
    return { text: original, matches: [], pureMantra: false };
  }

  const tokens = original.split(/\s+/);
  const normalizedTokens = getMantraTokens(original);
  if (tokens.length !== normalizedTokens.length) {
    return {
      text: `${original} ${segmentMatch.canonical}`,
      matches: [{ ...segmentMatch, pure: false }],
      pureMantra: false,
    };
  }

  tokens.splice(segmentMatch.tokenStart, segmentMatch.tokenEnd - segmentMatch.tokenStart, segmentMatch.canonical);
  const nextText = normalizeSpaces(tokens.join(' '));

  console.log('[MantraMatch] detected', {
    id: segmentMatch.id,
    canonical: segmentMatch.canonical,
    confidence: Number(segmentMatch.confidence.toFixed(3)),
    routeKey,
    mode,
  });

  return {
    text: nextText,
    matches: [{ ...segmentMatch, pure: false }],
    pureMantra: false,
  };
}

function titleCaseMantraCategory(category = '') {
  return normalizeSpaces(category)
    .split(/\s+/)
    .map((word) => {
      if (!word) return '';
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function buildMantraLabelEnglish(mantra = {}) {
  const category = titleCaseMantraCategory(mantra.category || 'Mantra');
  const deity = normalizeSpaces(mantra.deity || '');
  if (!deity) return category || '';

  const deityPrimary = deity.split('/')[0].trim();
  if (!category || category.toLowerCase() === 'mantra') {
    return `${deityPrimary} Mantra`;
  }

  const categoryLower = category.toLowerCase();
  if (categoryLower.includes(deityPrimary.toLowerCase())) return category;
  if (/^(four refuge|offering|mantra of light|seed syllables)/i.test(category)) return category;
  return `${deityPrimary} ${category}`;
}

function findMantraLabelTranslation(text = '') {
  const normalized = normalizeSpaces(text);
  if (!normalized || !/[\u3400-\u9fff]/.test(normalized)) return null;
  if (!/(咒|心咒|陀羅尼|真言)$/.test(normalized)) return null;

  for (const mantra of Array.isArray(mantraResources) ? mantraResources : []) {
    if (!mantra || mantra.placeholder || mantra.preserve === false) continue;
    const chineseTerms = []
      .concat(mantra.chinese || [])
      .concat(mantra.associated_terms || [])
      .concat(mantra.associatedTerms || [])
      .filter((term) => /[\u3400-\u9fff]/.test(String(term || '')))
      .map((term) => normalizeSpaces(term));

    for (const term of chineseTerms) {
      if (!term) continue;
      if (normalized === term || normalized === `${term}咒` || normalized === `${term}心咒`) {
        const english = buildMantraLabelEnglish(mantra);
        if (english) {
          return {
            id: mantra.id || '',
            canonical: mantra.canonical || '',
            english,
          };
        }
      }
    }
  }

  return null;
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
  rollingContext = null,
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

    const correctionOverride = findGeneratedTranslationCorrection(trimmed, mode);
    if (correctionOverride?.canOverride && correctionOverride?.correctedEnglish) {
      translatedSegments.push(correctionOverride.correctedEnglish);
      continue;
    }

    const segmentHits = applyGlossary(trimmed);
    const segmentRetrieval = {
      sacredEntities: retrieveSacredEntities(trimmed, eventMode),
      phraseMatches: retrievePhraseMemory(trimmed, eventMode),
      ceremonyMatches: retrieveCeremonyMemory(trimmed, eventMode),
      correctionMatches: mergeGeneratedCorrectionMatch(
        correctionOverride,
        retrieveCorrectionMemory(trimmed, eventMode)
      ),
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
      activeTopic,
      routeKey,
      rollingContext
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

function getGeneratedTranslationCorrections() {
  return Array.isArray(generatedCorrections)
    ? generatedCorrections.filter((row) => row?.cn && row?.en)
    : [];
}

function toGeneratedCorrectionHit(row, score = 0, canOverride = false) {
  const cn = normalizeSpaces(row?.cn || '');
  const en = normalizeSpaces(row?.en || '');

  return {
    ...row,
    heard: cn,
    intendedChinese: cn,
    corrected: cn,
    correctedEnglish: en,
    source: row?.source || 'corrections.generated',
    canOverride,
    _score: score,
  };
}

function mergeGeneratedCorrectionMatch(generatedCorrection, matches = []) {
  if (!generatedCorrection) return matches || [];
  return [generatedCorrection, ...(matches || [])];
}

function findGeneratedTranslationCorrection(text, mode = 'final') {
  const normalized = normalizeSpaces(text);
  if (!normalized) return null;

  const rows = getGeneratedTranslationCorrections().sort(
    (a, b) => String(b.cn || '').length - String(a.cn || '').length
  );

  for (const row of rows) {
    const cn = normalizeSpaces(row.cn);
    if (cn && normalized === cn) {
      return toGeneratedCorrectionHit(row, 200, true);
    }
  }

  if (isShortFragment(normalized)) return null;

  const minLength = mode === 'interim' ? 14 : 10;
  for (const row of rows) {
    const cn = normalizeSpaces(row.cn);
    if (cn && cn.length >= minLength && normalized.includes(cn)) {
      return toGeneratedCorrectionHit(row, 120 + cn.length, false);
    }
  }

  return null;
}

function retrieveGeneratedTranslationCorrections(text) {
  const normalized = normalizeSpaces(text);
  if (!normalized) return [];

  return getGeneratedTranslationCorrections()
    .map((row) => {
      const cn = normalizeSpaces(row.cn);
      if (!cn) return null;
      if (normalized === cn) return toGeneratedCorrectionHit(row, 200, true);
      if (normalized.includes(cn)) return toGeneratedCorrectionHit(row, 120 + cn.length, false);
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b._score - a._score)
    .slice(0, retrievalConfig.top_correction_matches || 5);
}

function registerCorrection(cn, en) {
  const source = normalizeSpaces(cn);
  const target = normalizeSpaces(en);

  if (!source || !target) {
    return { ok: false, error: 'cn and en are required' };
  }

  const current = Array.isArray(generatedCorrections) ? generatedCorrections : [];
  const existing = current.find(
    (row) =>
      normalizeSpaces(row?.cn || '') === source &&
      normalizeSpaces(row?.en || '') === target
  );

  if (existing) {
    return { ok: true, row: existing, created: false };
  }

  const row = { cn: source, en: target };
  const next = [...current, row];

  if (!writeJson(generatedCorrectionsPath, next)) {
    return { ok: false, error: 'failed to write corrections.generated.json' };
  }

  generatedCorrections = next;
  return { ok: true, row, created: true };
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

  const results = [...retrieveGeneratedTranslationCorrections(normalized)];

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
    ...(Array.isArray(baseGlossary) ? baseGlossary : []),
    ...generatedGlossary,
    ...deityEntries,
    ...tbsEntries,
    ...sacredEntries,
    ...corpusEntries,
  ];

  const seen = new Set();
  const deduped = [];

  for (const entry of merged) {
    const key = String(entry?.cn || '');
    if (!entry?.cn || !entry?.en || seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

const canonicalGlossary = buildCanonicalGlossary();

function buildCompiledTbsTerminology() {
  const termLines = [];
  const seen = new Set();

  function addEntries(entries, label) {
    const lines = [];
    for (const entry of entries) {
      const cn = entry?.cn || '';
      const en = entry?.en || '';
      if (!cn || !en || seen.has(cn)) continue;
      seen.add(cn);
      lines.push(`  ${cn} → ${en}`);
    }
    if (lines.length > 0) {
      termLines.push(`${label} (${lines.length}):`);
      termLines.push(...lines);
    }
  }

  addEntries(canonicalGlossary, 'Glossary');
  addEntries(generatedDeities, 'Deities');
  addEntries(generatedSacredNames, 'Sacred Names');
  addEntries(generatedTbsTerms, 'TBS Terms');
  addEntries(sacredEntities, 'Sacred Entities');

  const mantraLines = [];
  const mantraSeen = new Set();
  for (const m of mantraResources) {
    const canonical = m?.canonical || m?.cn || '';
    const en = m?.en || m?.english || '';
    const label = m?.deity ? ` [${m.deity}]` : '';
    if (!canonical || mantraSeen.has(canonical)) continue;
    mantraSeen.add(canonical);
    mantraLines.push(`  ${canonical}${en ? ` → ${en}` : ''}${label} (preserve exactly)`);
  }
  if (mantraLines.length > 0) {
    termLines.push(`Mantras (${mantraLines.length}) — do not translate, preserve exactly:`);
    termLines.push(...mantraLines);
  }

  const topPhrases = (phraseMemory.concat(generatedPhrases))
    .filter((p) => p?.cn && p?.en)
    .slice(0, 100);
  const phraseLines = [];
  const phraseSeen = new Set();
  for (const p of topPhrases) {
    if (phraseSeen.has(p.cn)) continue;
    phraseSeen.add(p.cn);
    phraseLines.push(`  ${p.cn} → ${p.en}`);
  }
  if (phraseLines.length > 0) {
    termLines.push(`Key Phrases & Sutra Passages (${phraseLines.length}):`);
    termLines.push(...phraseLines);
  }

  return termLines.join('\n');
}

const compiledTbsTerminology = buildCompiledTbsTerminology();

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

function cleanTbsKnowledgeText(text = '', maxChars = 520) {
  const cleaned = normalizeSpaces(
    String(text || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[[^\]]{0,80}\]\([^)]{0,200}\)/g, ' ')
      .replace(/https?:\/\/\S+/gi, ' ')
  );

  if (!cleaned || cleaned.length < 80) return '';
  if ((cleaned.match(/[<>]/g) || []).length > 3) return '';

  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars).trim()}...` : cleaned;
}

function extractRollingContextText(rollingContext = null) {
  if (!rollingContext) return '';

  const entities = Array.isArray(rollingContext.rollingEntities || rollingContext.entities)
    ? (rollingContext.rollingEntities || rollingContext.entities).join(' ')
    : '';

  return [
    rollingContext.rollingSummary,
    rollingContext.summary,
    rollingContext.rollingTopic,
    rollingContext.topic,
    rollingContext.rollingDoctrinalTheme,
    rollingContext.doctrinal_theme,
    rollingContext.rollingRitualContext,
    rollingContext.ritual_context,
    rollingContext.rollingGuidance,
    rollingContext.guidance,
    entities,
  ]
    .filter(Boolean)
    .join(' ');
}

function buildTbsKnowledgeCandidateTerms({ sourceText = '', rollingContext = null } = {}) {
  const combined = normalizeSpaces(`${sourceText || ''} ${extractRollingContextText(rollingContext)}`);
  if (!combined) return [];

  const scored = new Map();
  const addTerm = (term, score = 1) => {
    const clean = normalizeSpaces(term);
    if (!clean || clean.length < 2 || clean.length > 80) return;
    if (/^\d+$/.test(clean)) return;
    scored.set(clean, Math.max(scored.get(clean) || 0, score));
  };

  const prioritizedRows = [
    ...sacredEntities,
    ...generatedDeities,
    ...generatedSacredNames,
    ...generatedTbsTerms,
  ];

  for (const row of prioritizedRows) {
    const terms = []
      .concat(row?.cn || [])
      .concat(row?.en || [])
      .concat(row?.aliases || [])
      .concat(row?.variants || [])
      .filter(Boolean);

    for (const term of terms) {
      const clean = normalizeSpaces(term);
      if (clean && combined.toLowerCase().includes(clean.toLowerCase())) {
        addTerm(clean, 80 + clean.length);
      }
    }
  }

  for (const term of PROTECTED_ENGLISH_TERMS) {
    if (combined.toLowerCase().includes(term.toLowerCase())) {
      addTerm(term, 60 + term.length);
    }
  }

  const englishTerms = combined.match(/\b[A-Z][A-Za-z][A-Za-z'’-]*(?:\s+[A-Z][A-Za-z][A-Za-z'’-]*){0,4}\b/g) || [];
  for (const term of englishTerms) {
    if (/^(The|This|That|These|Those|Then|When|Where|Why|How|And|But)$/i.test(term)) continue;
    addTerm(term, 35 + term.length);
  }

  const chineseTerms = combined.match(/[\u3400-\u9fff]{2,8}/g) || [];
  for (const term of chineseTerms) {
    addTerm(term, 40 + term.length);
  }

  const doctrinalKeywords = [
    'Buddha',
    'Bodhisattva',
    'Tara',
    'Vajra',
    'Guru',
    'mantra',
    'mudra',
    'homa',
    'empowerment',
    'refuge',
    'lineage',
    'True Buddha School',
    'Living Buddha Lian Sheng',
  ];

  for (const term of doctrinalKeywords) {
    if (combined.toLowerCase().includes(term.toLowerCase())) {
      addTerm(term, 45 + term.length);
    }
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 8)
    .map(([term]) => term);
}

function escapePostgrestLikeTerm(term = '') {
  return normalizeSpaces(term)
    .replace(/[,%()]/g, ' ')
    .replace(/[^\p{L}\p{N}\u3400-\u9fff _-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function scoreTbsKnowledgeRow(row = {}, terms = []) {
  const title = String(row.source_title || row.title || '').toLowerCase();
  const sourceKey = String(row.metadata?.source_key || row.source_key || '').toLowerCase();
  const chunk = String(row.chunk_text || '').toLowerCase();
  let score = Number(row.priority || 0);

  for (const term of terms) {
    const t = String(term || '').toLowerCase();
    if (!t) continue;
    if (title.includes(t)) score += 80 + t.length;
    if (sourceKey.includes(t)) score += 60 + t.length;
    if (chunk.includes(t)) score += 20 + Math.min(40, t.length);
  }

  return score;
}

function normalizeTbsKnowledgeRow(row = {}, terms = []) {
  const excerpt = cleanTbsKnowledgeText(row.chunk_text);
  if (!excerpt) return null;

  return {
    sourceTitle: normalizeSpaces(row.source_title || row.title || 'Official TBSN source'),
    sourceUrl: row.source_url || row.url || '',
    sourceKey: row.metadata?.source_key || row.source_key || '',
    excerpt,
    _score: scoreTbsKnowledgeRow(row, terms),
  };
}

async function retrieveTbsKnowledgeContext({ sourceText = '', rollingContext = null, routeKey = 'zh_en' } = {}) {
  if (!supabase) return [];

  const candidateTerms = buildTbsKnowledgeCandidateTerms({ sourceText, rollingContext });
  if (!candidateTerms.length) return [];

  const rows = [];
  const seenChunkKeys = new Set();
  const searchedTerms = candidateTerms.slice(0, 5);

  try {
    for (const term of searchedTerms) {
      const safeTerm = escapePostgrestLikeTerm(term);
      if (!safeTerm || safeTerm.length < 2) continue;

      const pattern = `%${safeTerm}%`;
      const { data: chunkRows = [], error: chunkError } = await supabase
        .from('tbs_knowledge_chunks')
        .select('chunk_key, chunk_text, source_title, source_url, category, priority, trust_level, metadata')
        .or(`chunk_text.ilike.${pattern},source_title.ilike.${pattern}`)
        .limit(6);

      if (chunkError) {
        warnSupabaseFailure('tbs_knowledge_chunks retrieval', chunkError);
        continue;
      }

      for (const row of chunkRows || []) {
        const key = row.chunk_key || `${row.source_url}|${row.chunk_text?.slice(0, 80)}`;
        if (!key || seenChunkKeys.has(key)) continue;
        seenChunkKeys.add(key);
        rows.push(row);
      }

      const { data: sourceRows = [], error: sourceError } = await supabase
        .from('tbs_sources')
        .select('id, source_key, title, url, priority')
        .or(`source_key.ilike.${pattern},title.ilike.${pattern}`)
        .limit(4);

      if (sourceError) {
        warnSupabaseFailure('tbs_sources retrieval', sourceError);
        continue;
      }

      const sourceIds = (sourceRows || []).map((row) => row.id).filter(Boolean);
      if (sourceIds.length > 0) {
        const { data: sourceChunkRows = [], error: sourceChunkError } = await supabase
          .from('tbs_knowledge_chunks')
          .select('chunk_key, chunk_text, source_title, source_url, category, priority, trust_level, metadata')
          .in('source_id', sourceIds)
          .order('chunk_index', { ascending: true })
          .limit(6);

        if (sourceChunkError) {
          warnSupabaseFailure('tbs_knowledge_chunks source retrieval', sourceChunkError);
          continue;
        }

        for (const row of sourceChunkRows || []) {
          const key = row.chunk_key || `${row.source_url}|${row.chunk_text?.slice(0, 80)}`;
          if (!key || seenChunkKeys.has(key)) continue;
          seenChunkKeys.add(key);
          rows.push(row);
        }
      }
    }

    const topRows = rows
      .map((row) => normalizeTbsKnowledgeRow(row, candidateTerms))
      .filter(Boolean)
      .sort((a, b) => b._score - a._score)
      .slice(0, TBS_KNOWLEDGE_MAX_CHUNKS);

    console.log('[TBSKnowledge] retrieval', {
      routeKey,
      candidateTerms,
      chunksFound: topRows.length,
      sourceTitles: topRows.map((row) => row.sourceTitle).filter(Boolean),
    });

    return topRows;
  } catch (err) {
    console.warn('[TBSKnowledge] retrieval failed', err.message);
    return [];
  }
}

function formatTbsKnowledgeContextBlock(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return '';

  const lines = [];
  let usedChars = 0;

  for (const row of rows) {
    const title = normalizeSpaces(row.sourceTitle || 'Official TBSN source');
    const excerptBudget = Math.max(160, Math.min(520, TBS_KNOWLEDGE_MAX_CONTEXT_CHARS - usedChars - title.length - 20));
    const excerpt = cleanTbsKnowledgeText(row.excerpt, excerptBudget);
    if (!excerpt) continue;

    const block = `- Source: ${title}\n  ${excerpt}`;
    if (usedChars + block.length > TBS_KNOWLEDGE_MAX_CONTEXT_CHARS && lines.length > 0) break;
    lines.push(block);
    usedChars += block.length;
  }

  if (!lines.length) return '';

  return `Relevant TBS knowledge context:\n${lines.join('\n')}\nUse only for context. Do not translate this context text.`;
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
  const mantraCount = (retrieval.mantraMatches || []).length;
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
  if (mantraCount > 0) score += Math.min(16, mantraCount * 8);
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
    mantraCount,
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
  rollingContext = null,
  routeKey = 'zh_en',
}) {
  function formatRollingContextBlock(ctx) {
    if (!ctx) return '';

    const guidance = String(ctx.rollingGuidance || ctx.guidance || '')
      .trim()
      .slice(0, 160);
    const doctrinalTheme = String(ctx.rollingDoctrinalTheme || ctx.doctrinal_theme || '').trim();
    const ritualContext = String(ctx.rollingRitualContext || ctx.ritual_context || '').trim();
    const topic = String(ctx.rollingTopic || ctx.topic || '').trim();
    const entities = Array.isArray(ctx.rollingEntities || ctx.entities)
      ? (ctx.rollingEntities || ctx.entities)
          .map((x) => String(x || '').trim())
          .filter(Boolean)
          .slice(0, 6)
      : [];

    if (!guidance && !doctrinalTheme && !entities.length && !ritualContext && !topic) {
      return '';
    }

    const entitiesLine = entities.length ? entities.join(', ') : '';

    return `
Rolling context (next 30–60s; subtle guidance, don’t overfit):
- Guidance: ${guidance}
- Doctrinal theme: ${doctrinalTheme}
- Key entities: ${entitiesLine}
- Ritual context: ${ritualContext}
- Topic: ${topic}`.trim();
  }

  const rollingBlock = formatRollingContextBlock(rollingContext);

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

  const mantraBlock =
    (retrieval.mantraMatches || []).length > 0
      ? retrieval.mantraMatches
          .map((x) => `${x.canonical}${x.deity ? ` [${x.deity}]` : ''} => preserve exactly; do not translate.`)
          .join('\n')
      : 'No mantra matches';

  const tbsKnowledgeBlock = formatTbsKnowledgeContextBlock(
    retrieval.tbsKnowledgeContext || retrieval.tbsKnowledgeChunks || []
  );

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

    const systemPrompt = mode === 'interim'
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
      : (
`
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
`.trim() +
(rollingBlock ? `\n\n${rollingBlock}\n` : '\n') +
`Event mode: ${eventMode}
Input mode: ${inputMode}`
      ).trim();

    const systemPromptWithRolling =
      mode === 'interim' && rollingBlock ? `${systemPrompt}\n\n${rollingBlock}` : systemPrompt;

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

Mantra matches:
${mantraBlock}

${tbsKnowledgeBlock}
`.trim();

    return { systemPrompt: systemPromptWithRolling, userPrompt };
  }

  const systemPrompt = mode === 'interim'
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
    : (
`
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
`.trim() +
(rollingBlock ? `\n\n${rollingBlock}\n` : '\n') +
`Event mode: ${eventMode}
Input mode: ${inputMode}`
    ).trim();

  const systemPromptWithRolling =
    mode === 'interim' && rollingBlock ? `${systemPrompt}\n\n${rollingBlock}` : systemPrompt;

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

Mantra matches:
${mantraBlock}

${tbsKnowledgeBlock}
`.trim();

  return { systemPrompt: systemPromptWithRolling, userPrompt };
}

function getContextWindow(session, limit = retrievalConfig.context_window_lines || 5) {
  if (!session || !Array.isArray(session.lines)) return [];
  return session.lines.slice(0, limit).map((line) => ({
    cn: line.normalizedCn || line.rawCn || '',
    en: line.en || '',
  }));
}

function getRecentFinalWindow(session, { maxLines = 8, maxAgeMs = 30000 } = {}) {
  if (!session || !Array.isArray(session.lines) || !session.lines.length) return [];

  const now = Date.now();
  const selected = [];

  for (const line of session.lines) {
    if (!line) continue;
    const atMs = line.at ? Date.parse(line.at) : NaN;
    if (Number.isFinite(atMs) && now - atMs > maxAgeMs) continue;

    selected.push(line);
    if (selected.length >= maxLines) break;
  }

  return selected.reverse();
}

function chooseRollingContextMode(session) {
  return {
    mode: 'standard',
    cooldownMs: ROLLING_CONTEXT_COOLDOWN_MS,
    minNewLines: ROLLING_CONTEXT_MIN_NEW_LINES,
    slowFallbackMs: ROLLING_CONTEXT_SLOW_FALLBACK_MS,
    slowFallbackMinLines: ROLLING_CONTEXT_SLOW_FALLBACK_MIN_LINES,
    maxLines: 24,
    maxAgeMs: 90000,
    minRecentLines: 5,
  };
}

function buildRollingContextPrompts({ lines = [], eventMode = 'Dharma Talk', routeKey = 'zh_en' }) {
  const transcriptBlock = lines
    .map((line, idx) => {
      const src = line.normalizedCn || line.rawCn || '';
      const en = line.en || '';
      return `${idx + 1}. SRC: ${src}\n   EN: ${en}`;
    })
    .join('\n');

  const sourceLabel = routeKey === 'id_en' ? 'Bahasa Indonesia' : 'Chinese';

  const systemPrompt = `
You are a live sermon context analyst for True Buddha School.
Read the recent finalized transcript window and produce a very short live context frame.
Return JSON only.
Use strict JSON with double-quoted keys.
Do not use markdown fences.
`.trim();

  const userPrompt = `
Event mode: ${eventMode}
Source language: ${sourceLabel}

Analyze this recent finalized live transcript window and return one JSON object with this exact shape:
{
  "summary": "1-2 sentence live summary of what the speaker is currently talking about",
  "intent": "short phrase describing speaker intent, such as doctrinal explanation / ritual guidance / exhortation / storytelling / prayer / instruction",
  "topic": "short current topic label",
  "doctrinal_theme": "short doctrinal theme label, like karma / refuge / empowerment / purification / bodhicitta / devotion / mantra / lineage / vows / bardo deliverance",
  "entities": ["up to 6 important proper nouns or TBS entities (deities, titles, places), English or Chinese as appropriate"],
  "ritual_context": "short label like Homa Ceremony / deliverance / refuge / empowerment / merit dedication, or empty string",
  "guidance": "one short sentence translation guidance for the next 30-60 seconds; prioritize TBS terminology and likely upcoming terms",
  "confidence": 0.0
}

Rules:
- summary should be concise and live-friendly
- intent should be short and clear
- topic should be compact, like a dashboard label
- doctrinal_theme should be compact and doctrinal (not verbose)
- entities must be a short array (0-6), no explanations
- ritual_context must be short, or empty string if not applicable
- guidance must be one short sentence, max ~160 chars
- confidence must be between 0 and 1
- base the output on the whole recent window, not one line only

Transcript window:
${transcriptBlock}
`.trim();

  return { systemPrompt, userPrompt };
}

async function summarizeRollingContext(lines, eventMode = 'Dharma Talk', routeKey = 'zh_en') {
  if (!Array.isArray(lines) || lines.length === 0) {
    return {
      summary: '',
      intent: '',
      topic: '',
      confidence: 0,
    };
  }

  if (!DEEPSEEK_API_KEY) {
    return {
      summary: '',
      intent: '',
      topic: '',
      confidence: 0,
    };
  }

  const { systemPrompt, userPrompt } = buildRollingContextPrompts({
    lines,
    eventMode,
    routeKey,
  });

  try {
    const data = await deepSeekChatCompletions(
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `${userPrompt}\n\nReturn one strict JSON object only.` },
        ],
        response_format: { type: 'json_object' },
      },
      { timeoutMs: 15000, maxAttempts: 2 }
    );
    const outputText = data?.choices?.[0]?.message?.content?.trim() || '{}';
    const parsed = JSON.parse(outputText);

    return {
      summary: String(parsed.summary || '').trim(),
      intent: String(parsed.intent || '').trim(),
      topic: String(parsed.topic || '').trim(),
      doctrinal_theme: String(parsed.doctrinal_theme || '').trim(),
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
        : [],
      ritual_context: String(parsed.ritual_context || '').trim(),
      guidance: String(parsed.guidance || '').trim(),
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
    };
  } catch (err) {
    console.error('[RollingContext] summarize failed', err.message);
    return {
      summary: '',
      intent: '',
      topic: '',
      confidence: 0,
    };
  }
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
  routeKey = 'zh_en',
  rollingContext = null,
  debugState = null
) {
  if (!text || !text.trim()) return '';

  const mantraLabel = findMantraLabelTranslation(text);
  if (mantraLabel?.english) {
    if (debugState) {
      debugState.mantraMatchId = mantraLabel.id || null;
      debugState.deepSeekResponseExists = false;
      debugState.parsedTranslationExists = true;
      debugState.shortcut = 'mantra_label';
    }
    return mantraLabel.english;
  }

  const generatedCorrection = findGeneratedTranslationCorrection(text, mode);
  if (generatedCorrection?.canOverride && generatedCorrection?.correctedEnglish) {
    if (debugState) {
      debugState.deepSeekResponseExists = false;
      debugState.parsedTranslationExists = true;
      debugState.shortcut = 'correction_override';
    }
    return generatedCorrection.correctedEnglish;
  }

  const phraseMatch = findPhraseMatch(text, mode);
  if (phraseMatch?.en) {
    if (debugState) {
      debugState.deepSeekResponseExists = false;
      debugState.parsedTranslationExists = true;
      debugState.shortcut = 'phrase_match';
    }
    return phraseMatch.en;
  }

  if (routeKey !== 'id_en' && inputMode === 'english') {
    if (debugState) {
      debugState.deepSeekResponseExists = false;
      debugState.parsedTranslationExists = true;
      debugState.shortcut = 'english_passthrough';
    }
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
      rollingContext,
      routeKey,
    });
  }

  if (mode === 'interim') {
    if (!DEEPSEEK_API_KEY || isShortFragment(text)) {
      const fallback = conservativeInterimTranslate(text, hits);
      if (debugState) {
        debugState.deepSeekResponseExists = false;
        debugState.parsedTranslationExists = Boolean(fallback);
        debugState.shortcut = 'interim_fallback';
      }
      return fallback;
    }
  }

  if (!DEEPSEEK_API_KEY) {
    const fallback = mode === 'interim'
      ? conservativeInterimTranslate(text, hits)
      : literalFallbackTranslate(text, hits);
    if (debugState) {
      debugState.deepSeekResponseExists = false;
      debugState.parsedTranslationExists = Boolean(fallback);
      debugState.shortcut = 'missing_deepseek_key_fallback';
    }
    return fallback;
  }

  let enrichedRetrieval = retrieval || {};
  if (mode !== 'interim' && !(enrichedRetrieval.tbsKnowledgeContext || []).length) {
    const tbsKnowledgeContext = await retrieveTbsKnowledgeContext({
      sourceText: text,
      rollingContext,
      routeKey,
    });

    if (tbsKnowledgeContext.length > 0) {
      retrieval.tbsKnowledgeContext = tbsKnowledgeContext;
      enrichedRetrieval = {
        ...enrichedRetrieval,
        tbsKnowledgeContext,
      };
    }
  }

  let { systemPrompt, userPrompt } = buildDeepSeekPrompts({
    text,
    hits,
    mode,
    retrieval: enrichedRetrieval,
    eventMode,
    contextWindow,
    inputMode,
    forceAntiLiteral: false,
    activeTopic,
    rollingContext,
    routeKey,
  });

  try {
    async function requestOnce(currentSystemPrompt, currentUserPrompt) {
      const data = await deepSeekChatCompletions(
        {
          model: 'deepseek-chat',
          temperature: mode === 'interim' ? 0.0 : 0.1,
          messages: [
            { role: 'system', content: currentSystemPrompt },
            { role: 'user', content: currentUserPrompt },
          ],
        },
        { timeoutMs: mode === 'interim' ? 12000 : 20000, maxAttempts: 2 }
      );

      const output = data?.choices?.[0]?.message?.content?.trim() || '';
      if (debugState) {
        debugState.deepSeekResponseExists = Boolean(data?.choices?.[0]?.message);
        debugState.parsedTranslationExists = Boolean(output);
      }
      return output;
    }

    let out = await requestOnce(systemPrompt, userPrompt);

    if (!out) {
      const fallback = mode === 'interim'
        ? conservativeInterimTranslate(text, hits)
        : literalFallbackTranslate(text, hits);
      if (debugState) {
        debugState.parsedTranslationExists = Boolean(fallback);
        debugState.shortcut = 'empty_deepseek_fallback';
      }
      return fallback;
    }

    if (mode !== 'interim' && looksAbsurdOutput(out)) {
      console.warn('[DeepSeek] absurd output detected, retrying once with stronger anti-literal guard');

      ({ systemPrompt, userPrompt } = buildDeepSeekPrompts({
        text,
        hits,
        mode,
        retrieval: enrichedRetrieval,
        eventMode,
        contextWindow,
        inputMode,
        forceAntiLiteral: true,
        activeTopic,
        rollingContext,
        routeKey,
      }));

      const retryOut = await requestOnce(systemPrompt, userPrompt);
      if (retryOut && !looksAbsurdOutput(retryOut)) {
        out = retryOut;
      }
    }

    return out;
  } catch (err) {
    console.error('[DeepSeek] request failed', err.message);
    const fallback = mode === 'interim'
      ? conservativeInterimTranslate(text, hits)
      : literalFallbackTranslate(text, hits);
    if (debugState) {
      debugState.deepSeekResponseExists = false;
      debugState.parsedTranslationExists = Boolean(fallback);
      debugState.shortcut = 'deepseek_error_fallback';
    }
    return fallback;
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

app.get('/api/session/:id', async (req, res) => {
  const session = getOrCreateSession(req.params.id);
  await hydrateSessionBrainState(session);
  res.json(exposeRollingBrainState(session));
});

app.get('/api/sessions', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(sessions.filter((session) => !session.deletedAt).map(summarizeSession));
});

app.post('/api/session', (req, res) => {
  const requestedId = req.body?.id || 'live-session';
  const body = req.body || {};
  const session = getOrCreateSession(requestedId);

  if (body.title !== undefined || body.sessionName !== undefined) {
    session.title = body.title || body.sessionName || session.title;
  }
  if (body.description !== undefined || body.eventMode !== undefined) {
    const description = body.description ?? body.eventMode;
    session.description = description || session.description;
    session.eventMode = body.eventMode || description || session.eventMode;
  }
  if (body.sourceLanguage !== undefined) {
    session.sourceLanguage = body.sourceLanguage || session.sourceLanguage;
  }
  if (body.targetLanguage !== undefined) {
    session.targetLanguage = body.targetLanguage || session.targetLanguage;
  }
  if (body.translationRoute !== undefined || body.routeKey !== undefined) {
    session.translationRoute = body.translationRoute || body.routeKey || session.translationRoute;
  } else if (body.sourceLanguage !== undefined || body.targetLanguage !== undefined) {
    session.translationRoute = deriveTranslationRoute(session.sourceLanguage, session.targetLanguage);
  }
  session.updatedAt = new Date().toISOString();
  if (body.createdByEmail !== undefined || body.created_by_email !== undefined) {
    session.createdByEmail = body.createdByEmail || body.created_by_email || session.createdByEmail;
  }

  persistLiveSession(session);

  res.json(session);
});

app.post('/api/session/:id/line', async (req, res) => {
  const session = getOrCreateSession(req.params.id);

  const rawCn = (req.body?.rawCn || '').trim();
  if (!rawCn) return res.status(400).json({ error: 'rawCn required' });

  const routeKey = req.body?.translationRoute || session.translationRoute || deriveTranslationRoute(session.sourceLanguage, session.targetLanguage);
  const prepared = runRouteNormalization(rawCn, session.eventMode, routeKey);
  const mantraNormalized = normalizeMantraText(prepared.normalizedText, {
    routeKey,
    mode: 'final',
  });
  const normalizedCn = mantraNormalized.text;
  const correctionOverride =
    routeKey === 'id_en' ? null : findGeneratedTranslationCorrection(normalizedCn, 'final');
  const canOverride = correctionOverride?.canOverride === true;
  const hits = canOverride ? [] : applyRouteGlossary(normalizedCn, routeKey);

  const retrieval = canOverride
    ? {
        sacredEntities: [],
        phraseMatches: [],
        ceremonyMatches: [],
        correctionMatches: [correctionOverride],
      }
    : routeKey === 'id_en'
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
        correctionMatches: mergeGeneratedCorrectionMatch(
          correctionOverride,
          prepared.correctionHits || retrieveCorrectionMemory(normalizedCn, session.eventMode)
        ),
      };
  retrieval.mantraMatches = mantraNormalized.matches || [];

  const activeTopic = canOverride || routeKey === 'id_en'
    ? null
    : getActiveTopicContext(
        updateSessionTopic(session, normalizedCn, retrieval, session.eventMode)
      );

  const rollingContext = ensureSessionBrainState(session);

  const en = mantraNormalized.pureMantra
    ? normalizedCn
    : canOverride
    ? correctionOverride.correctedEnglish
    : await translateWithDeepSeek(
        normalizedCn,
        hits,
        'final',
        retrieval,
        session.eventMode,
        getContextWindow(session),
        prepared.inputMode,
        activeTopic,
        routeKey,
        rollingContext
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
  addFinalLineToSession(session, line);
  persistLiveSession(session);
  persistSessionLine(session, line, routeKey, retrieval);

  res.json(line);
});

app.post('/api/translate-interim', async (req, res) => {
  const rawCn = (req.body?.rawCn || '').trim();
  const eventMode = req.body?.eventMode || 'Dharma Talk';
  const sessionId = req.body?.sessionId || 'live-session';
  const session = getOrCreateSession(sessionId);
  const routeKey = req.body?.translationRoute || session.translationRoute || deriveTranslationRoute(req.body?.sourceLanguage, req.body?.targetLanguage);
  const requestMode = req.body?.mode || req.body?.requestMode || (req.body?.text ? 'study' : 'interim');
  const translationMode = requestMode === 'study' ? 'final' : 'interim';
  const studyDebug = requestMode === 'study'
    ? {
        incomingTextLength: rawCn.length,
        normalizedTextLength: 0,
        mantraMatchId: null,
        retrievalChunkCount: 0,
        deepSeekResponseExists: false,
        parsedTranslationExists: false,
        finalPayloadHasTranslation: false,
      }
    : null;

  if (!rawCn) return res.json({ en: '', normalizedCn: '', hits: [] });

  const skipBrain = requestMode === 'study';
  const prepared = skipBrain
    ? { normalizedText: rawCn, correctionHits: [], inputMode: classifyInputModeForRoute(rawCn, routeKey), protectedEnglish: [] }
    : runRouteNormalization(rawCn, eventMode, routeKey);
  const mantraNormalized = normalizeMantraText(prepared.normalizedText, {
    routeKey,
    mode: translationMode,
  });
  const normalizedCn = mantraNormalized.text;
  if (studyDebug) {
    studyDebug.normalizedTextLength = normalizedCn.length;
    studyDebug.mantraMatchId = mantraNormalized.matches?.[0]?.id || null;
  }
  const correctionOverride =
    routeKey === 'id_en' ? null : findGeneratedTranslationCorrection(normalizedCn, translationMode);
  const canOverride = correctionOverride?.canOverride === true;
  const hits = canOverride ? [] : applyRouteGlossary(normalizedCn, routeKey);

  if (requestMode !== 'study' && !canOverride && !isStableEnoughForInterim(normalizedCn)) {
    const payload = {
      en: prepared.inputMode === 'english' ? normalizedCn : '',
      normalizedCn,
      hits,
      inputMode: prepared.inputMode,
    };
    return res.json(payload);
  }

  const retrieval = canOverride
    ? {
        sacredEntities: [],
        phraseMatches: [],
        ceremonyMatches: [],
        correctionMatches: [correctionOverride],
      }
    : routeKey === 'id_en'
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
        correctionMatches: mergeGeneratedCorrectionMatch(
          correctionOverride,
          prepared.correctionHits || retrieveCorrectionMemory(normalizedCn, eventMode)
        ),
      };
  retrieval.mantraMatches = mantraNormalized.matches || [];
  if (studyDebug) {
    studyDebug.mantraMatchId = retrieval.mantraMatches?.[0]?.id || studyDebug.mantraMatchId;
  }

  const activeTopic = canOverride || routeKey === 'id_en'
    ? null
    : getActiveTopicContext(
        updateSessionTopic(session, normalizedCn, retrieval, eventMode)
      );

  const rollingContext = ensureSessionBrainState(session);

  const en = mantraNormalized.pureMantra
    ? normalizedCn
    : canOverride
    ? correctionOverride.correctedEnglish
    : await translateWithDeepSeek(
        normalizedCn,
        hits,
        translationMode,
        retrieval,
        eventMode,
        getContextWindow(session),
        prepared.inputMode,
        activeTopic,
        routeKey,
        rollingContext,
        studyDebug
      );

  if (studyDebug) {
    studyDebug.retrievalChunkCount = (retrieval.tbsKnowledgeContext || retrieval.tbsKnowledgeChunks || []).length;
    if (mantraNormalized.pureMantra || canOverride) {
      studyDebug.deepSeekResponseExists = false;
      studyDebug.parsedTranslationExists = Boolean(en);
      studyDebug.shortcut = mantraNormalized.pureMantra ? 'pure_mantra' : 'correction_override';
    }
    studyDebug.finalPayloadHasTranslation = Boolean(en);
    console.log('[StudyTranslate]', studyDebug);
  }

  const translationMeta = buildTranslationMeta({
    normalizedCn,
    en,
    hits,
    retrieval,
    inputMode: prepared.inputMode,
    activeTopic,
    mode: translationMode,
  });

  res.json({
    en,
    normalizedCn,
    hits,
    retrieval,
    inputMode: prepared.inputMode,
    sessionId,
    translationMeta,
  });
});

app.post('/api/study-translate', async (req, res) => {
  const rawText = (req.body?.text || '').trim();
  const eventMode = req.body?.eventMode || 'Dharma Talk';

  if (!rawText) return res.json({ translations: [] });
  if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: 'Translation service unavailable' });

  try {
    const paragraphs = String(rawText)
      .trim()
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (paragraphs.length === 0) return res.json({ translations: [] });

    const numberedInput = paragraphs
      .map((p, i) => `[${i + 1}]\n${p}`)
      .join('\n\n');

    const glossaryHits = applyGlossary(rawText);
    const glossaryBlock = glossaryHits.length > 0
      ? glossaryHits.map((t) => `${t.cn} → ${t.en}`).join('\n')
      : '';

    let ragBlock = '';
    if (supabase) {
      try {
        const tbsKnowledgeContext = await retrieveTbsKnowledgeContext({
          sourceText: rawText,
          rollingContext: null,
          routeKey: 'zh_en',
        });
        ragBlock = formatTbsKnowledgeContextBlock(tbsKnowledgeContext);
      } catch (err) {
        console.warn('[StudyTranslate] RAG failed:', err.message);
      }
    }

    const systemPrompt = `You are the official translator for True Buddha School (TBS).
Translate Chinese into natural, accurate English using established TBS terminology.

Rules:
1. Output English only — translate only the Chinese portions.
2. If the source contains English, preserve it as-is.
3. Always use the canonical TBS translations below.
4. Preserve the paragraph numbering format [1], [2], etc. in your output.
5. Keep translations clear, natural, and doctrinally accurate.
6. No explanations, notes, or brackets unless essential.

${compiledTbsTerminology}`;

    const userPrompt = `Translate each paragraph below. Keep the [N] numbering in your output.

${numberedInput}
${glossaryBlock ? `\nGlossary hits in this text:\n${glossaryBlock}` : ''}
${ragBlock ? `\n${ragBlock}` : ''}`.trim();

    const data = await deepSeekChatCompletions(
      {
        model: 'deepseek-chat',
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
      { timeoutMs: 30000, maxAttempts: 2 }
    );

    const output = data?.choices?.[0]?.message?.content?.trim() || '';

    const translations = paragraphs.map((_, i) => {
      const pattern = new RegExp(`\\[${i + 1}\\]([\\s\\S]*?)(?=\\[${i + 2}\\]|$)`);
      const match = output.match(pattern);
      return match ? match[1].trim() : '';
    });

    console.log('[StudyTranslate] batch done', {
      paragraphs: paragraphs.length,
      ragChars: ragBlock.length,
      outputChars: output.length,
    });

    res.json({ translations });
  } catch (err) {
    console.error('[StudyTranslate] failed:', err.message);
    res.status(500).json({ error: 'Translation failed' });
  }
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

  const generatedCorrection = correctedEnglish
    ? registerCorrection(
        intendedChinese || (corrected && containsChinese(corrected) ? corrected : heard),
        correctedEnglish
      )
    : null;

  res.json({ ok: true, row, generatedCorrection });
});

app.post('/api/session/:id/clear', (req, res) => {
  const { id } = req.params;

  const session = sessions.find((s) => s.id === id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.lines = [];
  session.totalFinalLinesSeen = 0;
  session.brainStateHistory = [];
  session.brainState = {
    activeTopic: null,
    activeTopicEn: null,
    activeTopicType: null,
    activeTopicConfidence: 0,
    lockedUntilLineCount: 0,
    lastTopics: [],
    rollingSummary: '',
    rollingIntent: '',
    rollingTopic: '',
    rollingDoctrinalTheme: '',
    rollingRitualContext: '',
    rollingGuidance: '',
    rollingEntities: [],
    rollingUpdatedAt: null,
    lastSummaryLineCount: 0,
    lastSummarySeq: 0,
  };
  session.updatedAt = new Date().toISOString();
  persistLiveSession(session);
  if (supabase) {
    supabase
      .from('session_brain_state')
      .delete()
      .eq('session_id', id)
      .then(({ error }) => {
        if (error) warnSupabaseFailure('session_brain_state clear', error);
      })
      .catch((err) => warnSupabaseFailure('session_brain_state clear', err));
  }

  const exposedSession = exposeRollingBrainState(session);
  broadcastToViewers(id, {
    type: 'session_cleared',
    sessionId: id,
    session: exposedSession,
  });

  res.json({ ok: true, session: exposedSession });
});

app.post('/api/session/:id/end', (req, res) => {
  const { id } = req.params;
  const session = sessions.find((s) => s.id === id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  persistSessionStatus(session, 'ended');

  res.json({ ok: true, session: summarizeSession(session) });
});

app.post('/api/session/:id/resume', (req, res) => {
  const { id } = req.params;
  const session = sessions.find((s) => s.id === id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  persistSessionStatus(session, 'listening', { endedAt: null });

  res.json({ ok: true, session: summarizeSession(session) });
});

app.delete('/api/session/:id', (req, res) => {
  const { id } = req.params;
  const session = sessions.find((s) => s.id === id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.status !== 'ended') {
    return res.status(409).json({ error: 'Only ended sessions can be deleted' });
  }

  const now = new Date().toISOString();
  session.deletedAt = now;
  session.updatedAt = now;
  persistLiveSession(session);

  res.json({ ok: true, session: summarizeSession(session) });
});

app.get('/api/session/:id/export.md', async (req, res) => {
  const { id } = req.params;

  try {
    const exportData = await getSessionExportData(id);
    const markdown = renderSessionMarkdown(exportData);
    const filename = `${safeExportFilename(exportData.title || id)}.md`;
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(markdown);
  } catch (err) {
    warnSupabaseFailure('session export', err);
    res.status(err.statusCode || 500).type('text/plain').send(err.message || 'Unable to export session.');
  }
});

app.get('/api/session/:id/export.docx', async (req, res) => {
  const { id } = req.params;

  try {
    const exportData = await getSessionExportData(id);
    const buffer = await renderSessionDocx(exportData);
    const filename = `${safeExportFilename(exportData.title || id)}.docx`;
    res.set(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    warnSupabaseFailure('session docx export', err);
    res.status(err.statusCode || 500).type('text/plain').send(err.message || 'Unable to export session.');
  }
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
  const requestedRouteKey = requestUrl.searchParams.get('route') || '';

  if (isViewer) {
    console.log('[Viewer] connected', sessionId);
    addViewerClient(sessionId, browserWs);

    const session = getOrCreateSession(sessionId);
    await hydrateSessionBrainState(session);
    session.translationRoute = session.translationRoute || deriveTranslationRoute(session.sourceLanguage, session.targetLanguage);
    if (browserWs.readyState === 1) {
      browserWs.send(JSON.stringify({ type: 'session', session, sessionId }));
      if (hasRollingBrainState(session.brainState)) {
        browserWs.send(
          JSON.stringify({
            type: 'brain_state',
            sessionId,
            brainState: session.brainState,
          })
        );
      }
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

  let frameCount = 0;
  let totalBytes = 0;
  let keepAliveTimer = null;
  let dg = null;
  let shuttingDown = false;
  let deepgramClosedLogged = false;

  let lastInterimSourceSent = '';
  let lastInterimSentAt = 0;

  const activeSession = getOrCreateSession(sessionId);
  await hydrateSessionBrainState(activeSession);
  persistSessionStatus(activeSession, 'listening');
  const routeKey = requestedRouteKey || activeSession.translationRoute || deriveTranslationRoute(activeSession.sourceLanguage, activeSession.targetLanguage);
  const routeConfig = getRouteConfig(routeKey);
  activeSession.translationRoute = routeKey;
  persistLiveSession(activeSession);

  console.log('[Browser] connected', routeKey, sessionId, {
    sourceLanguage: activeSession.sourceLanguage,
    targetLanguage: activeSession.targetLanguage,
    eventMode: activeSession.eventMode,
    deepgramModel: DEEPGRAM_MODEL,
    deepgramVocabMode:
      String(DEEPGRAM_MODEL || '').toLowerCase().startsWith('nova-3') ? 'keyterm' : 'keywords',
  });

  function sendToBrowser(obj) {
    if (browserWs.readyState === 1) {
      browserWs.send(JSON.stringify(obj));
    }
  }

  async function maybeBroadcastRollingContext() {
    const brainState = ensureSessionBrainState(activeSession);
    const now = Date.now();
    const totalFinalLinesSeen = getSessionTotalFinalLinesSeen(activeSession);
    const currentBufferLength = getSessionLineCount(activeSession);
    const lastSummarySeq = repairStaleLastSummarySeq(brainState, activeSession, sessionId);
    const newLineDelta = Math.max(0, totalFinalLinesSeen - lastSummarySeq);
    const lastUpdatedMs = brainState.rollingUpdatedAt
      ? Date.parse(brainState.rollingUpdatedAt)
      : 0;

    const rollingMode = chooseRollingContextMode(activeSession);
    const timeSinceLastUpdate = lastUpdatedMs ? now - lastUpdatedMs : Number.POSITIVE_INFINITY;
    const enoughTimePassed = timeSinceLastUpdate >= rollingMode.cooldownMs;
    const enoughNewLines = newLineDelta >= rollingMode.minNewLines;
    const slowSpeechFallback =
      timeSinceLastUpdate >= rollingMode.slowFallbackMs &&
      newLineDelta >= rollingMode.slowFallbackMinLines;
    const shouldRun = (enoughTimePassed && enoughNewLines) || slowSpeechFallback;

    console.log('[RollingContext] trigger check', {
      sessionId,
      routeKey,
      mode: rollingMode.mode,
      totalFinalLinesSeen,
      lastSummarySeq,
      newLineDelta,
      currentBufferLength,
      timeSinceLastUpdate: Number.isFinite(timeSinceLastUpdate) ? timeSinceLastUpdate : null,
      enoughTimePassed,
      enoughNewLines,
      slowSpeechFallback,
      decision: shouldRun ? 'run' : 'skip',
      cooldownMs: rollingMode.cooldownMs,
      minNewLines: rollingMode.minNewLines,
    });

    if (!shouldRun) {
      const reason = !enoughTimePassed
        ? 'cooldown'
        : !enoughNewLines
        ? 'not_enough_new_lines'
        : 'not_ready';
      console.log('[RollingContext] skip', {
        sessionId,
        totalFinalLinesSeen,
        lastSummarySeq,
        newLineDelta,
        currentBufferLength,
        timeSinceLastUpdate: Number.isFinite(timeSinceLastUpdate) ? timeSinceLastUpdate : null,
        enoughTimePassed,
        enoughNewLines,
        decision: 'skip',
        reason,
      });
      return;
    }

    const recentLines = getRecentFinalWindow(activeSession, {
      maxLines: rollingMode.maxLines,
      maxAgeMs: rollingMode.maxAgeMs,
    });

    console.log('[RollingContext] recent window', {
      sessionId,
      routeKey,
      mode: rollingMode.mode,
      recentLineCount: recentLines.length,
      currentBufferLength,
    });

    if (recentLines.length < rollingMode.minRecentLines) {
      console.log('[RollingContext] skip', {
        sessionId,
        totalFinalLinesSeen,
        lastSummarySeq,
        newLineDelta,
        currentBufferLength,
        timeSinceLastUpdate: Number.isFinite(timeSinceLastUpdate) ? timeSinceLastUpdate : null,
        enoughTimePassed,
        enoughNewLines,
        decision: 'skip',
        reason: 'not_enough_recent_lines',
      });
      return;
    }

    const rolling = await summarizeRollingContext(
      recentLines,
      activeSession.eventMode,
      routeKey
    );

    console.log('[RollingContext] result', {
      sessionId,
      routeKey,
      hasSummary: Boolean(rolling.summary),
      hasIntent: Boolean(rolling.intent),
      hasTopic: Boolean(rolling.topic),
      confidence: rolling.confidence,
    });

    if (!rolling.summary && !rolling.intent && !rolling.topic) {
      console.log('[RollingContext] skip', {
        sessionId,
        totalFinalLinesSeen,
        lastSummarySeq,
        newLineDelta,
        currentBufferLength,
        timeSinceLastUpdate: Number.isFinite(timeSinceLastUpdate) ? timeSinceLastUpdate : null,
        enoughTimePassed,
        enoughNewLines,
        decision: 'skip',
        reason: 'empty_summary',
      });
      return;
    }

    if (rollingMode.mode === 'short_burst' && brainState.rollingSummary) {
      const previousSummary = String(brainState.rollingSummary || '').trim();
      const nextSummary = String(rolling.summary || '').trim();
      const nextTopic = String(rolling.topic || '').trim();
      const previousTopic = String(brainState.rollingTopic || '').trim();
      const nextConfidence = Number(rolling.confidence || 0);

      const isTooThin = nextSummary.length > 0 && nextSummary.length < 24;
      const hasWeakerConfidence = nextConfidence < 0.55;
      const hasNoNewTopic = !nextTopic || nextTopic === previousTopic;

      if (isTooThin && hasWeakerConfidence && hasNoNewTopic) {
        console.log('[RollingContext] short-burst kept previous summary', {
          sessionId,
          routeKey,
          hasPreviousTopic: Boolean(previousTopic),
          hasNextTopic: Boolean(nextTopic),
          nextConfidence,
          nextSummaryLength: nextSummary.length,
          totalFinalLinesSeen,
          lastSummarySeq,
          newLineDelta,
          currentBufferLength,
        });
        return;
      }
    }

    brainState.rollingSummary = rolling.summary || '';
    brainState.rollingIntent = rolling.intent || '';
    brainState.rollingTopic = rolling.topic || '';
    brainState.rollingDoctrinalTheme = rolling.doctrinal_theme || '';
    brainState.rollingEntities = rolling.entities || [];
    brainState.rollingRitualContext = rolling.ritual_context || '';
    brainState.rollingGuidance = rolling.guidance || '';
    brainState.rollingUpdatedAt = new Date().toISOString();
    brainState.lastSummarySeq = totalFinalLinesSeen;
    brainState.lastSummaryLineCount = currentBufferLength;
    const brainStateHistory = addBrainStateHistoryEntry(
      activeSession,
      brainState,
      rolling.confidence
    );

    const payload = {
      type: 'brain_state',
      sessionId,
      routeKey,
      translationRoute: routeKey,
      brainState: {
        rollingSummary: brainState.rollingSummary,
        rollingIntent: brainState.rollingIntent,
        rollingTopic: brainState.rollingTopic,
        rollingDoctrinalTheme: brainState.rollingDoctrinalTheme,
        rollingEntities: brainState.rollingEntities,
        rollingRitualContext: brainState.rollingRitualContext,
        rollingGuidance: brainState.rollingGuidance,
        rollingUpdatedAt: brainState.rollingUpdatedAt,
        confidence: rolling.confidence,
      },
      brainStateHistory,
      brain_state_history: brainStateHistory,
    };

    console.log('[RollingContext] broadcast', {
      sessionId,
      routeKey,
      totalFinalLinesSeen,
      lastSummarySeq: brainState.lastSummarySeq,
      newLineDelta,
      currentBufferLength,
      timeSinceLastUpdate: Number.isFinite(timeSinceLastUpdate) ? timeSinceLastUpdate : null,
      decision: 'run',
    });

    persistSessionBrainState(activeSession);
    sendToBrowser(payload);
    broadcastToViewers(sessionId, payload);
  }

  function queueRollingContextUpdate() {
    maybeBroadcastRollingContext().catch((err) => {
      console.error('[RollingContext] broadcast failed', err.message);
    });
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

  function buildDeepgramOptions(includeVocabulary = true) {
    return {
      model: DEEPGRAM_MODEL,
      language: routeConfig.asrLanguage,
      interim_results: true,
      punctuate: true,
      smart_format: true,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      ...(includeVocabulary ? getDeepgramVocabularyOptions(routeConfig) : {}),
    };
  }

  try {
    try {
      dg = await deepgram.listen.v1.connect(buildDeepgramOptions(true));
    } catch (err) {
      const message = String(err?.message || err || '');
      if (!message.includes('400') && !message.toLowerCase().includes('unexpected server response')) {
        throw err;
      }

      console.warn('[Deepgram] keyterms rejected, retrying without keyterms');
      dg = await deepgram.listen.v1.connect(buildDeepgramOptions(false));
    }

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
        const mantraNormalized = normalizeMantraText(prepared.normalizedText, {
          routeKey,
          mode: 'final',
        });
        const normalizedCn = mantraNormalized.text;
        const correctionOverride =
          routeKey === 'id_en' ? null : findGeneratedTranslationCorrection(normalizedCn, 'final');
        const canOverride = correctionOverride?.canOverride === true;
        const hits = canOverride ? [] : applyRouteGlossary(normalizedCn, routeKey);

        if (data.is_final) {
          const retrieval = canOverride
            ? {
                sacredEntities: [],
                phraseMatches: [],
                ceremonyMatches: [],
                correctionMatches: [correctionOverride],
              }
            : routeKey === 'id_en'
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
                correctionMatches: mergeGeneratedCorrectionMatch(
                  correctionOverride,
                  prepared.correctionHits ||
                    retrieveCorrectionMemory(normalizedCn, activeSession.eventMode)
                ),
              };
          retrieval.mantraMatches = mantraNormalized.matches || [];

          const activeTopic = canOverride || routeKey === 'id_en'
            ? null
            : getActiveTopicContext(
                updateSessionTopic(activeSession, normalizedCn, retrieval, activeSession.eventMode)
              );

          const rollingContext = ensureSessionBrainState(activeSession);

          const en = mantraNormalized.pureMantra
            ? normalizedCn
            : canOverride
            ? correctionOverride.correctedEnglish
            : await translateWithDeepSeek(
                normalizedCn,
                hits,
                'final',
                retrieval,
                activeSession.eventMode,
                getContextWindow(activeSession),
                prepared.inputMode,
                activeTopic,
                routeKey,
                rollingContext
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

          addFinalLineToSession(activeSession, line);
          persistLiveSession(activeSession);
          persistSessionLine(activeSession, line, routeKey, retrieval);

          lastInterimSourceSent = '';
          lastInterimSentAt = 0;

          sendToBrowser({ type: 'final', line, sessionId, routeKey, translationRoute: routeKey });
          broadcastToViewers(sessionId, { type: 'final', line, sessionId, routeKey, translationRoute: routeKey });
          broadcastToViewers(sessionId, { type: 'session', session: activeSession, sessionId });
          queueRollingContextUpdate();
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
              sessionId,
              text: rawText,
              rawCn: rawText,
              cn: normalizedCn,
              normalizedCn,
              inputMode: prepared.inputMode,
              routeKey,
              translationRoute: routeKey,
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
    persistSessionStatus(activeSession, 'idle');
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
