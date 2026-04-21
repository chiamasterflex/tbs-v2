import fs from 'fs';
import path from 'path';

const IN_DIR = path.resolve('../outputs');
const OUT_DIR = path.resolve('../outputs');

const INPUT_FILE = path.join(IN_DIR, 'book045_study_tasks.json');
const OUTPUT_FILE = path.join(OUT_DIR, 'book045_study_results.json');
const CHECKPOINT_FILE = path.join(OUT_DIR, 'book045_study_checkpoint.json');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.BRAIN_STUDY_MODEL || 'deepseek-chat';

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

async function callModel(systemPrompt, userPrompt) {
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
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
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

  const fencedJsonMatch = outputText.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJsonMatch) {
    return JSON.parse(fencedJsonMatch[1].trim());
  }

  const jsonMatch = outputText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in DeepSeek response: ${outputText.slice(0, 500)}`);
  }

  return JSON.parse(jsonMatch[0]);
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
      writeJson(CHECKPOINT_FILE, {
        doneChunkIds: [...doneSet],
        results,
        lastError: {
          chunkId: task.chunkId,
          message: err.message,
          at: new Date().toISOString(),
        },
      });
      process.exit(1);
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