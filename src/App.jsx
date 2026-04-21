import { useEffect, useMemo, useRef, useState } from 'react';
import Study from './Study';
import Review from './Review';
import Viewer from './Viewer';
import ToolTabs from './ToolTabs';
import micIcon from './assets/mic.svg';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8787';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8787/ws';
const FIXED_SESSION_ID = 'live-session';

function deriveTranslationRoute(sourceLanguage, targetLanguage) {
  const source = String(sourceLanguage || '').toLowerCase();
  const target = String(targetLanguage || '').toLowerCase();

  if ((source.includes('bahasa') || source.includes('indones')) && target.includes('english')) {
    return 'id_en';
  }

  return 'zh_en';
}

function formatTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';

  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export default function App() {
  const path = window.location.pathname;

  if (path === '/study') {
    return <Study />;
  }

  if (path === '/review') {
    return <Review />;
  }

  if (path === '/viewer') {
    return <Viewer />;
  }

  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('idle');
  const [audioDebug, setAudioDebug] = useState({
    frameCount: 0,
    totalBytes: 0,
    lastBytes: 0,
  });
  const [copied, setCopied] = useState(false);

const [liveChinese, setLiveChinese] = useState('');
const [liveEnglish, setLiveEnglish] = useState('');
const [historyLines, setHistoryLines] = useState([]);
const [rollingBrainState, setRollingBrainState] = useState(null);
const [sourceLanguage, setSourceLanguage] = useState('Mandarin');
const [targetLanguage, setTargetLanguage] = useState('English');

  const translationRoute = useMemo(
    () => deriveTranslationRoute(sourceLanguage, targetLanguage),
    [sourceLanguage, targetLanguage]
  );

  const wsRef = useRef(null);
const audioContextRef = useRef(null);
const mediaStreamRef = useRef(null);
const sourceRef = useRef(null);
const processorRef = useRef(null);
const pcmQueueRef = useRef([]);
const interimTimerRef = useRef(null);
const reconnectTimerRef = useRef(null);
const shouldReconnectRef = useRef(false);
const manualStopRef = useRef(false);
const liveConfigRef = useRef({
  sourceLanguage: 'Mandarin',
  targetLanguage: 'English',
  translationRoute: 'zh_en',
});
const lastTranslatedChineseRef = useRef('');
const transcriptFeedRef = useRef(null);
const lastLiveSnapshotRef = useRef('');

  useEffect(() => {
    const init = async () => {
      try {
        const existing = await fetch(`${API}/api/session/${FIXED_SESSION_ID}`);
        if (existing.ok) {
          const data = await existing.json();
          setSession(data);
          setHistoryLines(data.lines || []);
          if (data.sourceLanguage) setSourceLanguage(data.sourceLanguage);
          if (data.targetLanguage) setTargetLanguage(data.targetLanguage);
          return;
        }

        const create = await fetch(`${API}/api/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: FIXED_SESSION_ID,
            title: 'TBS Live Session',
            eventMode: 'Dharma Talk',
            sourceLanguage: 'Mandarin',
            targetLanguage: 'English',
            translationRoute: 'zh_en',
          }),
        });

        const created = await create.json();
        setSession(created);
        setHistoryLines(created.lines || []);
        if (created.sourceLanguage) setSourceLanguage(created.sourceLanguage);
        if (created.targetLanguage) setTargetLanguage(created.targetLanguage);
      } catch (err) {
        console.error('session init failed', err);
      }
    };

    init();
  }, []);

  useEffect(() => {
    if (!session?.id) return;

    const sync = async () => {
      try {
        const res = await fetch(`${API}/api/session/${FIXED_SESSION_ID}`);
        if (!res.ok) return;
        const latest = await res.json();

        if (
          latest.sourceLanguage === sourceLanguage &&
          latest.targetLanguage === targetLanguage &&
          latest.translationRoute === translationRoute
        ) {
          return;
        }

        const update = await fetch(`${API}/api/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: FIXED_SESSION_ID,
            title: session.title || 'TBS Live Session',
            eventMode: session.eventMode || 'Dharma Talk',
            sourceLanguage,
            targetLanguage,
            translationRoute,
          }),
        });

        if (update.ok) {
          const updated = await update.json();
          setSession(updated);
        }
      } catch (err) {
        console.error('session sync failed', err);
      }
    };

    sync();
  }, [session?.id, session?.title, session?.eventMode, sourceLanguage, targetLanguage, translationRoute]);

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
          body: JSON.stringify({
            rawCn: text,
            sourceLanguage,
            targetLanguage,
            translationRoute,
          }),
        });

        const data = await res.json();
        setLiveEnglish(data.en || '');
      } catch (err) {
        console.error('interim translate failed', err);
      }
    }, 180);
  };

  const startAudio = async () => {
  if (
    status === 'requesting_mic' ||
    status === 'ws_open' ||
    status === 'listening' ||
    status === 'reconnecting'
  ) {
    return;
  }

  manualStopRef.current = false;
  shouldReconnectRef.current = true;

  const openSocket = async () => {
    try {
      setStatus(mediaStreamRef.current ? 'reconnecting' : 'requesting_mic');

      const currentRoute = liveConfigRef.current.translationRoute;
      const ws = new WebSocket(`${WS_URL}?route=${encodeURIComponent(currentRoute)}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = async () => {
        try {
          setStatus('ws_open');

          if (!mediaStreamRef.current) {
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
              const activeWs = wsRef.current;
              if (!activeWs) return;

              const inputData = event.inputBuffer.getChannelData(0);
              const downsampled = downsampleBuffer(inputData, audioContext.sampleRate, 16000);

              for (let i = 0; i < downsampled.length; i++) {
                pcmQueueRef.current.push(downsampled[i]);
              }

              const FRAME_SIZE = 800;

              while (pcmQueueRef.current.length >= FRAME_SIZE) {
                const frame = pcmQueueRef.current.splice(0, FRAME_SIZE);
                const pcmBuffer = floatTo16BitPCM(new Float32Array(frame));

                if (activeWs.readyState === WebSocket.OPEN) {
                  activeWs.send(pcmBuffer);
                }
              }
            };

            source.connect(processor);
            processor.connect(audioContext.destination);
          }

          setStatus('listening');
        } catch (err) {
          console.error('socket open bootstrap failed', err);
          setStatus('error');
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'status') {
          if (msg.status === 'deepgram_ready') {
            setStatus('listening');
          } else if (msg.status === 'deepgram_closed') {
            setStatus('reconnecting');
          } else if (msg.status === 'ws_closed') {
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

        if (msg.type === 'brain_state') {
          setRollingBrainState(msg.brainState || null);
        }

        if (msg.type === 'error') {
          console.error('[Server error]', msg.message);
          setStatus('error');
        }
      };

      ws.onclose = () => {
        wsRef.current = null;

        if (manualStopRef.current || !shouldReconnectRef.current) {
          setStatus('stopped');
          return;
        }

        setStatus('reconnecting');

        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }

        reconnectTimerRef.current = setTimeout(() => {
          openSocket();
        }, 900);
      };

      ws.onerror = () => {
        setStatus('error');
      };
    } catch (err) {
      console.error('startAudio failed', err);
      setStatus('error');
    }
  };

  openSocket();
};

  const stopAudio = async () => {
  manualStopRef.current = true;
  shouldReconnectRef.current = false;
  setStatus('stopping');

  try {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
  } catch {}

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
    if (wsRef.current && wsRef.current.readyState <= 1) {
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
  reconnectTimerRef.current = null;

  setStatus('stopped');
};

  const copyViewerLink = async () => {
    const url = `${window.location.origin}/viewer`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      console.error(err);
    }
  };

  const clearHistory = async () => {
    try {
      await fetch(`${API}/api/session/${FIXED_SESSION_ID}/clear`, {
        method: 'POST',
      });

      setHistoryLines([]);
      setLiveChinese('');
      setLiveEnglish('');
      setRollingBrainState(null);
      lastTranslatedChineseRef.current = '';
      lastLiveSnapshotRef.current = '';
    } catch (err) {
      console.error('clear history failed', err);
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
        at: new Date().toISOString(),
      });
    }

    historyLines.forEach((line) => {
      items.push({
        id: line.id,
        time: line.time || formatTime(line.at),
        chinese: line.normalizedCn || line.rawCn,
        english: line.en,
        isLive: false,
        at: line.at,
      });
    });

    return items;
  }, [liveChinese, liveEnglish, historyLines]);

  useEffect(() => {
    const el = transcriptFeedRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [feedItems]);

  useEffect(() => {
  liveConfigRef.current = {
    sourceLanguage,
    targetLanguage,
    translationRoute,
  };
}, [sourceLanguage, targetLanguage, translationRoute]);

  if (!session) {
    return (
      <div style={styles.page}>
        <div style={styles.bgOrbA} />
        <div style={styles.bgOrbB} />
        <div style={styles.shell}>
          <ToolTabs current="live" />
          <div style={styles.loadingWrap}>Loading…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.bgOrbA} />
      <div style={styles.bgOrbB} />

      <div style={styles.shell}>
        <ToolTabs current="live" />

        <div style={styles.headerCard}>
          <h1 style={styles.title}>True Buddha School Live Translation</h1>

          <div style={styles.headerActions}>
            <div style={styles.actionButtons}>
              <button onClick={copyViewerLink} style={styles.primaryButton}>
                {copied ? 'Viewer link copied' : 'Copy viewer link'}
              </button>

              <button onClick={clearHistory} style={styles.secondaryButtonDark}>
                Clear
              </button>
            </div>
          </div>

          <div style={styles.topStats}>
            <div style={styles.topStatCard}>
              <div style={styles.topStatLabel}>Mode</div>
              <div style={styles.topStatValue}>Live</div>
            </div>

            <div style={styles.topStatCard}>
              <div style={styles.topStatLabel}>Lines</div>
              <div style={styles.topStatValue}>{historyLines.length}</div>
            </div>
          </div>
        </div>

        <div style={styles.languageAndMicWrap}>
          <div style={styles.floatingMicWrap}>
            <div style={styles.floatingStatus}>{getStatusLabel()}</div>

            <button
              onClick={isListening ? stopAudio : startAudio}
              style={{
                ...styles.micButton,
                ...(isListening ? styles.micButtonActive : {}),
              }}
            >
              <img src={micIcon} alt="Microphone" style={styles.micSvg} />
            </button>
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
                <option>Bahasa Indonesia</option>
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
              </select>
            </div>
          </div>
        </div>

        <div style={styles.transcriptCard}>
          {rollingBrainState?.rollingSummary || rollingBrainState?.rollingIntent || rollingBrainState?.rollingTopic ? (
            <div style={styles.brainStateCard}>
              <div style={styles.brainStateLabel}>Live context</div>
              {rollingBrainState?.rollingTopic ? (
                <div style={styles.brainStateTopic}>{rollingBrainState.rollingTopic}</div>
              ) : null}
              {rollingBrainState?.rollingSummary ? (
                <div style={styles.brainStateSummary}>{rollingBrainState.rollingSummary}</div>
              ) : null}
              {rollingBrainState?.rollingIntent ? (
                <div style={styles.brainStateIntent}>Intent: {rollingBrainState.rollingIntent}</div>
              ) : null}
            </div>
          ) : null}
          <div style={styles.transcriptHeader}>
            <div>
              <div style={styles.cardLabel}>Transcript</div>
              <div style={styles.cardHint}>Draft line appears first, then settles into history.</div>
            </div>

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
                    <div style={styles.feedMetaLeft}>
                      <div style={styles.feedMeta}>{item.time}</div>
                      {!item.isLive && item.at ? (
                        <div style={styles.feedTimePill}>{formatTime(item.at)}</div>
                      ) : null}
                    </div>

                    {item.isLive && <div style={styles.liveBadge}>Draft</div>}
                  </div>

                  <div style={styles.feedChinese}>{item.chinese || '…'}</div>

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
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    position: 'relative',
    overflow: 'hidden',
    background:
      'radial-gradient(circle at top, rgba(255,106,61,0.10) 0%, rgba(15,15,15,1) 42%), linear-gradient(180deg, #0b0b0c 0%, #121214 100%)',
    padding: '20px 16px 108px',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: '#fff',
  },
  bgOrbA: {
    position: 'absolute',
    top: '-120px',
    left: '-80px',
    width: '300px',
    height: '300px',
    borderRadius: '999px',
    background: 'rgba(255,107,53,0.10)',
    filter: 'blur(60px)',
    pointerEvents: 'none',
  },
  bgOrbB: {
    position: 'absolute',
    right: '-100px',
    bottom: '-100px',
    width: '320px',
    height: '320px',
    borderRadius: '999px',
    background: 'rgba(59,130,246,0.10)',
    filter: 'blur(70px)',
    pointerEvents: 'none',
  },
  shell: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    maxWidth: '980px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  loadingWrap: {
    minHeight: '50vh',
    display: 'grid',
    placeItems: 'center',
    color: '#fff',
    fontSize: '24px',
    fontWeight: 700,
  },
  headerCard: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '28px',
    padding: '24px 22px',
    textAlign: 'left',
    backdropFilter: 'blur(14px)',
  },
  title: {
    margin: 0,
    fontSize: '42px',
    lineHeight: 1,
    letterSpacing: '-0.04em',
    fontWeight: 800,
    color: '#fff',
    textAlign: 'left',
  },
  headerActions: {
    marginTop: '18px',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '12px',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  actionButtons: {
    display: 'flex',
    gap: '10px',
    flexWrap: 'wrap',
  },
  primaryButton: {
    border: 'none',
    background: 'linear-gradient(135deg, #ff6b35 0%, #ff8a5b 100%)',
    color: '#111',
    borderRadius: '999px',
    padding: '12px 16px',
    fontSize: '13px',
    fontWeight: 800,
    cursor: 'pointer',
    boxShadow: '0 10px 24px rgba(255,107,53,0.22)',
  },
  secondaryButtonDark: {
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(255,255,255,0.04)',
    color: '#fff',
    borderRadius: '999px',
    padding: '12px 16px',
    fontSize: '13px',
    fontWeight: 800,
    cursor: 'pointer',
  },
  topStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '12px',
    marginTop: '18px',
    maxWidth: '420px',
  },
  topStatCard: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '18px',
    padding: '14px 16px',
    textAlign: 'left',
  },
  topStatLabel: {
    fontSize: '11px',
    fontWeight: 800,
    color: '#8d8d95',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '8px',
    textAlign: 'left',
  },
  topStatValue: {
    fontSize: '15px',
    fontWeight: 800,
    color: '#fff',
    lineHeight: 1.35,
    textAlign: 'left',
  },
  languageAndMicWrap: {
    position: 'relative',
    paddingTop: '10px',
    marginTop: '-4px',
    zIndex: 3,
  },
  floatingMicWrap: {
  position: 'fixed',
  left: '50%',
  bottom: '24px',
  transform: 'translateX(-50%)',
  zIndex: 999,

  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '10px 14px',

  borderRadius: '999px',
  background: 'rgba(20,20,20,0.65)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',

  border: '1px solid rgba(255,255,255,0.14)',

  boxShadow: `
    0 20px 50px rgba(0,0,0,0.35),
    0 4px 12px rgba(0,0,0,0.15),
    inset 0 1px 0 rgba(255,255,255,0.08)
  `,
},
  floatingStatus: {
    color: '#fff',
    fontSize: '14px',
    fontWeight: 700,
    textAlign: 'left',
    paddingLeft: '6px',
    whiteSpace: 'nowrap',
  },
  micButton: {
    width: '62px',
    height: '62px',
    borderRadius: '50%',
    border: '1px solid rgba(255,255,255,0.18)',
    background: 'rgba(255,255,255,0.86)',
    color: '#111',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    boxShadow:
      '0 8px 18px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.55)',
    backdropFilter: 'blur(8px)',
  },
  micButtonActive: {
    background: 'linear-gradient(135deg, #ff6b35 0%, #ff8a5b 100%)',
  },
  micSvg: {
    width: '24px',
    height: '24px',
    objectFit: 'contain',
    display: 'block',
  },
  languageRow: {
    display: 'grid',
    gridTemplateColumns: '1fr auto 1fr',
    gap: '12px',
    alignItems: 'center',
  },
  selectCard: {
    background: 'rgba(255,255,255,0.92)',
    borderRadius: '20px',
    padding: '12px 14px',
    textAlign: 'left',
    boxShadow: '0 10px 24px rgba(0,0,0,0.12)',
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
    background: 'rgba(255,255,255,0.88)',
    display: 'grid',
    placeItems: 'center',
    fontSize: '16px',
    fontWeight: 700,
    color: '#111',
    boxShadow: '0 8px 18px rgba(0,0,0,0.12)',
  },
  transcriptCard: {
    background: '#ff764a',
    borderRadius: '28px',
    padding: '18px',
    color: '#111',
    textAlign: 'left',
    boxShadow: '0 24px 60px rgba(0,0,0,0.22)',
  },
  brainStateCard: {
    background: 'rgba(255,255,255,0.72)',
    border: '1px solid rgba(17,17,17,0.08)',
    borderRadius: '18px',
    padding: '14px 16px',
    marginBottom: '14px',
    textAlign: 'left',
  },
  brainStateLabel: {
    fontSize: '11px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#6a4130',
    marginBottom: '8px',
    textAlign: 'left',
  },
  brainStateTopic: {
    fontSize: '16px',
    fontWeight: 800,
    color: '#111',
    marginBottom: '6px',
    textAlign: 'left',
  },
  brainStateSummary: {
    fontSize: '15px',
    lineHeight: 1.45,
    fontWeight: 700,
    color: '#222',
    textAlign: 'left',
  },
  brainStateIntent: {
    marginTop: '8px',
    fontSize: '13px',
    lineHeight: 1.4,
    fontWeight: 700,
    color: '#5b4b40',
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
  cardHint: {
    marginTop: '6px',
    fontSize: '14px',
    color: '#6a4130',
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
  feedMetaLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  feedMeta: {
    fontSize: '12px',
    fontWeight: 700,
    color: '#777',
    textAlign: 'left',
  },
  feedTimePill: {
    background: '#f3e7d8',
    color: '#5b4b40',
    borderRadius: '999px',
    padding: '5px 8px',
    fontSize: '11px',
    fontWeight: 800,
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
    fontSize: '24px',
    lineHeight: 1.26,
    fontWeight: 800,
    color: '#111',
    marginBottom: '8px',
    textAlign: 'left',
    wordBreak: 'break-word',
  },
  feedEnglish: {
    fontSize: '20px',
    lineHeight: 1.4,
    fontWeight: 700,
    color: '#2450d8',
    textAlign: 'left',
    wordBreak: 'break-word',
    transition: 'opacity 160ms ease, color 160ms ease',
  },
  feedEnglishDraft: {
    color: '#5c72c9',
    opacity: 0.82,
  },
  emptyState: {
    padding: '18px 16px',
    color: '#666',
    fontSize: '15px',
    textAlign: 'left',
  },
};