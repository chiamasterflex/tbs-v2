import fs from 'fs';
import path from 'path';

const IN_DIR = path.resolve('../outputs');
const OUT_DIR = path.resolve('../outputs');

const INPUT_FILE = path.join(IN_DIR, 'book045_study_tasks.json');
const OUTPUT_FILE = path.join(OUT_DIR, 'book045_study_results.json');
const CHECKPOINT_FILE = path.join(OUT_DIR, 'book045_study_checkpoint.json');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.BRAIN_STUDY_MODEL || 'deepseek-reasoner';
const MAX_RETRIES = Number(process.env.BRAIN_STUDY_MAX_RETRIES || 3);
const RETRY_DELAY_MS = Number(process.env.BRAIN_STUDY_RETRY_DELAY_MS || 1200);

if (!DEEPSEEK_API_KEY) {
  console.error('Missing DEEPSEEK_API_KEY in environment.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function extractBalancedJsonObject(text) {
  const src = String(text || '');
  let start = -1;
  let depth = 0;
  let inString = false;
  let quoteChar = '';
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quoteChar) {
        inString = false;
        quoteChar = '';
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quoteChar = ch;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start !== -1) {
        return src.slice(start, i + 1);
      }
    }
  }

  return '';
}

function normalizeJsonLikeText(text) {
  return String(text || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r/g, '')
    .trim();
}

function parseModelJson(outputText) {
  const raw = normalizeJsonLikeText(outputText);

  const candidates = [];
  const stripped = stripCodeFences(raw);
  if (stripped) candidates.push(stripped);

  const balanced = extractBalancedJsonObject(stripped || raw);
  if (balanced) candidates.push(balanced);

  const regexMatch = raw.match(/\{[\s\S]*\}/);
  if (regexMatch) candidates.push(regexMatch[0]);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  throw new Error(`No valid JSON could be parsed from model response: ${raw.slice(0, 800)}`);
}

async function callModelOnce(systemPrompt, userPrompt) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${userPrompt}\n\nReturn one strict JSON object only.` },
      ],
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`DeepSeek error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  const outputText = data.choices?.[0]?.message?.content || '';

  if (!outputText) {
    throw new Error('No content returned from DeepSeek');
  }

  return parseModelJson(outputText);
}

async function callModel(systemPrompt, userPrompt) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const retryPrompt =
        attempt === 1
          ? userPrompt
          : `${userPrompt}\n\nIMPORTANT RETRY INSTRUCTION: Your previous response was not valid strict JSON. Return ONE valid JSON object only. Use double quotes for all keys and string values. No markdown fences. No commentary.`;

      return await callModelOnce(systemPrompt, retryPrompt);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        console.warn(`Retrying model call (${attempt}/${MAX_RETRIES}) after error: ${err.message}`);
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError || new Error('Model call failed');
}

function normalizeStudyResult(task, result) {
  return {
    bookTitle: task.bookTitle,
    chapterNumber: task.chapterNumber,
    chapterTitle: task.chapterTitle,
    chunkId: task.chunkId,
    sourceUrl: task.sourceUrl,
    charCount: task.charCount,
    paragraphCount: task.paragraphCount,
    score: task.score,
    chunkText: task.chunkText,

    summary: result.summary || '',
    doctrinalFocus: Array.isArray(result.doctrinalFocus) ? result.doctrinalFocus : [],
    teachingMode: result.teachingMode || '',
    speakerIntent: result.speakerIntent || '',
    keyClaims: Array.isArray(result.keyClaims) ? result.keyClaims : [],
    implicitAssumptions: Array.isArray(result.implicitAssumptions)
      ? result.implicitAssumptions
      : [],
    translationStyle: result.translationStyle || '',
    subtitleRender: result.subtitleRender || '',
    antiLiteralWarnings: Array.isArray(result.antiLiteralWarnings)
      ? result.antiLiteralWarnings
      : [],
    relatedThemes: Array.isArray(result.relatedThemes) ? result.relatedThemes : [],
    confidence:
      typeof result.confidence === 'number'
        ? Math.max(0, Math.min(1, result.confidence))
        : 0.5,
  };
}

async function main() {
  const payload = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const tasks = payload.tasks || [];

  const checkpoint = safeReadJson(CHECKPOINT_FILE, {
    doneChunkIds: [],
    results: [],
  });

  const doneSet = new Set(checkpoint.doneChunkIds || []);
  const results = Array.isArray(checkpoint.results) ? checkpoint.results : [];

  console.log(`Loaded ${tasks.length} tasks`);
  console.log(`Already done: ${doneSet.size}`);

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (doneSet.has(task.chunkId)) continue;

    console.log(
      `[${i + 1}/${tasks.length}] Studying ${task.chapterTitle} :: ${task.chunkId}`
    );

    try {
      const rawResult = await callModel(
        task.prompts.system,
        task.prompts.user
      );

      const normalized = normalizeStudyResult(task, rawResult);
      results.push(normalized);
      doneSet.add(task.chunkId);

      writeJson(CHECKPOINT_FILE, {
        doneChunkIds: [...doneSet],
        results,
      });

      await sleep(300);
    } catch (err) {
      console.error(`Failed on ${task.chunkId}:`, err.message);
      doneSet.add(task.chunkId);
      writeJson(CHECKPOINT_FILE, {
        doneChunkIds: [...doneSet],
        results,
        failedChunkIds: [...new Set([...(checkpoint.failedChunkIds || []), task.chunkId])],
        lastError: {
          chunkId: task.chunkId,
          message: err.message,
          at: new Date().toISOString(),
        },
      });
      continue;
    }
  }

  const finalOutput = {
    manifest: {
      model: MODEL,
      taskCount: tasks.length,
      completedCount: results.length,
      generatedAt: new Date().toISOString(),
    },
    results,
  };

  writeJson(OUTPUT_FILE, finalOutput);
  console.log(`Done: ${OUTPUT_FILE}`);
  console.log(`Completed: ${results.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});