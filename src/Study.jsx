import { useState } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8787';

export default function Study() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);

  const translate = async () => {
    if (!input.trim()) return;

    setLoading(true);
    setOutput('');

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
    } catch (err) {
      console.error(err);
      setOutput('Error translating');
    }

    setLoading(false);
  };

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <h1 style={styles.title}>TBS Study Translation</h1>

        <textarea
          style={styles.textarea}
          placeholder="Paste Chinese text..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />

        <button style={styles.button} onClick={translate}>
          {loading ? 'Translating...' : 'Translate'}
        </button>

        {output && <div style={styles.output}>{output}</div>}
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: '#111',
    padding: 24,
    fontFamily: 'Inter, sans-serif',
  },
  container: {
    maxWidth: 700,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: 800,
    textAlign: 'center',
  },
  textarea: {
    width: '100%',
    minHeight: 160,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    border: 'none',
    boxSizing: 'border-box',
  },
  button: {
    padding: '12px 18px',
    borderRadius: 999,
    border: 'none',
    background: '#ff6b35',
    color: '#111',
    fontWeight: 700,
    cursor: 'pointer',
  },
  output: {
    background: '#fff',
    padding: 16,
    borderRadius: 12,
    fontSize: 18,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
  },
};