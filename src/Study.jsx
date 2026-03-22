function classifyInputMode(text) {
  const hasCn = containsChinese(text);
  const hasEn = containsEnglish(text);

  if (hasCn && hasEn) return 'mixed';
  if (hasCn) return 'chinese';
  if (hasEn) return 'english';
  return 'unknown';
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
      'chinese'
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

async function translateWithDeepSeek(
  text,
  hits,
  mode,
  retrieval,
  eventMode,
  contextWindow,
  inputLang
) {
  const inputMode = classifyInputMode(text);

  if (inputMode === 'english') {
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
    });
  }

  // existing function continues unchanged...
}