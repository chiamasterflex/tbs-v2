import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8787';
const WS_URL =
  import.meta.env.VITE_WS_URL ||
  API.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
const FIXED_SESSION_ID = 'live-session';
const POLL_MS = 3000;
const INITIAL_VISIBLE_COUNT = 24;
const LOAD_MORE_STEP = 24;
const MAX_VISIBLE_COUNT = 500;

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

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';

  return d.toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function Viewer() {
  const scrollRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('Loading…');
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
  const [autoScroll, setAutoScroll] = useState(true);
  const [socketState, setSocketState] = useState('Connecting…');
  const [liveInterim, setLiveInterim] = useState(null);
  const [rollingBrainState, setRollingBrainState] = useState(null);
  const [brainStateHistory, setBrainStateHistory] = useState([]);

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/session/${FIXED_SESSION_ID}`, {
        cache: 'no-store',
      });

      if (!res.ok) {
        setStatus((prev) => (prev === 'Live via WebSocket' ? prev : 'Waiting for live session…'));
        setError('');
        return;
      }

      const data = await res.json();
      setSession(data);
      setStatus((prev) => (prev === 'Live via WebSocket' ? prev : 'Live'));
      setError('');
      setLastUpdated(new Date().toISOString());
    } catch (err) {
      console.error(err);
      setStatus((prev) => (prev === 'Live via WebSocket' ? prev : 'Connection problem'));
      setError('Could not reach the live session API.');
    }
  }, []);

  useEffect(() => {
    let timer = null;

    fetchSession();
    timer = setInterval(fetchSession, POLL_MS);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [fetchSession]);

  useEffect(() => {
    let cancelled = false;

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        connectViewerSocket();
      }, 1200);
    };

    const handleSocketMessage = (event) => {
      try {
        const payload = JSON.parse(event.data);

        if (payload?.type === 'live_cn') {
          setLiveInterim({
            id: '__live_interim__',
            at: new Date().toISOString(),
            normalizedCn: payload.cn || '',
            rawCn: payload.rawCn || payload.cn || '',
            en: payload.en || '',
            translationMeta: payload.translationMeta || { band: 'medium' },
            isInterim: true,
          });
          setStatus('Live via WebSocket');
          setSocketState('Live');
          setLastUpdated(new Date().toISOString());
          setError('');
          return;
        }

        if (payload?.type === 'final') {
          setLiveInterim(null);
          setSession((prev) => {
            const prevLines = Array.isArray(prev?.lines) ? prev.lines : [];
            const incoming = payload.line || payload;
            const incomingId = incoming?.id;
            const deduped = incomingId
              ? prevLines.filter((line) => line?.id !== incomingId)
              : prevLines;

            return {
              ...(prev || {}),
              id: prev?.id || FIXED_SESSION_ID,
              eventMode: prev?.eventMode || 'Dharma Talk',
              lines: [incoming, ...deduped],
            };
          });
          setStatus('Live via WebSocket');
          setSocketState('Live');
          setLastUpdated(new Date().toISOString());
          setError('');
          return;
        }

        if (payload?.type === 'brain_state') {
          const nextBrainState = payload.brainState || null;
          setRollingBrainState(nextBrainState);

          if (
            nextBrainState?.rollingSummary ||
            nextBrainState?.rollingIntent ||
            nextBrainState?.rollingTopic
          ) {
            setBrainStateHistory((prev) => {
              const entryId = `${nextBrainState.rollingUpdatedAt || Date.now()}-${nextBrainState.rollingTopic || ''}-${nextBrainState.rollingIntent || ''}`;
              if (prev[0]?.id === entryId) return prev;

              return [
                {
                  id: entryId,
                  rollingSummary: nextBrainState.rollingSummary || '',
                  rollingIntent: nextBrainState.rollingIntent || '',
                  rollingTopic: nextBrainState.rollingTopic || '',
                  rollingUpdatedAt:
                    nextBrainState.rollingUpdatedAt || new Date().toISOString(),
                  confidence: nextBrainState.confidence,
                },
                ...prev,
              ].slice(0, 24);
            });
          }

          return;
        }

        if (payload?.type === 'session' && payload?.session) {
          setSession(payload.session);
          setStatus('Live via WebSocket');
          setSocketState('Live');
          setLastUpdated(new Date().toISOString());
          setError('');
        }
      } catch (err) {
        console.error('Viewer socket parse error', err);
      }
    };

    const connectViewerSocket = () => {
      if (cancelled) return;

      try {
        setSocketState('Connecting…');
        const ws = new WebSocket(
          `${WS_URL}?viewer=1&sessionId=${encodeURIComponent(FIXED_SESSION_ID)}`
        );
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) return;
          setSocketState('Connected');
          setError('');
        };

        ws.onmessage = handleSocketMessage;

        ws.onerror = (err) => {
          console.error('Viewer socket error', err);
          setSocketState('Socket error');
        };

        ws.onclose = () => {
          if (cancelled) return;
          setSocketState('Reconnecting…');
          scheduleReconnect();
        };
      } catch (err) {
        console.error('Viewer socket setup failed', err);
        setSocketState('Socket unavailable');
        scheduleReconnect();
      }
    };

    connectViewerSocket();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [fetchSession]);

  const lines = useMemo(() => {
    const raw = Array.isArray(session?.lines) ? session.lines : [];

    // Backend stores newest first via unshift().
    // Viewer should read naturally: older at top, newest at bottom.
    const ordered = [...raw].reverse();

    if (liveInterim?.normalizedCn || liveInterim?.en) {
      return [...ordered, liveInterim];
    }

    return ordered;
  }, [session, liveInterim]);

  const visibleLines = useMemo(() => {
    if (!lines.length) return [];
    return lines.slice(Math.max(0, lines.length - visibleCount));
  }, [lines, visibleCount]);

  useEffect(() => {
    if (!autoScroll) return;
    if (!visibleLines.length) return;

    const el = scrollRef.current;
    if (!el) return;

    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [visibleLines, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoScroll(nearBottom);
  }, []);

  const handleLoadMore = useCallback(() => {
    setVisibleCount((prev) => Math.min(prev + LOAD_MORE_STEP, MAX_VISIBLE_COUNT));
  }, []);

  const latestLine = lines.length ? lines[lines.length - 1] : null;
  const canLoadMore = visibleCount < Math.min(lines.length, MAX_VISIBLE_COUNT);
  const totalLines = lines.length;

  const feedItems = useMemo(() => {
    return visibleLines.map((line) => {
      const timestamp = line.at || line.createdAt || line.timestamp;
      const cn = line.normalizedCn || line.rawCn || '';
      const en = line.en || (line.isInterim ? 'Translating…' : '');
      return {
        id: line.id || `${timestamp}-${cn.slice(0, 12)}`,
        at: timestamp,
        time: line.isInterim ? 'Live' : formatTime(timestamp),
        chinese: cn,
        english: en,
        isLive: Boolean(line.isInterim),
      };
    });
  }, [visibleLines]);

  const liveContextItems = useMemo(() => {
    if (brainStateHistory.length > 0) return brainStateHistory;

    if (
      rollingBrainState?.rollingSummary ||
      rollingBrainState?.rollingIntent ||
      rollingBrainState?.rollingTopic
    ) {
      return [
        {
          id: `fallback-${rollingBrainState.rollingUpdatedAt || 'now'}`,
          rollingSummary: rollingBrainState.rollingSummary || '',
          rollingIntent: rollingBrainState.rollingIntent || '',
          rollingTopic: rollingBrainState.rollingTopic || '',
          rollingUpdatedAt: rollingBrainState.rollingUpdatedAt || new Date().toISOString(),
          confidence: rollingBrainState.confidence,
        },
      ];
    }

    return [];
  }, [brainStateHistory, rollingBrainState]);

  return (
    <div style={styles.page}>
      <div style={styles.bgOrbA} />
      <div style={styles.bgOrbB} />

      <div style={styles.shell}>
        <div style={styles.headerCard}>
          <h1 style={styles.title}>True Buddha School Live Translation</h1>

          <div style={styles.headerActions}>
            <div style={styles.actionButtons}>
              <button type="button" onClick={fetchSession} style={styles.secondaryButtonDark}>
                Refresh
              </button>
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={!canLoadMore}
                style={{
                  ...styles.secondaryButtonDark,
                  opacity: canLoadMore ? 1 : 0.45,
                  cursor: canLoadMore ? 'pointer' : 'not-allowed',
                }}
              >
                Load older
              </button>
              <button
                type="button"
                onClick={() => {
                  const el = scrollRef.current;
                  if (!el) return;
                  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                  setAutoScroll(true);
                }}
                style={styles.secondaryButtonDark}
              >
                Latest
              </button>
            </div>
          </div>

          <div style={styles.topStats}>
            <div style={styles.topStatCard}>
              <div style={styles.topStatLabel}>Mode</div>
              <div style={styles.topStatValue}>Viewer</div>
            </div>

            <div style={styles.topStatCard}>
              <div style={styles.topStatLabel}>Lines</div>
              <div style={styles.topStatValue}>
                {visibleLines.length}/{totalLines}
              </div>
            </div>
          </div>
        </div>

        {error ? <div style={styles.errorBanner}>{error}</div> : null}

        <div style={styles.transcriptCard}>
          {liveContextItems.length > 0 ? (
            <div style={styles.brainStateScrollCard}>
              <div style={styles.brainStateLabel}>Live context</div>
              <div style={styles.brainStateScrollFeed}>
                {liveContextItems.map((entry) => (
                  <div key={entry.id} style={styles.brainStateScrollRow}>
                    <div style={styles.brainStateScrollMeta}>
                      {entry.rollingUpdatedAt ? formatTime(entry.rollingUpdatedAt) : '—'}
                    </div>
                    <div style={styles.brainStateScrollText}>
                      {entry.rollingTopic ? `${entry.rollingTopic}: ` : ''}
                      {entry.rollingSummary || ''}
                      {entry.rollingIntent ? ` (${entry.rollingIntent})` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div style={styles.transcriptHeader}>
            <div>
              <div style={styles.cardLabel}>Transcript</div>
              <div style={styles.cardHint}>Draft line appears first, then settles into history.</div>
            </div>
            <div style={styles.debugChip}>
              {latestLine?.at ? formatTime(latestLine.at) : status}
            </div>
          </div>

          <div ref={scrollRef} onScroll={handleScroll} style={styles.transcriptFeed}>
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
                    {item.isLive ? <div style={styles.liveBadge}>Draft</div> : null}
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
  errorBanner: {
    marginBottom: '14px',
    padding: '14px 16px',
    borderRadius: '18px',
    background: 'rgba(127,29,29,0.30)',
    border: '1px solid rgba(248,113,113,0.25)',
    color: '#fecaca',
    fontWeight: 700,
  },
  transcriptCard: {
    background: '#ff764a',
    borderRadius: '28px',
    padding: '18px',
    color: '#111',
    textAlign: 'left',
    boxShadow: '0 24px 60px rgba(0,0,0,0.22)',
  },
  brainStateScrollCard: {
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
  brainStateScrollFeed: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    maxHeight: '180px',
    overflowY: 'auto',
    paddingRight: '4px',
  },
  brainStateScrollRow: {
    display: 'grid',
    gridTemplateColumns: '84px 1fr',
    gap: '10px',
    alignItems: 'start',
    paddingBottom: '10px',
    borderBottom: '1px solid rgba(17,17,17,0.08)',
    textAlign: 'left',
  },
  brainStateScrollMeta: {
    fontSize: '12px',
    fontWeight: 800,
    color: '#7a5a4a',
    textAlign: 'left',
  },
  brainStateScrollText: {
    fontSize: '14px',
    lineHeight: 1.45,
    fontWeight: 700,
    color: '#222',
    textAlign: 'left',
    wordBreak: 'break-word',
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
    flexWrap: 'wrap',
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
