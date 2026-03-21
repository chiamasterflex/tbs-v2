const tabs = [
  { key: 'live', label: 'Live', href: '/' },
  { key: 'study', label: 'Study', href: '/study' },
  { key: 'review', label: 'Review', href: '/review' },
];

export default function ToolTabs({ current }) {
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
    padding: '8px',
    borderRadius: '999px',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.08)',
    backdropFilter: 'blur(14px)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
  },

  tab: {
    border: '1px solid transparent',
    background: 'transparent',
    color: '#d8d8de',
    borderRadius: '999px',
    padding: '10px 16px',
    fontSize: '14px',
    fontWeight: 800,
    cursor: 'pointer',
    transition: 'all 160ms ease',
  },

  tabActive: {
    background: 'linear-gradient(135deg, #ff6b35 0%, #ff8b63 100%)',
    color: '#111',
    boxShadow: '0 8px 18px rgba(255,107,53,0.25)',
  },
};