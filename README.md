# TBS Live Translation

Real-time speech translation platform for True Buddha School ceremonies and Dharma talks. Supports Mandarin and Indonesian to English with custom Buddhist terminology, mantra recognition, and rolling brain-state context.

## What's Done

### Core Live Translation
- **Mandarin -> English** live ASR via Deepgram with custom keyterms
- **Bahasa Indonesia -> English** live ASR with Indonesian hotwords
- **Auto mode (CN + ID)** — dual parallel Deepgram streams (zh-CN + id), confidence-based dynamic routing through the correct brain pipeline per utterance
- Manual language dropdown with Auto (CN + ID), Mandarin, and Bahasa options
- Rolling brain-state context (topic, intent, summary, entities, ceremony, doctrinal theme)
- Mantra recognition (Vajrapani protection mantra and more) with compiled TBS terminology
- Custom glossary + correction memory per route
- Sacred entity, phrase, and ceremony retrieval for translation enrichment

### Session Management
- Create / join / switch / end / delete sessions
- Per-session brain-state and history persistence
- Viewer link sharing (read-only live transcript)
- Export to Markdown and Word (.docx)
- Clear session history

### Study Mode
- Batched DeepSeek translation with compiled TBS terminology
- Streaming paragraph translation
- Loading skeleton UI
- Persisted study state across reloads
- Parallel paragraph processing for speed

### Review Mode
- Memory review dashboard (sacred entities, phrases, ceremonies, corrections)
- Event mode filtering
- CRUD for correction memory

### Infrastructure & UX
- AudioWorklet for low-latency PCM capture (ScriptProcessor fallback)
- WebSocket with keep-alive, reconnect backoff, and graceful degradation
- Error boundary, confirm dialogs, toast notifications
- Routed tabs (Live / Study / Review) centered horizontally
- Mobile-responsive layout
- Supabase auth (Google OAuth) with admin role table
- Super Admin panel for managing admin users
- Railway deployment target
- Node 20 compatible stream handling

### Brain School (Terminology Pipeline)
- TBSN corpus ingestion (`scripts/ingest-tbsn-corpus.cjs`)
- Mantra extraction from corpus (`scripts/extract-mantras-from-corpus.cjs`)
- Python merge utilities for TBSN data
- Compiled terminology builder for DeepSeek prompts
- High-confidence mantra promotion pipeline

## Future Roadmap

### Near Term
- **Auto-mode cost optimization** — skip secondary stream during sustained single-language segments
- **Confidence threshold tuning** — calibrate routing threshold from real session data
- **Viewer language toggle** — let viewers choose source vs translated display
- **Session replay** — scrollable timeline with brain-state snapshots
- **Corrections export/import** — bulk manage correction memory via CSV/JSON

### Mid Term
- **Additional language pairs** — Cantonese, Vietnamese, Tibetan
- **Offline terminology sync** — cache correction/phrase memory in IndexedDB for viewer resilience
- **Speaker diarization** — separate multiple speakers in auto mode
- **Deepgram Nova-3 upgrade** — when available, for improved accuracy and lower latency
- **Admin dashboard** — usage stats, session analytics, ASR cost tracking
- **Brain-state API** — expose rolling context as REST endpoint for external tools

### Long Term
- **Multi-tenant temple deployments** — separate instances per temple with shared terminology
- **Mobile app** — React Native viewer with push notifications for live sessions
- **Auto-correction learning** — apply reviewer feedback to improve future translations automatically
- **Ceremony mode templates** — pre-configured event modes with ritual-specific terminology sets
- **Real-time caption overlay** — OBS browser source for streaming integration

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite 8 |
| Backend | Node.js, Express, ws |
| ASR | Deepgram SDK |
| Translation | DeepSeek API |
| Auth | Supabase (Google OAuth) |
| Deploy | Railway |
| Audio | AudioWorklet, linear16 PCM |

## Scripts

```bash
npm run dev          # Vite dev server
npm run build        # Production build
npm run lint         # ESLint
npm run start        # Production server (node server.cjs)
npm run ingest:tbsn  # Ingest TBSN corpus
npm run extract:mantras  # Extract mantras from corpus
```

## Validation

Before pushing changes:

```bash
npm run lint
npm run build
node --check server.cjs
```
