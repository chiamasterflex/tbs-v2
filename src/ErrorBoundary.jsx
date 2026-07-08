import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(180deg, #0b0b0c 0%, #121214 100%)',
          fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
          color: '#fff',
          padding: '24px',
        }}>
          <div style={{
            maxWidth: '420px',
            textAlign: 'center',
          }}>
            <div style={{
              fontSize: '12px',
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: '0.10em',
              color: '#8d8d95',
              marginBottom: '12px',
            }}>
              TBS V2
            </div>
            <h1 style={{
              fontSize: '28px',
              fontWeight: 800,
              margin: '0 0 12px',
              letterSpacing: '-0.03em',
            }}>
              Something went wrong
            </h1>
            <p style={{
              fontSize: '15px',
              lineHeight: 1.5,
              color: '#b8b8c2',
              margin: '0 0 24px',
            }}>
              The app encountered an unexpected error. Reloading usually fixes it.
            </p>
            <button
              onClick={this.handleReload}
              style={{
                border: 'none',
                background: 'linear-gradient(135deg, #ff6b35 0%, #ff8a5b 100%)',
                color: '#111',
                borderRadius: '999px',
                padding: '14px 28px',
                fontSize: '15px',
                fontWeight: 800,
                cursor: 'pointer',
                boxShadow: '0 10px 24px rgba(255,107,53,0.22)',
              }}
            >
              Reload app
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
