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
      <div style={styles.bgOrbA} />
      <div style={styles.bgOrbB} />

      <div style={styles.container}>
        <ToolTabs current="review" />

        <div style={styles.heroCard}>
          <div style={styles.eyebrow}>TBS V2</div>
          <h1 style={styles.title}>Memory Review</h1>
          <p style={styles.subtitle}>
            Save incorrect hearing or translation so the system improves over time.
          </p>

          <div style={styles.statRow}>
            <div style={styles.statCard}>
              <div style={styles.statLabel}>Mode</div>
              <div style={styles.statValue}>Review</div>
            </div>

            <div style={styles.statCard}>
              <div style={styles.statLabel}>Purpose</div>
              <div style={styles.statValue}>Correction Memory</div>
            </div>

            <div style={styles.statCard}>
              <div style={styles.statLabel}>Status</div>
              <div style={styles.statValue}>{status || 'Ready'}</div>
            </div>
          </div>
        </div>

        <div style={styles.mainCard}>
          <div style={styles.grid}>
            <div style={styles.field}>
              <label style={styles.label}>Heard</label>
              <textarea
                value={heard}
                onChange={(e) => setHeard(e.target.value)}
                placeholder="What the system heard..."
                style={styles.textarea}
                rows={4}
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Should be</label>
              <textarea
                value={corrected}
                onChange={(e) => setCorrected(e.target.value)}
                placeholder="Correct wording..."
                style={styles.textarea}
                rows={4}
              />
            </div>
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
              rows={4}
            />
          </div>

          <div style={styles.buttonRow}>
            <button onClick={submitCorrection} style={styles.primaryButton}>
              Save correction
            </button>

            <button
              onClick={() => {
                setHeard('');
                setCorrected('');
                setNotes('');
                setStatus('');
              }}
              style={styles.secondaryButton}
            >
              Clear form
            </button>
          </div>

          {status ? <div style={styles.status}>{status}</div> : null}
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
    maxWidth: '680px',
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
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '14px',
    marginBottom: '14px',
  },
  field: {
    marginBottom: '14px',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '14px',
    marginBottom: '14px',
  },
  fieldHalf: {},
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
    border: '1px solid rgba(17,17,17,0.10)',
    borderRadius: '18px',
    padding: '14px 16px',
    fontSize: '16px',
    resize: 'vertical',
    outline: 'none',
    fontFamily: 'inherit',
    background: '#fff',
    textAlign: 'left',
    lineHeight: 1.6,
  },
  select: {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid rgba(17,17,17,0.10)',
    borderRadius: '18px',
    padding: '14px 16px',
    fontSize: '16px',
    outline: 'none',
    fontFamily: 'inherit',
    background: '#fff',
    color: '#111',
  },
  buttonRow: {
    display: 'flex',
    gap: '10px',
    flexWrap: 'wrap',
    marginTop: '8px',
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
  status: {
    marginTop: '16px',
    padding: '14px 16px',
    borderRadius: '18px',
    background: 'rgba(17,17,17,0.05)',
    color: '#111',
    fontWeight: 700,
    textAlign: 'left',
  },
};