import { useEffect } from 'react';

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    animation: 'tbsFadeIn 0.15s ease',
  },
  dialog: {
    background: 'linear-gradient(180deg, #1a1a1e 0%, #141416 100%)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '24px',
    padding: '28px 24px 20px',
    maxWidth: '400px',
    width: '90%',
    color: '#fff',
    boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
  },
  title: {
    fontSize: '18px',
    fontWeight: 800,
    margin: '0 0 8px',
    letterSpacing: '-0.02em',
    textAlign: 'left',
  },
  message: {
    fontSize: '14px',
    lineHeight: 1.5,
    color: '#b8b8c2',
    margin: '0 0 24px',
    textAlign: 'left',
  },
  buttonRow: {
    display: 'flex',
    gap: '10px',
    justifyContent: 'flex-end',
  },
  confirmBtn: {
    border: 'none',
    background: 'linear-gradient(135deg, #ff6b35 0%, #ff8a5b 100%)',
    color: '#111',
    borderRadius: '999px',
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 800,
    cursor: 'pointer',
    boxShadow: '0 6px 16px rgba(255,107,53,0.20)',
  },
  cancelBtn: {
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'transparent',
    color: '#b8b8c2',
    borderRadius: '999px',
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  toast: {
    position: 'fixed',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'linear-gradient(180deg, #1a1a1e 0%, #141416 100%)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '16px',
    padding: '14px 22px',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 600,
    zIndex: 9999,
    boxShadow: '0 12px 32px rgba(0,0,0,0.3)',
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    maxWidth: '90%',
    textAlign: 'center',
    animation: 'tbsFadeIn 0.2s ease',
  },
  toastError: {
    border: '1px solid rgba(255,80,80,0.25)',
    color: '#ff8080',
  },
};

export function ConfirmDialog({ open, title = 'Confirm', message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm, onCancel }) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onCancel?.();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.title}>{title}</div>
        <div style={styles.message}>{message}</div>
        <div style={styles.buttonRow}>
          <button style={styles.cancelBtn} onClick={onCancel}>{cancelLabel}</button>
          <button style={styles.confirmBtn} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function Toast({ message, isError, onDismiss }) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div style={{ ...styles.toast, ...(isError ? styles.toastError : {}) }} onClick={onDismiss}>
      {message}
    </div>
  );
}
