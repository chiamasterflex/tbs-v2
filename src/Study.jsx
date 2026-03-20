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
      <div style={styles.container}>
        <ToolTabs current="study" />

        <div style={styles.card}>
          <div style={styles.eyebrow}>TBS V2</div>
          <h1 style={styles.title}>Study Translation</h1>
          <p style={styles.subtitle}>
            Paste Chinese text and get a TBS-aware translation.
          </p>

          <div style={styles.sectionLabel}>Source text</div>
          <textarea
            style={styles.textarea}
            placeholder="Paste Chinese text here..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />

          <button style={styles.button} onClick={translate}>
            {loading ? 'Translating...' : 'Translate'}
          </button>

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
    background: '#111111',
    padding: '24px 16px',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  container: {
    maxWidth: '760px',
    margin: '0 auto',
  },
  card: {
    background: '#fff7ef',
    borderRadius: '28px',
    padding: '24px',
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
    fontSize: '36px',
    lineHeight: 1,
    letterSpacing: '-0.04em',
    fontWeight: 800,
    color: '#111',
    textAlign: 'left',
  },
  subtitle: {
    margin: '12px 0 20px',
    fontSize: '16px',
    lineHeight: 1.45,
    color: '#444',
    textAlign: 'left',
  },
  sectionLabel: {
    fontSize: '12px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#666',
    marginBottom: '8px',
    textAlign: 'left',
  },
  textarea: {
    width: '100%',
    minHeight: 180,
    boxSizing: 'border-box',
    border: '2px solid #ddd',
    borderRadius: '18px',
    padding: '16px',
    fontSize: '16px',
    resize: 'vertical',
    outline: 'none',
    fontFamily: 'inherit',
    background: '#fff',
    textAlign: 'left',
    lineHeight: 1.5,
    marginBottom: '16px',
  },
  button: {
    border: 'none',
    background: '#111',
    color: '#fff',
    borderRadius: '999px',
    padding: '14px 18px',
    fontSize: '15px',
    fontWeight: 700,
    cursor: 'pointer',
    marginBottom: '20px',
  },
  resultsWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  resultCard: {
    background: '#fff',
    borderRadius: '18px',
    padding: '16px',
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
    fontSize: '22px',
    lineHeight: 1.45,
    color: '#111',
    fontWeight: 700,
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  resultText: {
    fontSize: '20px',
    lineHeight: 1.6,
    color: '#2450d8',
    fontWeight: 600,
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
};