import { useEffect, useRef, useState } from 'react';
import ToolTabs from './ToolTabs';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8787';
const STUDY_STORAGE_KEY = 'tbs.study.state';

function readPersistedStudyState() {
  try {
    const raw = window.localStorage.getItem(STUDY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      input: String(parsed.input || ''),
      translation: String(parsed.translation || ''),
      lastUpdatedAt: String(parsed.lastUpdatedAt || ''),
    };
  } catch (err) {
    console.warn('[Study] failed to restore state', err.message);
    return null;
  }
}

function persistStudyState(nextState) {
  try {
    window.localStorage.setItem(STUDY_STORAGE_KEY, JSON.stringify(nextState));
  } catch (err) {
    console.warn('[Study] failed to persist state', err.message);
  }
}

function clearPersistedStudyState() {
  try {
    window.localStorage.removeItem(STUDY_STORAGE_KEY);
  } catch (err) {
    console.warn('[Study] failed to clear persisted state', err.message);
  }
}

export default function Study() {
  const persistedStateRef = useRef(null);
  if (persistedStateRef.current === null) {
    persistedStateRef.current = readPersistedStudyState() || {
      input: '',
      translation: '',
      lastUpdatedAt: '',
    };
  }

  const [input, setInput] = useState(persistedStateRef.current.input);
  const [output, setOutput] = useState(persistedStateRef.current.translation);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(persistedStateRef.current.lastUpdatedAt);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);

  const requestRef = useRef(null);

  useEffect(() => {
    if (!input && !output && !lastUpdatedAt) {
      clearPersistedStudyState();
      return;
    }

    persistStudyState({
      input,
      translation: output,
      lastUpdatedAt,
    });
  }, [input, output, lastUpdatedAt]);

  useEffect(() => {
    return () => {
      if (requestRef.current) {
        requestRef.current.abort();
        requestRef.current = null;
      }
    };
  }, []);

  const translate = async () => {
    const text = input.trim();
    if (!text) return;

    if (requestRef.current) {
      requestRef.current.abort();
    }

    const controller = new AbortController();
    requestRef.current = controller;

    setLoading(true);
    setStreaming(false);
    setOutput('');

    try {
      const res = await fetch(`${API}/api/study-translate-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          text,
          eventMode: 'Dharma Talk',
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText || 'Translation failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let firstChunkReceived = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;

        if (!firstChunkReceived) {
          firstChunkReceived = true;
          setStreaming(true);
        }

        const cleaned = accumulated.replace(/\[\d+\]/g, '').trim();
        setOutput(cleaned);
      }

      const finalText = accumulated.replace(/\[\d+\]/g, '').trim();
      setOutput(finalText || 'No translation returned');
      setLastUpdatedAt(new Date().toISOString());
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err);
      setOutput('Error translating');
      setLastUpdatedAt(new Date().toISOString());
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
      }
      setLoading(false);
      setStreaming(false);
    }
  };

  return (
    <div style={styles.page}>
      <style>{`
        @keyframes tbsShimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes tbsBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
      <div style={styles.bgOrbA} />
      <div style={styles.bgOrbB} />

      <div style={styles.container}>
        <ToolTabs current="study" />

        <div style={styles.heroCard}>
          <div style={styles.eyebrow}>TBS V2</div>
          <h1 style={styles.title}>Study Translation</h1>
          <p style={styles.subtitle}>
            Paste Chinese text and get a TBS-aware English translation.
          </p>

          <div style={styles.statRow}>
            <div style={styles.statCard}>
              <div style={styles.statLabel}>Mode</div>
              <div style={styles.statValue}>Study</div>
            </div>

            <div style={styles.statCard}>
              <div style={styles.statLabel}>Engine</div>
              <div style={styles.statValue}>Server Brain</div>
            </div>
          </div>
        </div>

        <div style={styles.mainCard}>
          <div style={styles.sectionHeader}>
            <div>
              <div style={styles.sectionLabel}>Source text</div>
              <div style={styles.sectionHint}>Chinese input for one-off testing</div>
            </div>
          </div>

          <textarea
            style={styles.textarea}
            placeholder="Paste Chinese text here..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />

          <div style={styles.buttonRow}>
            <button style={styles.primaryButton} onClick={translate} disabled={loading}>
              {loading ? (streaming ? 'Translating…' : 'Sending…') : 'Translate'}
            </button>

            <button
              style={styles.secondaryButton}
              onClick={() => {
                if (requestRef.current) {
                  requestRef.current.abort();
                  requestRef.current = null;
                }
                setInput('');
                setOutput('');
                setLastUpdatedAt('');
                setLoading(false);
                setStreaming(false);
                clearPersistedStudyState();
              }}
            >
              Clear Study
            </button>
          </div>

          {loading && !streaming ? (
            <div style={styles.resultsWrap}>
              <div style={styles.resultCard}>
                <div style={styles.resultLabel}>English</div>
                <div style={styles.skeletonRow} />
                <div style={{ ...styles.skeletonRow, width: '92%' }} />
                <div style={{ ...styles.skeletonRow, width: '78%' }} />
                <div style={{ ...styles.skeletonRow, width: '95%' }} />
                <div style={{ ...styles.skeletonRow, width: '60%' }} />
              </div>
            </div>
          ) : output ? (
            <div style={styles.resultsWrap}>
              {lastUpdatedAt ? (
                <div style={styles.updatedAt}>
                  Saved {new Date(lastUpdatedAt).toLocaleString()}
                </div>
              ) : null}

              <div style={styles.resultCard}>
                <div style={styles.resultLabel}>
                  English{streaming ? ' · translating…' : ''}
                </div>
                <div style={styles.resultText}>
                  {output}
                  {streaming ? <span style={styles.cursor}>▋</span> : null}
                </div>
              </div>
            </div>
          ) : null}
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
    padding: '24px 16px 40px',
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
  container: {
    position: 'relative',
    zIndex: 1,
    maxWidth: '980px',
    width: '100%',
    minWidth: 0,
    margin: '0 auto',
  },
  heroCard: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '28px',
    padding: '24px 22px',
    marginBottom: '16px',
    backdropFilter: 'blur(14px)',
  },
  eyebrow: {
    fontSize: '12px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.10em',
    color: '#8d8d95',
    marginBottom: '10px',
    textAlign: 'left',
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
  subtitle: {
    margin: '12px 0 18px',
    fontSize: '15px',
    lineHeight: 1.5,
    color: '#b8b8c2',
    textAlign: 'left',
    maxWidth: '640px',
  },
  statRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: '12px',
  },
  statCard: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '18px',
    padding: '14px 16px',
    textAlign: 'left',
  },
  statLabel: {
    fontSize: '11px',
    fontWeight: 800,
    color: '#8d8d95',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '8px',
    textAlign: 'left',
  },
  statValue: {
    fontSize: '15px',
    fontWeight: 800,
    color: '#fff',
    textAlign: 'left',
  },
  mainCard: {
    background: '#fff7ef',
    borderRadius: '28px',
    padding: '22px',
    color: '#111',
    boxShadow: '0 24px 60px rgba(0,0,0,0.22)',
    boxSizing: 'border-box',
    maxWidth: '100%',
    minWidth: 0,
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    alignItems: 'center',
    marginBottom: '12px',
  },
  sectionLabel: {
    fontSize: '12px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#666',
    textAlign: 'left',
  },
  sectionHint: {
    marginTop: '6px',
    fontSize: '14px',
    color: '#666',
    textAlign: 'left',
  },
  textarea: {
    width: '100%',
    minHeight: 220,
    boxSizing: 'border-box',
    border: '1px solid rgba(17,17,17,0.10)',
    borderRadius: '20px',
    padding: '16px',
    fontSize: '17px',
    resize: 'vertical',
    outline: 'none',
    fontFamily: 'inherit',
    background: '#fff',
    color: '#111',
    caretColor: '#111',
    WebkitTextFillColor: '#111',
    textAlign: 'left',
    lineHeight: 1.6,
    marginBottom: '16px',
    whiteSpace: 'pre-wrap',
  },
  buttonRow: {
    display: 'flex',
    gap: '10px',
    flexWrap: 'wrap',
    marginBottom: '20px',
  },
  primaryButton: {
    border: 'none',
    background: 'linear-gradient(135deg, #ff6b35 0%, #ff8a5b 100%)',
    color: '#111',
    borderRadius: '999px',
    padding: '14px 18px',
    fontSize: '15px',
    fontWeight: 800,
    cursor: 'pointer',
    boxShadow: '0 10px 24px rgba(255,107,53,0.22)',
    flex: '1 1 150px',
    minWidth: 0,
  },
  secondaryButton: {
    border: '1px solid rgba(17,17,17,0.10)',
    background: '#fff',
    color: '#111',
    borderRadius: '999px',
    padding: '14px 18px',
    fontSize: '15px',
    fontWeight: 800,
    cursor: 'pointer',
    flex: '1 1 150px',
    minWidth: 0,
  },
  resultsWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  updatedAt: {
    fontSize: '12px',
    lineHeight: 1.4,
    color: '#777',
    textAlign: 'left',
  },
  resultCard: {
    background: '#fff',
    borderRadius: '20px',
    padding: '18px',
    border: '1px solid rgba(17,17,17,0.06)',
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  resultLabel: {
    fontSize: '12px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#666',
    marginBottom: '10px',
    textAlign: 'left',
  },
  resultText: {
    fontSize: '19px',
    lineHeight: 1.85,
    color: '#2450d8',
    fontWeight: 650,
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  skeletonRow: {
    height: '16px',
    borderRadius: '8px',
    background: 'linear-gradient(90deg, #f0e8e0 25%, #f8f2ec 50%, #f0e8e0 75%)',
    backgroundSize: '200% 100%',
    animation: 'tbsShimmer 1.4s ease-in-out infinite',
    width: '85%',
    marginBottom: '14px',
  },
  cursor: {
    display: 'inline-block',
    color: '#ff6b35',
    animation: 'tbsBlink 0.8s steps(2) infinite',
    marginLeft: '2px',
  },
};
