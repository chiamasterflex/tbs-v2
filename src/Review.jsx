import { useState } from 'react';
import ToolTabs from './ToolTabs';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8787';

export default function Review() {
  const [heard, setHeard] = useState('');
  const [corrected, setCorrected] = useState('');
  const [category, setCategory] = useState('deity');
  const [eventMode, setEventMode] = useState('Dharma Talk');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState('');

  const submitCorrection = async () => {
    if (!heard.trim() || !corrected.trim()) {
      setStatus('Please fill in both Heard and Should be.');
      return;
    }

    setStatus('Saving...');

    try {
      const res = await fetch(`${API}/api/correction-memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          heard,
          corrected,
          category,
          eventMode,
          notes,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || 'Failed to save correction');
      }

      setStatus('Saved.');
      setHeard('');
      setCorrected('');
      setNotes('');
    } catch (err) {
      console.error(err);
      setStatus('Error saving correction.');
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <ToolTabs current="review" />

        <div style={styles.card}>
          <div style={styles.eyebrow}>TBS V2</div>
          <h1 style={styles.title}>Memory Review</h1>
          <p style={styles.subtitle}>
            Save incorrect hearing or translation so the system improves over time.
          </p>

          <div style={styles.field}>
            <label style={styles.label}>Heard</label>
            <textarea
              value={heard}
              onChange={(e) => setHeard(e.target.value)}
              placeholder="What the system heard..."
              style={styles.textarea}
              rows={3}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Should be</label>
            <textarea
              value={corrected}
              onChange={(e) => setCorrected(e.target.value)}
              placeholder="Correct wording..."
              style={styles.textarea}
              rows={3}
            />
          </div>

          <div style={styles.row}>
            <div style={styles.fieldHalf}>
              <label style={styles.label}>Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                style={styles.select}
              >
                <option value="deity">Deity</option>
                <option value="protector">Protector</option>
                <option value="term">Term</option>
                <option value="phrase">Phrase</option>
                <option value="mantra">Mantra</option>
                <option value="title">Title</option>
                <option value="translation">Translation</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div style={styles.fieldHalf}>
              <label style={styles.label}>Event mode</label>
              <select
                value={eventMode}
                onChange={(e) => setEventMode(e.target.value)}
                style={styles.select}
              >
                <option>Dharma Talk</option>
                <option>Homa</option>
                <option>Repentance</option>
                <option>Announcement</option>
                <option>Chanting</option>
                <option>Liturgy</option>
              </select>
            </div>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              style={styles.textarea}
              rows={3}
            />
          </div>

          <button onClick={submitCorrection} style={styles.button}>
            Save correction
          </button>

          {status ? <div style={styles.status}>{status}</div> : null}
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
  field: {
    marginBottom: '16px',
  },
  fieldHalf: {
    flex: 1,
  },
  row: {
    display: 'flex',
    gap: '12px',
    marginBottom: '16px',
    flexWrap: 'wrap',
  },
  label: {
    display: 'block',
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
    boxSizing: 'border-box',
    border: '2px solid #ddd',
    borderRadius: '18px',
    padding: '14px 16px',
    fontSize: '16px',
    resize: 'vertical',
    outline: 'none',
    fontFamily: 'inherit',
    background: '#fff',
    textAlign: 'left',
  },
  select: {
    width: '100%',
    boxSizing: 'border-box',
    border: '2px solid #ddd',
    borderRadius: '18px',
    padding: '14px 16px',
    fontSize: '16px',
    outline: 'none',
    fontFamily: 'inherit',
    background: '#fff',
    textAlign: 'left',
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
  },
  status: {
    marginTop: '14px',
    fontSize: '14px',
    fontWeight: 700,
    color: '#444',
    textAlign: 'left',
  },
};