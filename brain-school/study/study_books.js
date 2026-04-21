import fs from 'fs';
import path from 'path';

const IN_DIR = path.resolve('../outputs');
const OUT_DIR = path.resolve('../outputs');

const INPUT_FILE = path.join(IN_DIR, 'book045_chunked.json');
const OUTPUT_FILE = path.join(OUT_DIR, 'book045_study_tasks.json');

const MODEL_HINT = 'gpt-5 / reasoning-capable model';

function normalizeSpace(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function makeSystemPrompt() {
  return [
    'You are a doctrinal study engine for True Buddha School materials.',
    'Your job is not to do word-for-word translation.',
    'Your job is to understand teachings deeply and represent what they mean.',
    '',
    'When given a chunk of a teaching text, you must identify:',
    '1. what is being taught',
    '2. why it is being taught',
    '3. what doctrinal frame is active',
    '4. what a faithful subtitle-style English rendering would sound like',
    '5. what literal misunderstandings should be avoided',
    '',
    'Prefer meaning, context, doctrine, and teaching intent over surface wording.',
    'Do not reduce the text to glossary pairs.',
    'Do not flatten everything into generic Buddhism.',
    'Preserve the doctrinal and TBS teaching tone.',
    '',
    'Return valid JSON only.',
  ].join('\n');
}

function makeUserPrompt({ bookTitle, chapterTitle, chunkId, chunkText }) {
  return [
    `Book: ${bookTitle}`,
    `Chapter: ${chapterTitle}`,
    `Chunk ID: ${chunkId}`,
    '',
    'Study this teaching chunk and return a structured understanding.',
    '',
    'Required JSON shape:',
    '{',
    '  "summary": "2-4 sentence explanation of what this chunk means",',
    '  "doctrinalFocus": ["array", "of", "core", "teachings"],',
    '  "teachingMode": "one of: doctrinal explanation / instruction / exhortation / narrative testimony / devotional invocation / ritual guidance / polemical contrast",',
    '  "speakerIntent": "what the speaker is trying to do here",',
    '  "keyClaims": ["main doctrinal or practical claims made in this chunk"],',
    '  "implicitAssumptions": ["unstated assumptions the chunk relies on"],',
    '  "translationStyle": "how this should sound in natural subtitle English",',
    '  "subtitleRender": "a concise, faithful subtitle-style rendering of the central meaning",',
    '  "antiLiteralWarnings": ["what literal translations or misunderstandings should be avoided"],',
    '  "relatedThemes": ["closely related themes or ideas activated by this chunk"],',
    '  "confidence": 0.0',
    '}',
    '',
    'Rules:',
    '- summary must reflect meaning, not just restate wording',
    '- doctrinalFocus should be conceptual, not mere repeated phrases',
    '- subtitleRender should sound like a good live interpreter, not a stiff translator',
    '- antiLiteralWarnings should call out likely errors a literal translation would make',
    '- confidence should be between 0 and 1',
    '',
    'Chunk text:',
    chunkText,
  ].join('\n');
}

function buildTasks(bookData) {
  const tasks = [];

  for (const chapter of bookData) {
    const bookTitle = 'Book 045 - The Art of Meditation';
    const chapterTitle = chapter.title || `Chapter ${chapter.chapterNumber}`;

    for (const chunk of chapter.chunks || []) {
      tasks.push({
        bookTitle,
        chapterNumber: chapter.chapterNumber,
        chapterTitle,
        chunkId: chunk.chunkId,
        sourceUrl: chapter.url,
        charCount: chunk.charCount || chunk.text.length,
        paragraphCount: chunk.paragraphCount || null,
        score: chunk.score || null,
        chunkText: normalizeSpace(chunk.text),
        prompts: {
          system: makeSystemPrompt(),
          user: makeUserPrompt({
            bookTitle,
            chapterTitle,
            chunkId: chunk.chunkId,
            chunkText: normalizeSpace(chunk.text),
          }),
        },
      });
    }
  }

  return tasks;
}

function buildManifest(tasks) {
  const byChapter = new Map();

  for (const task of tasks) {
    const key = `${task.chapterNumber}::${task.chapterTitle}`;
    if (!byChapter.has(key)) {
      byChapter.set(key, {
        chapterNumber: task.chapterNumber,
        chapterTitle: task.chapterTitle,
        chunkCount: 0,
      });
    }
    byChapter.get(key).chunkCount += 1;
  }

  return {
    modelHint: MODEL_HINT,
    taskCount: tasks.length,
    chapters: [...byChapter.values()].sort((a, b) => a.chapterNumber - b.chapterNumber),
  };
}

function main() {
  const bookData = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const tasks = buildTasks(bookData);
  const manifest = buildManifest(tasks);

  const payload = {
    manifest,
    tasks,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2));
  console.log(`Done: ${OUTPUT_FILE}`);
  console.log(`Tasks: ${manifest.taskCount}`);
  console.log(`Chapters: ${manifest.chapters.length}`);
}

main();