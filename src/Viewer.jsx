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

  return (
    <div style={styles.page}>
      <div style={styles.bgOrbA} />
      <div style={styles.bgOrbB} />

      <div style={styles.shell}>
        <header style={styles.hero}>
          <div style={styles.heroLeft}>
            <div style={styles.eyebrow}>TBS V2 • Standalone Viewer</div>
            <h1 style={styles.title}>Live Viewer</h1>
            <div style={styles.subtitle}>
              Shared live session stream for read-only viewing
            </div>
          </div>

          <div style={styles.heroRight}>
            <div style={styles.metricCard}>
              <div style={styles.metricLabel}>Status</div>
              <div style={styles.metricValue}>{status}</div>
            </div>

            <div style={styles.metricCard}>
              <div style={styles.metricLabel}>Lines</div>
              <div style={styles.metricValue}>{totalLines}</div>
            </div>

            <div style={styles.metricCard}>
              <div style={styles.metricLabel}>Updated</div>
              <div style={styles.metricValueSmall}>
                {lastUpdated ? formatTime(lastUpdated) : '—'}
              </div>
            </div>
          </div>
        </header>

        <section style={styles.controlBar}>
          <div style={styles.controlLeft}>
            <div style={styles.badge}>
              <span style={{ ...styles.badgeDot, background: '#22c55e' }} />
              Session: {FIXED_SESSION_ID}
            </div>

            <div style={styles.badge}>
              <span style={{ ...styles.badgeDot, background: '#60a5fa' }} />
              Socket: {socketState}
            </div>

            <div style={styles.badge}>
              <span style={{ ...styles.badgeDot, background: '#f59e0b' }} />
              Showing: {visibleLines.length}/{totalLines}
            </div>
          </div>

          <div style={styles.controlRight}>
            <button
              type="button"
              onClick={fetchSession}
              style={styles.secondaryButton}
            >
              Refresh
            </button>

            <button
              type="button"
              onClick={handleLoadMore}
              disabled={!canLoadMore}
              style={{
                ...styles.primaryButton,
                opacity: canLoadMore ? 1 : 0.45,
                cursor: canLoadMore ? 'pointer' : 'not-allowed',
              }}
            >
              {canLoadMore ? 'Load older lines' : 'All loaded'}
            </button>
          </div>
        </section>

        {error ? <div style={styles.errorBanner}>{error}</div> : null}

        <div style={styles.summaryRow}>
          <div style={styles.summaryCard}>
            <div style={styles.summaryLabel}>Event mode</div>
            <div style={styles.summaryValue}>
              {session?.eventMode || 'Dharma Talk'}
            </div>
          </div>

          <div style={styles.summaryCard}>
            <div style={styles.summaryLabel}>Last line time</div>
            <div style={styles.summaryValue}>
              {latestLine?.at ? `${formatDate(latestLine.at)} ${formatTime(latestLine.at)}` : '—'}
            </div>
          </div>

          <div style={styles.summaryCard}>
            <div style={styles.summaryLabel}>Auto-scroll</div>
            <div style={styles.summaryValue}>{autoScroll ? 'On' : 'Paused'}</div>
          </div>
        </div>

        <main
          ref={scrollRef}
          onScroll={handleScroll}
          style={styles.viewerCard}
        >
          {visibleLines.length === 0 ? (
            <div style={styles.emptyState}>
              <div style={styles.emptyTitle}>Waiting for live subtitles…</div>
              <div style={styles.emptyText}>
                As lines arrive in the shared live session, they will appear here.
              </div>
            </div>
          ) : (
            visibleLines.map((line, index) => {
              const timestamp = line.at || line.createdAt || line.timestamp;
              const cn = line.normalizedCn || line.rawCn || '';
              const rawCn = line.rawCn || '';
              const en = line.en || (line.isInterim ? 'Translating…' : '—');
              const meta = line.translationMeta || {};
              const confidence = meta.band || 'high';
              const isLow = confidence === 'low';
              const isMedium = confidence === 'medium';

              return (
                <article key={line.id || `${timestamp}-${index}`} style={styles.lineCard}>
                  <div style={styles.lineMeta}>
                    <div style={styles.lineMetaLeft}>
                      <span style={styles.metaPill}>#{totalLines - visibleLines.length + index + 1}</span>
                      <span style={styles.metaPillSecondary}>{formatDate(timestamp)}</span>
                      <span style={styles.metaPillTime}>{formatTime(timestamp)}</span>
                    </div>

                    <div style={styles.lineMetaRight}>
                      {line.isInterim ? (
                        <span style={styles.metaHintLive}>live now</span>
                      ) : rawCn && rawCn !== cn ? (
                        <span style={styles.metaHint}>normalized</span>
                      ) : (
                        <span style={styles.metaHint}>live</span>
                      )}
                    </div>
                  </div>

                  {rawCn && rawCn !== cn ? (
                    <div style={styles.rawBlock}>
                      <div style={styles.blockLabel}>Raw ASR</div>
                      <div style={styles.rawCn}>{rawCn}</div>
                    </div>
                  ) : null}

                  <div style={styles.cnBlock}>
                    <div style={styles.blockLabel}>Chinese</div>
                    <div
                      style={{
                        ...styles.cn,
                        ...(isLow
                          ? styles.feedChineseLowConfidence
                          : isMedium
                            ? styles.feedChineseMediumConfidence
                            : styles.feedChineseHighConfidence),
                      }}
                    >
                      {cn}
                    </div>
                  </div>

                  <div style={styles.enBlock}>
                    <div style={styles.blockLabel}>English</div>
                    <div
                      style={{
                        ...styles.en,
                        ...(isLow
                          ? styles.feedEnglishLowConfidence
                          : isMedium
                            ? styles.feedEnglishMediumConfidence
                            : styles.feedEnglishHighConfidence),
                      }}
                    >
                      {en}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </main>

        <footer style={styles.footer}>
          <div style={styles.footerText}>
            Viewer route stays standalone. No tab navigation rendered here.
          </div>

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
            Jump to latest
          </button>
        </footer>
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
    padding: '24px 16px 40px',
    color: '#fff',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
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
    maxWidth: '1180px',
    margin: '0 auto',
  },
  hero: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '18px',
    alignItems: 'flex-end',
    marginBottom: '18px',
    flexWrap: 'wrap',
  },
  heroLeft: {
    textAlign: 'left',
  },
  eyebrow: {
    fontSize: '12px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.10em',
    color: '#8d8d95',
    marginBottom: '10px',
  },
  title: {
    margin: 0,
    color: '#fff',
    fontSize: '44px',
    lineHeight: 1,
    letterSpacing: '-0.04em',
    textAlign: 'left',
  },
  subtitle: {
    marginTop: '10px',
    color: '#b8b8c2',
    fontSize: '15px',
    fontWeight: 500,
  },
  heroRight: {
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap',
  },
  metricCard: {
    minWidth: '110px',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '18px',
    padding: '12px 14px',
    backdropFilter: 'blur(12px)',
  },
  metricLabel: {
    fontSize: '11px',
    fontWeight: 800,
    color: '#8d8d95',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '8px',
  },
  metricValue: {
    fontSize: '20px',
    fontWeight: 800,
    color: '#fff',
  },
  metricValueSmall: {
    fontSize: '14px',
    fontWeight: 800,
    color: '#fff',
  },
  controlBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '14px',
    flexWrap: 'wrap',
    marginBottom: '14px',
    padding: '14px',
    borderRadius: '20px',
    background: 'rgba(24,24,26,0.88)',
    border: '1px solid rgba(255,255,255,0.08)',
    backdropFilter: 'blur(14px)',
  },
  controlLeft: {
    display: 'flex',
    gap: '10px',
    flexWrap: 'wrap',
  },
  controlRight: {
    display: 'flex',
    gap: '10px',
    flexWrap: 'wrap',
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    borderRadius: '999px',
    background: '#202024',
    border: '1px solid rgba(255,255,255,0.06)',
    color: '#e5e7eb',
    fontSize: '12px',
    fontWeight: 700,
  },
  badgeDot: {
    width: '8px',
    height: '8px',
    borderRadius: '999px',
    display: 'inline-block',
  },
  primaryButton: {
    border: 'none',
    borderRadius: '14px',
    padding: '11px 16px',
    fontSize: '13px',
    fontWeight: 800,
    background: 'linear-gradient(135deg, #ff6b35 0%, #ff8a5b 100%)',
    color: '#111',
    boxShadow: '0 10px 24px rgba(255,107,53,0.22)',
  },
  secondaryButton: {
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '14px',
    padding: '11px 16px',
    fontSize: '13px',
    fontWeight: 800,
    background: '#1b1b1f',
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
  summaryRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '12px',
    marginBottom: '14px',
  },
  summaryCard: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '18px',
    padding: '14px 16px',
  },
  summaryLabel: {
    fontSize: '11px',
    fontWeight: 800,
    color: '#8d8d95',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '8px',
  },
  summaryValue: {
    fontSize: '15px',
    fontWeight: 800,
    color: '#fff',
    lineHeight: 1.35,
  },
  viewerCard: {
    background: 'rgba(20,20,22,0.92)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '28px',
    padding: '18px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    minHeight: '72vh',
    maxHeight: '72vh',
    overflowY: 'auto',
    boxShadow: '0 24px 60px rgba(0,0,0,0.28)',
    backdropFilter: 'blur(16px)',
  },
  lineCard: {
    background: 'linear-gradient(180deg, #fff8ef 0%, #fff3e3 100%)',
    border: '1px solid rgba(255,140,90,0.12)',
    borderRadius: '24px',
    padding: '18px 18px 16px',
    boxShadow: '0 10px 24px rgba(0,0,0,0.08)',
  },
  lineMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '10px',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: '12px',
  },
  lineMetaLeft: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  lineMetaRight: {
    display: 'flex',
    alignItems: 'center',
  },
  metaPill: {
    background: '#111',
    color: '#fff',
    borderRadius: '999px',
    padding: '6px 10px',
    fontSize: '11px',
    fontWeight: 800,
    letterSpacing: '0.04em',
  },
  metaPillSecondary: {
    background: '#f3e7d8',
    color: '#4b5563',
    borderRadius: '999px',
    padding: '6px 10px',
    fontSize: '11px',
    fontWeight: 800,
  },
  metaPillTime: {
    background: '#2450d8',
    color: '#fff',
    borderRadius: '999px',
    padding: '6px 10px',
    fontSize: '11px',
    fontWeight: 800,
  },
  metaHint: {
    fontSize: '11px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#9a6b4d',
  },
  metaHintLive: {
    fontSize: '11px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#ff6b35',
  },
  blockLabel: {
    fontSize: '11px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#8d5c3f',
    marginBottom: '8px',
  },
  rawBlock: {
    marginBottom: '12px',
    background: 'rgba(17,17,17,0.04)',
    borderRadius: '16px',
    padding: '12px 14px',
  },
  rawCn: {
    fontSize: '18px',
    lineHeight: 1.5,
    fontWeight: 600,
    color: '#5b5b66',
    wordBreak: 'break-word',
  },
  cnBlock: {
    marginBottom: '12px',
  },
  cn: {
    fontSize: '34px',
    lineHeight: 1.3,
    fontWeight: 800,
    color: '#111',
    textAlign: 'left',
    wordBreak: 'break-word',
  },
  feedChineseHighConfidence: {
    fontSize: '34px',
    opacity: 0.68,
  },
  feedChineseMediumConfidence: {
    fontSize: '24px',
    opacity: 0.88,
  },
  feedChineseLowConfidence: {
    fontSize: '38px',
    opacity: 1,
    color: '#111',
  },
  enBlock: {},
  en: {
    fontSize: '28px',
    lineHeight: 1.38,
    fontWeight: 700,
    color: '#2450d8',
    textAlign: 'left',
    wordBreak: 'break-word',
  },
  feedEnglishHighConfidence: {
    opacity: 1,
    color: '#2450d8',
  },
  feedEnglishMediumConfidence: {
    opacity: 1,
    color: '#2450d8',
  },
  feedEnglishLowConfidence: {
    opacity: 1,
    color: '#2450d8',
  },
  emptyState: {
    color: '#ddd',
    fontSize: '24px',
    fontWeight: 700,
    textAlign: 'left',
    padding: '18px',
  },
  emptyTitle: {
    fontSize: '28px',
    fontWeight: 800,
    marginBottom: '10px',
    color: '#fff',
  },
  emptyText: {
    fontSize: '15px',
    lineHeight: 1.6,
    color: '#b8b8c2',
    maxWidth: '520px',
  },
  footer: {
    marginTop: '14px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
  },
  footerText: {
    color: '#8d8d95',
    fontSize: '12px',
    fontWeight: 700,
  },
};