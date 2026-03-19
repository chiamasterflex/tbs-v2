require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { DeepgramClient } = require('@deepgram/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8787;

server.listen(PORT, () => {
  console.log(`TBS V2 API running on http://localhost:${PORT}`);
});

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!DEEPGRAM_API_KEY) {
  console.error('Missing DEEPGRAM_API_KEY in .env');
  process.exit(1);
}

const deepgram = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Failed to read ${filePath}`, err.message);
    return fallback;
  }
}

const resourcesDir = path.join(__dirname, 'Resources');

const generatedGlossary = readJson(path.join(resourcesDir, 'glossary.generated.json'), []);
const generatedCorrections = readJson(path.join(resourcesDir, 'corrections.generated.json'), []);
const generatedPhrases = readJson(path.join(resourcesDir, 'phrases.generated.json'), []);

console.log(
  `[Resources] glossary=${generatedGlossary.length} corrections=${generatedCorrections.length} phrases=${generatedPhrases.length}`
);

let sessions = [
  {
    id: 'demo-session',
    title: 'TBS Live Session',
    eventMode: 'Dharma Talk',
    lines: [],
  },
];

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

function normalizeChineseText(text) {
  if (!text) return '';

  let out = text.trim();

  for (const rule of generatedCorrections) {
    if (rule?.wrong && rule?.correct && out.includes(rule.wrong)) {
      out = out.replaceAll(rule.wrong, rule.correct);
    }
  }

  return out;
}

function applyGlossary(text) {
  const hits = [];
  const sorted = [...generatedGlossary].sort(
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

function findPhraseMatch(text, mode = 'final') {
  if (!text) return null;

  const normalized = text.trim();
  if (!normalized) return null;

  // Never use fuzzy phrase matching for tiny fragments.
  if (isShortFragment(normalized)) return null;

  // Exact match always wins.
  for (const phrase of generatedPhrases) {
    if (!phrase?.cn || !phrase?.en) continue;
    const candidate = phrase.cn.trim();
    if (!candidate) continue;

    if (normalized === candidate) {
      return { ...phrase, confidence: 'exact' };
    }
  }

  // For interim mode, be much stricter and only allow near-complete long matches.
  const minLength = mode === 'interim' ? 12 : 10;
  let best = null;

  for (const phrase of generatedPhrases) {
    if (!phrase?.cn || !phrase?.en) continue;

    const candidate = phrase.cn.trim();
    if (!candidate || candidate.length < minLength) continue;

    // Strong containment only, no loose fuzzy cleverness.
    if (normalized.includes(candidate)) {
      const score = candidate.length;
      if (!best || score > best.score) {
        best = { ...phrase, score, confidence: 'contains' };
      }
    } else if (candidate.includes(normalized)) {
      // Only allow this on final mode, and only when very close in length.
      if (mode === 'final') {
        const ratio = normalized.length / candidate.length;
        if (ratio >= 0.8) {
          const score = normalized.length;
          if (!best || score > best.score) {
            best = { ...phrase, score, confidence: 'near-complete' };
          }
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
    .replaceAll('我們先', 'Let us first')
    .replaceAll('接下來是', 'Next is')
    .replaceAll('開示', 'teaching')
    .replaceAll('法會', 'dharma ceremony')
    .replaceAll('修行', 'spiritual practice')
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

  // For very short fragments, do almost nothing. Better blank than nonsense.
  if (t.length <= 1) return '';
  if (t.length <= 2) {
    return applyGlossaryToEnglish(t, hits);
  }

  return literalFallbackTranslate(t, hits);
}

async function translateWithDeepSeek(text, hits, mode = 'final') {
  if (!text || !text.trim()) return '';

  // Strict phrase matching first.
  const phraseMatch = findPhraseMatch(text, mode);
  if (phraseMatch?.en) return phraseMatch.en;

  // Interim/live translation should stay conservative.
  if (mode === 'interim') {
    if (!DEEPSEEK_API_KEY) {
      return conservativeInterimTranslate(text, hits);
    }

    // For short live fragments, don't ask the model to be clever.
    if (isShortFragment(text)) {
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

  const systemPrompt =
    mode === 'interim'
      ? `
You are the official translator for True Buddha School (TBS).

Translate spoken Chinese into short, conservative live subtitle English.

Rules:
1. Output English only.
2. Be literal and restrained.
3. Do not guess missing context.
4. Preserve TBS terms exactly from the glossary.
5. If the input is fragmentary, translate only what is clearly present.
6. Do not embellish, summarize, or complete unfinished thoughts.
`.trim()
      : `
You are the official translator for True Buddha School (TBS).

Translate spoken Chinese into natural English for final subtitles.

Rules:
1. Output English only.
2. Preserve TBS terminology exactly when given in the glossary.
3. No explanations.
4. Keep it clear and subtitle-friendly.
5. Prefer accuracy over flourish.
6. Do not invent implied meanings that are not in the Chinese.
`.trim();

  const userPrompt = `
Mode: ${mode}

Chinese:
${text}

Glossary:
${glossaryBlock}
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

function buildLine(rawCn, normalizedCn, en, hits) {
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    rawCn,
    normalizedCn,
    en,
    hits,
    time: new Date().toLocaleTimeString(),
  };
}

app.get('/api/session/:id', (req, res) => {
  const session = sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.post('/api/session', (req, res) => {
  const { title = 'TBS Live Session', eventMode = 'Dharma Talk' } = req.body || {};
  const id = `session-${Date.now()}`;
  const session = { id, title, eventMode, lines: [] };
  sessions.unshift(session);
  res.json(session);
});

app.post('/api/session/:id/line', async (req, res) => {
  const session = sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const rawCn = (req.body?.rawCn || '').trim();
  if (!rawCn) return res.status(400).json({ error: 'rawCn required' });

  const normalizedCn = normalizeChineseText(rawCn);
  const hits = applyGlossary(normalizedCn);
  const en = await translateWithDeepSeek(normalizedCn, hits, 'final');

  const line = buildLine(rawCn, normalizedCn, en, hits);
  session.lines.unshift(line);
  session.lines = session.lines.slice(0, 100);

  res.json(line);
});

app.post('/api/translate-interim', async (req, res) => {
  const rawCn = (req.body?.rawCn || '').trim();
  if (!rawCn) return res.json({ en: '', normalizedCn: '', hits: [] });

  const normalizedCn = normalizeChineseText(rawCn);
  const hits = applyGlossary(normalizedCn);
  const en = await translateWithDeepSeek(normalizedCn, hits, 'interim');

  res.json({ en, normalizedCn, hits });
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

        const normalizedCn = normalizeChineseText(rawText);
        const hits = applyGlossary(normalizedCn);

        if (data.is_final) {
          const en = await translateWithDeepSeek(normalizedCn, hits, 'final');
          const line = buildLine(rawText, normalizedCn, en, hits);

          const session = sessions[0];
          if (session) {
            session.lines.unshift(line);
            session.lines = session.lines.slice(0, 100);
          }

          sendToBrowser({ type: 'final', line });
        } else {
          sendToBrowser({ type: 'live_cn', text: rawText, normalizedCn });
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

      if (frameCount % 20 === 0) {
        console.log(`[Browser audio] frames=${frameCount} totalBytes=${totalBytes} lastBytes=${data.length}`);
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

server.listen(PORT, () => {
  console.log(`TBS V2 API running on http://localhost:${PORT}`);
  console.log(`TBS V2 WS bridge running on ws://localhost:${PORT}/ws`);
});