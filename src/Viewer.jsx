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

  return (
    <div style={styles.page}>
      <div style={styles.shell}>
        <header style={styles.topBar}>
          <div style={styles.topBarLeft}>
            <div style={styles.topBarTitleRow}>
              <div style={styles.cardLabel}>Viewer</div>
            </div>
            <div style={styles.topBarBadges}>
              <span style={styles.badge}>Session: {FIXED_SESSION_ID}</span>
              <span style={styles.badge}>Socket: {socketState}</span>
              <span style={styles.badge}>Showing: {visibleLines.length}/{totalLines}</span>
            </div>
          </div>

          <div style={styles.topBarRight}>
            <button type="button" onClick={fetchSession} style={styles.secondaryButton}>
              Refresh
            </button>
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={!canLoadMore}
              style={{
                ...styles.secondaryButton,
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
              style={styles.secondaryButton}
            >
              Latest
            </button>
          </div>
        </header>

        {error ? <div style={styles.errorBanner}>{error}</div> : null}

        <div style={styles.transcriptCard}>
          <div style={styles.transcriptAccent} />

          {brainStateHistory.length > 0 ? (
            <div style={styles.brainStateScrollCard}>
              <div style={styles.brainStateLabel}>Live context</div>
              <div style={styles.brainStateScrollFeed}>
                {brainStateHistory.map((entry) => (
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
    background:
      'radial-gradient(circle at top, rgba(255,106,61,0.10) 0%, rgba(15,15,15,1) 42%), linear-gradient(180deg, #0b0b0c 0%, #121214 100%)',
    padding: '20px 16px 28px',
    color: '#fff',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  shell: {
    width: '100%',
    maxWidth: '980px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  topBar: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
  },
  topBarLeft: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    flexWrap: 'wrap',
    minWidth: '260px',
    flex: '1 1 320px',
  },
  topBarTitleRow: {
    display: 'flex',
    gap: '10px',
    alignItems: 'baseline',
    flexWrap: 'wrap',
  },
  topBarBadges: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
  },
  topBarRight: {
    display: 'flex',
    gap: '10px',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '7px 10px',
    borderRadius: '999px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    color: '#e5e7eb',
    fontSize: '12px',
    fontWeight: 700,
  },
  secondaryButton: {
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '999px',
    padding: '10px 12px',
    fontSize: '12px',
    fontWeight: 800,
    background: 'rgba(255,255,255,0.04)',
    color: '#fff',
    cursor: 'pointer',
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
    background: 'rgba(20,20,22,0.92)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '22px',
    padding: '14px',
    boxShadow: '0 24px 60px rgba(0,0,0,0.28)',
    backdropFilter: 'blur(16px)',
  },
  transcriptAccent: {
    height: '2px',
    width: '100%',
    borderRadius: '999px',
    background:
      'linear-gradient(90deg, rgba(255,107,53,0.0) 0%, rgba(255,107,53,0.85) 50%, rgba(255,107,53,0.0) 100%)',
    marginBottom: '12px',
  },
  brainStateScrollCard: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '18px',
    padding: '12px 14px',
    marginBottom: '12px',
    textAlign: 'left',
  },
  brainStateLabel: {
    fontSize: '11px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#b8b8c2',
    marginBottom: '8px',
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
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  brainStateScrollMeta: {
    fontSize: '12px',
    fontWeight: 800,
    color: '#9ca3af',
  },
  brainStateScrollText: {
    fontSize: '13px',
    lineHeight: 1.45,
    fontWeight: 700,
    color: '#f3f4f6',
    wordBreak: 'break-word',
  },
  transcriptHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '12px',
    flexWrap: 'wrap',
  },
  cardLabel: {
    fontSize: '12px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#b8b8c2',
  },
  debugChip: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.08)',
    color: '#fff',
    borderRadius: '999px',
    padding: '8px 10px',
    fontSize: '12px',
    fontWeight: 800,
  },
  transcriptFeed: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    maxHeight: '62vh',
    overflowY: 'auto',
    background: 'rgba(255,255,255,0.03)',
    borderRadius: '18px',
    padding: '6px 0',
    scrollBehavior: 'smooth',
  },
  feedRow: {
    padding: '12px 14px 14px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    transition: 'background 160ms ease',
  },
  feedRowLive: {
    background: 'rgba(255,107,53,0.08)',
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
    color: '#9ca3af',
  },
  feedTimePill: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.08)',
    color: '#e5e7eb',
    borderRadius: '999px',
    padding: '5px 8px',
    fontSize: '11px',
    fontWeight: 800,
  },
  liveBadge: {
    fontSize: '11px',
    fontWeight: 800,
    color: '#111',
    background: 'linear-gradient(135deg, #ff6b35 0%, #ff8a5b 100%)',
    borderRadius: '999px',
    padding: '6px 9px',
  },
  feedChinese: {
    fontSize: '20px',
    lineHeight: 1.28,
    fontWeight: 800,
    color: '#fff',
    marginBottom: '8px',
    wordBreak: 'break-word',
  },
  feedEnglish: {
    fontSize: '17px',
    lineHeight: 1.4,
    fontWeight: 700,
    color: '#c7d2fe',
    wordBreak: 'break-word',
  },
  feedEnglishDraft: {
    opacity: 0.88,
  },
  emptyState: {
    padding: '16px 14px',
    color: '#b8b8c2',
    fontSize: '14px',
    fontWeight: 700,
  },
};