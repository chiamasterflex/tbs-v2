import { useEffect, useMemo, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8787';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8787/ws';

export default function App() {
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('idle');
  const [audioDebug, setAudioDebug] = useState({
    frameCount: 0,
    totalBytes: 0,
    lastBytes: 0,
  });

  const [liveChinese, setLiveChinese] = useState('');
  const [liveEnglish, setLiveEnglish] = useState('');
  const [historyLines, setHistoryLines] = useState([]);
  const [manualInput, setManualInput] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('Mandarin');
  const [targetLanguage, setTargetLanguage] = useState('English');

  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);
  const pcmQueueRef = useRef([]);
  const interimTimerRef = useRef(null);
  const lastTranslatedChineseRef = useRef('');
  const transcriptFeedRef = useRef(null);
  const lastLiveSnapshotRef = useRef('');

  useEffect(() => {
    fetch(`${API}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((res) => res.json())
      .then((data) => setSession(data))
      .catch((err) => console.error('session init failed', err));
  }, []);

  const downsampleBuffer = (buffer, inputRate, outputRate) => {
    if (inputRate === outputRate) return buffer;

    const ratio = inputRate / outputRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);

    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;

      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }

      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  };

  const floatTo16BitPCM = (float32Array) => {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);

    let offset = 0;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return buffer;
  };

  const requestInterimTranslation = (text) => {
    if (!text || !text.trim()) return;
    if (text === lastTranslatedChineseRef.current) return;

    if (interimTimerRef.current) {
      clearTimeout(interimTimerRef.current);
    }

    interimTimerRef.current = setTimeout(async () => {
      try {
        lastTranslatedChineseRef.current = text;

        const res = await fetch(`${API}/api/translate-interim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rawCn: text }),
        });

        const data = await res.json();
        setLiveEnglish(data.en || '');
      } catch (err) {
        console.error('interim translate failed', err);
      }
    }, 180);
  };

  const startAudio = async () => {
    try {
      setStatus('requesting_mic');

      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';

      ws.onopen = async () => {
        setStatus('ws_open');

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
          },
        });

        mediaStreamRef.current = stream;

        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(stream);
        sourceRef.current = source;

        pcmQueueRef.current = [];

        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (event) => {
          const inputData = event.inputBuffer.getChannelData(0);
          const downsampled = downsampleBuffer(inputData, audioContext.sampleRate, 16000);

          for (let i = 0; i < downsampled.length; i++) {
            pcmQueueRef.current.push(downsampled[i]);
          }

          const FRAME_SIZE = 800;

          while (pcmQueueRef.current.length >= FRAME_SIZE) {
            const frame = pcmQueueRef.current.splice(0, FRAME_SIZE);
            const pcmBuffer = floatTo16BitPCM(new Float32Array(frame));

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(pcmBuffer);
            }
          }
        };

        source.connect(processor);
        processor.connect(audioContext.destination);

        setStatus('listening');
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'status') {
          if (msg.status === 'deepgram_ready') {
            setStatus('listening');
          } else if (msg.status === 'deepgram_closed' || msg.status === 'ws_closed') {
            setStatus('stopped');
          } else {
            setStatus(msg.status);
          }
        }

        if (msg.type === 'audio_debug') {
          setAudioDebug({
            frameCount: msg.frameCount,
            totalBytes: msg.totalBytes,
            lastBytes: msg.lastBytes,
          });
        }

        if (msg.type === 'live_cn') {
          const sourceText = msg.normalizedCn || msg.text || '';
          if (sourceText && sourceText !== lastLiveSnapshotRef.current) {
            lastLiveSnapshotRef.current = sourceText;
            setLiveChinese(sourceText);
            requestInterimTranslation(sourceText);
          }
        }

        if (msg.type === 'final') {
          const line = msg.line;
          if (line) {
            setHistoryLines((prev) => [line, ...prev].slice(0, 150));
            setLiveChinese('');
            setLiveEnglish('');
            lastTranslatedChineseRef.current = '';
            lastLiveSnapshotRef.current = '';
          }
        }

        if (msg.type === 'error') {
          console.error('[Server error]', msg.message);
          setStatus('error');
        }
      };

      ws.onclose = () => {
        setStatus('stopped');
      };

      ws.onerror = () => {
        setStatus('error');
      };

      wsRef.current = ws;
    } catch (err) {
      console.error('startAudio failed', err);
      setStatus('error');
    }
  };

  const stopAudio = async () => {
    setStatus('stopping');

    try {
      if (interimTimerRef.current) clearTimeout(interimTimerRef.current);
    } catch {}

    try {
      if (processorRef.current) processorRef.current.disconnect();
    } catch {}

    try {
      if (sourceRef.current) sourceRef.current.disconnect();
    } catch {}

    try {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    } catch {}

    try {
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        await audioContextRef.current.close();
      }
    } catch {}

    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    } catch {}

    processorRef.current = null;
    sourceRef.current = null;
    mediaStreamRef.current = null;
    audioContextRef.current = null;
    wsRef.current = null;
    pcmQueueRef.current = [];
    interimTimerRef.current = null;

    setStatus('stopped');
  };

  const pushLine = async () => {
    if (!manualInput.trim() || !session) return;

    try {
      const res = await fetch(`${API}/api/session/${session.id}/line`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawCn: manualInput }),
      });

      const data = await res.json();
      setHistoryLines((prev) => [data, ...prev].slice(0, 150));
      setManualInput('');
    } catch (err) {
      console.error('manual input failed', err);
    }
  };

  const getStatusLabel = () => {
    switch (status) {
      case 'listening':
        return 'Listening live';
      case 'requesting_mic':
        return 'Requesting microphone';
      case 'stopping':
        return 'Stopping';
      case 'stopped':
        return 'Stopped';
      case 'error':
        return 'Something went wrong';
      default:
        return 'Ready';
    }
  };

  const isListening = status === 'listening';

  const feedItems = useMemo(() => {
    const items = [];

    if (liveChinese || liveEnglish) {
      items.push({
        id: 'live-item',
        time: 'Live',
        chinese: liveChinese,
        english: liveEnglish,
        isLive: true,
      });
    }

    historyLines.forEach((line) => {
      items.push({
        id: line.id,
        time: line.time,
        chinese: line.normalizedCn || line.rawCn,
        english: line.en,
        isLive: false,
      });
    });

    return items;
  }, [liveChinese, liveEnglish, historyLines]);

  useEffect(() => {
    const el = transcriptFeedRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [feedItems]);

  if (!session) {
    return (
      <div style={styles.page}>
        <div style={styles.shell}>
          <div style={styles.loadingWrap}>Loading…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.shell}>
        <div style={styles.headerCard}>
          <div style={styles.eyebrow}>True Buddha School</div>
          <h1 style={styles.title}>Live Translation</h1>
          <p style={styles.subtitle}>
            Real-time captions and translation for teachings, ceremonies, and practice.
          </p>

          <div style={styles.statusRow}>
            <div style={styles.statusChip}>
              <div style={styles.statusDot} />
              <span>{getStatusLabel()}</span>
            </div>
          </div>
        </div>

        <div style={styles.languageRow}>
          <div style={styles.selectCard}>
            <div style={styles.selectLabel}>From</div>
            <select
              value={sourceLanguage}
              onChange={(e) => setSourceLanguage(e.target.value)}
              style={styles.select}
            >
              <option>Mandarin</option>
              <option>Cantonese</option>
              <option>Bahasa</option>
              <option>English</option>
              <option>Auto Detect</option>
            </select>
          </div>

          <div style={styles.swapWrap}>
            <div style={styles.swapIcon}>⇄</div>
          </div>

          <div style={styles.selectCard}>
            <div style={styles.selectLabel}>To</div>
            <select
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              style={styles.select}
            >
              <option>English</option>
              <option>Chinese</option>
              <option>Bahasa</option>
            </select>
          </div>
        </div>

        <div style={styles.transcriptCard}>
          <div style={styles.transcriptHeader}>
            <div style={styles.cardLabel}>Transcript</div>
            <div style={styles.debugChip}>
              {audioDebug.lastBytes ? `Audio ${audioDebug.lastBytes}b` : 'Audio idle'}
            </div>
          </div>

          <div ref={transcriptFeedRef} style={styles.transcriptFeed}>
            {feedItems.length === 0 ? (
              <div style={styles.emptyState}>Waiting for speech…</div>
            ) : (
              feedItems.map((item) => (
                <div
                  key={item.id}
                  style={{
                    ...styles.feedRow,
                    ...(item.isLive ? styles.feedRowLive : {}),
                  }}
                >
                  <div style={styles.feedMetaRow}>
                    <div style={styles.feedMeta}>{item.time}</div>
                    {item.isLive && <div style={styles.liveBadge}>Draft</div>}
                  </div>

                  <div style={styles.feedChinese}>
                    {item.chinese || '…'}
                  </div>

                  <div
                    style={{
                      ...styles.feedEnglish,
                      ...(item.isLive ? styles.feedEnglishDraft : {}),
                    }}
                  >
                    {item.english || (item.isLive ? 'Translating…' : '…')}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div style={styles.manualCard}>
          <div style={styles.cardLabel}>Manual Test</div>
          <div style={styles.manualTitle}>Paste Chinese text</div>
          <textarea
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            rows={4}
            style={styles.textarea}
            placeholder="Paste source text here for testing…"
          />
          <button onClick={pushLine} style={styles.secondaryButton}>
            Translate manually
          </button>
        </div>
      </div>

      <div style={styles.floatingBar}>
        <div style={styles.floatingInner}>
          <div style={styles.floatingStatus}>{getStatusLabel()}</div>

          <button
            onClick={isListening ? stopAudio : startAudio}
            style={{
              ...styles.micButton,
              ...(isListening ? styles.micButtonActive : {}),
            }}
          >
            <span style={styles.micIcon}>{isListening ? '■' : '🎙'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: '#111111',
    padding: '20px 16px 120px',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: '#111',
  },

  shell: {
    width: '100%',
    maxWidth: '760px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },

  loadingWrap: {
    minHeight: '100vh',
    display: 'grid',
    placeItems: 'center',
    color: '#fff',
    fontSize: '24px',
    fontWeight: 700,
  },

  headerCard: {
    background: '#fff7ef',
    borderRadius: '28px',
    padding: '24px 22px',
    textAlign: 'left',
  },

  eyebrow: {
    fontSize: '12px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#666',
    marginBottom: '10px',
    textAlign: 'left',
  },

  title: {
    margin: 0,
    fontSize: '38px',
    lineHeight: 0.96,
    letterSpacing: '-0.04em',
    fontWeight: 800,
    color: '#111',
    textAlign: 'left',
  },

  subtitle: {
    margin: '12px 0 0',
    fontSize: '16px',
    lineHeight: 1.45,
    color: '#444',
    maxWidth: '520px',
    textAlign: 'left',
  },

  statusRow: {
    marginTop: '18px',
    display: 'flex',
    justifyContent: 'flex-start',
  },

  statusChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '10px',
    background: '#111',
    color: '#fff',
    borderRadius: '999px',
    padding: '10px 14px',
    fontSize: '13px',
    fontWeight: 700,
  },

  statusDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: '#ff6b35',
  },

  languageRow: {
    display: 'grid',
    gridTemplateColumns: '1fr auto 1fr',
    gap: '12px',
    alignItems: 'center',
  },

  selectCard: {
    background: '#ffffff',
    borderRadius: '20px',
    padding: '12px 14px',
    textAlign: 'left',
  },

  selectLabel: {
    fontSize: '11px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#777',
    marginBottom: '6px',
    textAlign: 'left',
  },

  select: {
    width: '100%',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    fontSize: '16px',
    fontWeight: 700,
    color: '#111',
    textAlign: 'left',
  },

  swapWrap: {
    display: 'grid',
    placeItems: 'center',
  },

  swapIcon: {
    width: '38px',
    height: '38px',
    borderRadius: '50%',
    background: '#ffffff',
    display: 'grid',
    placeItems: 'center',
    fontSize: '16px',
    fontWeight: 700,
    color: '#111',
  },

  transcriptCard: {
    background: '#ff764a',
    borderRadius: '28px',
    padding: '18px',
    color: '#111',
    textAlign: 'left',
  },

  transcriptHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '14px',
    flexWrap: 'wrap',
  },

  cardLabel: {
    fontSize: '12px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#5a3a2e',
    textAlign: 'left',
  },

  debugChip: {
    background: '#111',
    color: '#fff',
    borderRadius: '999px',
    padding: '9px 12px',
    fontSize: '12px',
    fontWeight: 700,
  },

  transcriptFeed: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    maxHeight: '56vh',
    overflowY: 'auto',
    background: '#fff8f2',
    borderRadius: '22px',
    padding: '6px 0',
    scrollBehavior: 'smooth',
  },

  feedRow: {
    padding: '14px 16px 16px',
    borderBottom: '1px solid rgba(17,17,17,0.08)',
    textAlign: 'left',
    transition: 'background 160ms ease',
  },

  feedRowLive: {
    background: '#fff0e8',
  },

  feedMetaRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    marginBottom: '8px',
  },

  feedMeta: {
    fontSize: '12px',
    fontWeight: 700,
    color: '#777',
    textAlign: 'left',
  },

  liveBadge: {
    fontSize: '11px',
    fontWeight: 800,
    color: '#7a4a38',
    background: '#ffd8c8',
    borderRadius: '999px',
    padding: '6px 9px',
  },

  feedChinese: {
    fontSize: '22px',
    lineHeight: 1.22,
    fontWeight: 700,
    color: '#111',
    marginBottom: '8px',
    textAlign: 'left',
    wordBreak: 'break-word',
  },

  feedEnglish: {
    fontSize: '19px',
    lineHeight: 1.32,
    fontWeight: 600,
    color: '#2450d8',
    textAlign: 'left',
    wordBreak: 'break-word',
    transition: 'opacity 160ms ease, color 160ms ease',
  },

  feedEnglishDraft: {
    color: '#5c72c9',
    opacity: 0.8,
  },

  emptyState: {
    padding: '18px 16px',
    color: '#666',
    fontSize: '15px',
    textAlign: 'left',
  },

  manualCard: {
    background: '#efece6',
    borderRadius: '24px',
    padding: '18px',
    textAlign: 'left',
  },

  manualTitle: {
    fontSize: '22px',
    fontWeight: 800,
    letterSpacing: '-0.03em',
    marginBottom: '12px',
    textAlign: 'left',
  },

  textarea: {
    width: '100%',
    border: '2px solid #ddd',
    borderRadius: '18px',
    padding: '14px 16px',
    fontSize: '16px',
    resize: 'vertical',
    outline: 'none',
    boxSizing: 'border-box',
    marginBottom: '14px',
    fontFamily: 'inherit',
    background: '#fff',
    textAlign: 'left',
  },

  secondaryButton: {
    border: 'none',
    background: '#111',
    color: '#fff',
    borderRadius: '999px',
    padding: '14px 18px',
    fontSize: '15px',
    fontWeight: 700,
    cursor: 'pointer',
  },

  floatingBar: {
    position: 'fixed',
    left: '50%',
    bottom: '18px',
    transform: 'translateX(-50%)',
    width: 'calc(100% - 24px)',
    maxWidth: '720px',
    pointerEvents: 'none',
  },

  floatingInner: {
    pointerEvents: 'auto',
    background: 'rgba(20,20,20,0.92)',
    backdropFilter: 'blur(12px)',
    borderRadius: '999px',
    padding: '12px 14px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
  },

  floatingStatus: {
    color: '#fff',
    fontSize: '14px',
    fontWeight: 700,
    textAlign: 'left',
    paddingLeft: '4px',
  },

  micButton: {
    width: '58px',
    height: '58px',
    borderRadius: '50%',
    border: 'none',
    background: '#ffffff',
    color: '#111',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    fontWeight: 800,
    boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
  },

  micButtonActive: {
    background: '#ff6b35',
    color: '#111',
  },

  micIcon: {
    fontSize: '22px',
    lineHeight: 1,
  },
};