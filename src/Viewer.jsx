import { useEffect, useMemo, useState } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8787';
const FIXED_SESSION_ID = 'live-session';

export default function Viewer() {
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('Loading...');

  useEffect(() => {
    let timer = null;

    const load = async () => {
      try {
        const res = await fetch(`${API}/api/session/${FIXED_SESSION_ID}`);
        if (!res.ok) {
          setStatus('Waiting for live session...');
          return;
        }

        const data = await res.json();
        setSession(data);
        setStatus('Live');
      } catch (err) {
        console.error(err);
        setStatus('Connection problem.');
      }
    };

    load();
    timer = setInterval(load, 1000);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, []);

  const lines = useMemo(() => {
    if (!session?.lines) return [];
    return [...session.lines].slice(0, 12);
  }, [session]);

  return (
    <div style={styles.page}>
      <div style={styles.shell}>
        <div style={styles.topBar}>
          <div style={styles.topLeft}>
            <div style={styles.eyebrow}>TBS V2</div>
            <h1 style={styles.title}>Live Viewer</h1>
          </div>

          <div style={styles.topRight}>
            <div style={styles.statusChip}>{status}</div>
          </div>
        </div>

        <div style={styles.viewerCard}>
          {lines.length === 0 ? (
            <div style={styles.emptyState}>Waiting for live subtitles…</div>
          ) : (
            lines.map((line) => (
              <div key={line.id} style={styles.lineCard}>
                <div style={styles.cn}>{line.normalizedCn || line.rawCn}</div>
                <div style={styles.en}>{line.en}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: '#0f0f0f',
    padding: '20px 16px 40px',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  shell: {
    width: '100%',
    maxWidth: '1100px',
    margin: '0 auto',
  },
  topBar: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '16px',
    alignItems: 'flex-start',
    marginBottom: '16px',
    flexWrap: 'wrap',
  },
  topLeft: {
    textAlign: 'left',
  },
  eyebrow: {
    fontSize: '12px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#888',
    marginBottom: '10px',
  },
  title: {
    margin: 0,
    color: '#fff',
    fontSize: '42px',
    lineHeight: 1,
    letterSpacing: '-0.04em',
    textAlign: 'left',
  },
  topRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexWrap: 'wrap',
  },
  statusChip: {
    background: '#1c1c1c',
    color: '#fff',
    borderRadius: '999px',
    padding: '10px 14px',
    fontSize: '13px',
    fontWeight: 700,
  },
  viewerCard: {
    background: '#181818',
    borderRadius: '28px',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    minHeight: '70vh',
  },
  lineCard: {
    background: '#fff7ef',
    borderRadius: '22px',
    padding: '18px 20px',
  },
  cn: {
    fontSize: '34px',
    lineHeight: 1.3,
    fontWeight: 800,
    color: '#111',
    textAlign: 'left',
    marginBottom: '10px',
    wordBreak: 'break-word',
  },
  en: {
    fontSize: '28px',
    lineHeight: 1.35,
    fontWeight: 700,
    color: '#2450d8',
    textAlign: 'left',
    wordBreak: 'break-word',
  },
  emptyState: {
    color: '#ddd',
    fontSize: '28px',
    fontWeight: 700,
    textAlign: 'left',
    padding: '16px',
  },
};