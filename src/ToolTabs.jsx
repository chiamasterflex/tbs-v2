export default function ToolTabs({ current = 'live', sessionId = '' }) {
  const viewHref = sessionId ? `/viewer?session=${encodeURIComponent(sessionId)}` : '/viewer';

  const tabs = [
    { key: 'live', label: 'Live', href: '/' },
    { key: 'study', label: 'Study', href: '/study' },
    { key: 'review', label: 'Review', href: '/review' },
    { key: 'viewer', label: 'Viewer', href: viewHref },
  ];

  return (
    <div style={styles.wrap}>
      <div style={styles.inner}>
        {tabs.map((tab) => {
          const active = current === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => {
                window.location.href = tab.href;
              }}
              style={{
                ...styles.tab,
                ...(active ? styles.tabActive : {}),
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  wrap: {
    width: '100%',
    marginBottom: '16px',
  },
  inner: {
    display: 'inline-flex',
    gap: '8px',
    background: '#1b1b1b',
    padding: '8px',
    borderRadius: '999px',
  },
  tab: {
    border: 'none',
    background: 'transparent',
    color: '#d8d8d8',
    borderRadius: '999px',
    padding: '10px 16px',
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  tabActive: {
    background: '#ff6b35',
    color: '#111',
  },
};