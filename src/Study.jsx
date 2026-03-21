import { useState } from 'react';
import ToolTabs from './ToolTabs';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8787';

export default function Study() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [normalizedCn, setNormalizedCn] = useState('');
  const [loading, setLoading] = useState(false);

  const translate = async () => {
    if (!input.trim()) return;

    setLoading(true);
    setOutput('');
    setNormalizedCn('');

    try {
      const res = await fetch(`${API}/api/session/demo-session/line`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawCn: input }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Translation failed');
      }

      const data = await res.json();
      setOutput(data.en || 'No translation returned');
      setNormalizedCn(data.normalizedCn || '');
    } catch (err) {
      console.error(err);
      setOutput('Error translating');
    }

    setLoading(false);
  };

  return (
    <div style={styles.page}>
      <div style={styles.bgOrbA} />
      <div style={styles.bgOrbB} />

      <div style={styles.container}>
        <ToolTabs current="study" />

        <div style={styles.heroCard}>
          <div style={styles.eyebrow}>TBS V2</div>
          <h1 style={styles.title}>Study Translation</h1>
          <p style={styles.subtitle}>
            Paste Chinese text and get a TBS-aware translation with normalized source handling.
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

            <div style={styles.statCard}>
              <div style={styles.statLabel}>Status</div>
              <div style={styles.statValue}>{loading ? 'Translating' : 'Ready'}</div>
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
            <button style={styles.primaryButton} onClick={translate}>
              {loading ? 'Translating…' : 'Translate'}
            </button>

            <button
              style={styles.secondaryButton}
              onClick={() => {
                setInput('');
                setOutput('');
                setNormalizedCn('');
              }}
            >
              Clear
            </button>
          </div>

          {(output || normalizedCn) && (
            <div style={styles.resultsWrap}>
              {normalizedCn ? (
                <div style={styles.resultCard}>
                  <div style={styles.resultLabel}>Normalized Chinese</div>
                  <div style={styles.resultTextChinese}>{normalizedCn}</div>
                </div>
              ) : null}

              {output ? (
                <div style={styles.resultCard}>
                  <div style={styles.resultLabel}>English</div>
                  <div style={styles.resultText}>{output}</div>
                </div>
              ) : null}
            </div>
          )}
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
  },
  statLabel: {
    fontSize: '11px',
    fontWeight: 800,
    color: '#8d8d95',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '8px',
  },
  statValue: {
    fontSize: '15px',
    fontWeight: 800,
    color: '#fff',
  },
  mainCard: {
    background: '#fff7ef',
    borderRadius: '28px',
    padding: '22px',
    color: '#111',
    boxShadow: '0 24px 60px rgba(0,0,0,0.22)',
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
    textAlign: 'left',
    lineHeight: 1.6,
    marginBottom: '16px',
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
  },
  resultsWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  resultCard: {
    background: '#fff',
    borderRadius: '20px',
    padding: '18px',
    border: '1px solid rgba(17,17,17,0.06)',
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
  resultTextChinese: {
    fontSize: '24px',
    lineHeight: 1.45,
    color: '#111',
    fontWeight: 700,
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  resultText: {
    fontSize: '21px',
    lineHeight: 1.6,
    color: '#2450d8',
    fontWeight: 700,
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
};