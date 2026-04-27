import { createClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Study from './Study';
import Review from './Review';
import Viewer from './Viewer';
import ToolTabs from './ToolTabs';
import micIcon from './assets/mic.svg';

const API = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:8787' : '');
const WS_URL =
  import.meta.env.VITE_WS_URL ||
  (import.meta.env.DEV
    ? 'ws://localhost:8787/ws'
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`);
const FIXED_SESSION_ID = 'live-session';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const SUPER_ADMIN_EMAILS = parseEmailAllowlist(import.meta.env.VITE_SUPER_ADMIN_EMAILS);
const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

function logAuthDiagnostic(label, details) {
  console.info(`[auth] ${label}`, details);
}

function parseEmailAllowlist(value) {
  return new Set(
    String(value || '')
      .split(/[,\s]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function getFallbackRole(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  if (SUPER_ADMIN_EMAILS.has(normalized)) return 'Super Admin';
  return null;
}

function formatDbRole(row) {
  if (row?.status !== 'active') return null;
  if (row?.role === 'super_admin') return 'Super Admin';
  if (row?.role === 'admin') return 'Admin';
  return null;
}

function getIsMobileViewport() {
  return window.matchMedia('(max-width: 720px)').matches;
}

function getAuthRedirectUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

function clearAuthQueryParams() {
  const url = new URL(window.location.href);
  ['code', 'error', 'error_code', 'error_description'].forEach((key) => {
    url.searchParams.delete(key);
  });

  window.history.replaceState(
    {},
    document.title,
    `${url.pathname}${url.search}${url.hash}`
  );
}

function sanitizeSessionId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

function deriveTranslationRoute(sourceLanguage, targetLanguage) {
  const source = String(sourceLanguage || '').toLowerCase();
  const target = String(targetLanguage || '').toLowerCase();

  if ((source.includes('bahasa') || source.includes('indones')) && target.includes('english')) {
    return 'id_en';
  }

  return 'zh_en';
}

function formatTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';

  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function getInitials(email) {
  const name = String(email || '').split('@')[0] || 'A';
  return (
    name
      .split(/[._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'A'
  );
}

function getPublicSessionId(entry) {
  return sanitizeSessionId(entry?.sessionId || entry?.id || '');
}

function getPublicSessionName(entry) {
  const id = getPublicSessionId(entry);
  const title = String(entry?.title || '').trim();
  if (title && title !== 'TBS Live Session') return title;
  return id || 'Session';
}

function getPublicSessionStatus(entry) {
  const status = String(entry?.status || '').toLowerCase();
  return status === 'live' || status === 'listening' ? 'LIVE' : 'Idle';
}

function isProductSessionId(sessionId) {
  const id = sanitizeSessionId(sessionId);
  return Boolean(id && id !== FIXED_SESSION_ID && id !== 'main');
}

function PublicSessionsList() {
  const [sessions, setSessions] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;

    const fetchSessions = async () => {
      try {
        const res = await fetch(`${API}/api/sessions`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (mounted && Array.isArray(data)) {
          setSessions(data);
        }
      } catch (err) {
        console.error('public sessions failed', err);
      } finally {
        if (mounted) setLoaded(true);
      }
    };

    fetchSessions();

    return () => {
      mounted = false;
    };
  }, []);

  const visibleSessions = useMemo(() => {
    return sessions
      .filter((entry) => isProductSessionId(getPublicSessionId(entry)))
      .sort((a, b) => {
        const aLive = getPublicSessionStatus(a) === 'LIVE';
        const bLive = getPublicSessionStatus(b) === 'LIVE';
        if (aLive !== bLive) return aLive ? -1 : 1;
        return String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || ''));
      });
  }, [sessions]);

  return (
    <section style={styles.publicSessionsPanel}>
      <div style={styles.publicSessionsTitle}>Ongoing live sessions</div>

      {loaded && visibleSessions.length === 0 ? (
        <div style={styles.publicSessionsEmpty}>No live sessions available right now.</div>
      ) : null}

      {!loaded ? <div style={styles.publicSessionsEmpty}>Checking sessions...</div> : null}

      {visibleSessions.length > 0 ? (
        <div style={styles.publicSessionRows}>
          {visibleSessions.map((entry) => {
            const sessionId = getPublicSessionId(entry);
            const status = getPublicSessionStatus(entry);
            const isLive = status === 'LIVE';

            return (
              <div key={sessionId} style={styles.publicSessionRow}>
                <div style={styles.publicSessionMain}>
                  <div style={styles.publicSessionName}>{getPublicSessionName(entry)}</div>
                  <div style={styles.publicSessionMeta}>
                    <span
                      style={{
                        ...styles.sessionStatusPill,
                        ...(isLive ? styles.sessionStatusLive : null),
                      }}
                    >
                      {status}
                    </span>
                    {Number.isFinite(entry?.lineCount) ? (
                      <span>{entry.lineCount} lines</span>
                    ) : null}
                  </div>
                </div>
                <a
                  href={`/viewer/${encodeURIComponent(sessionId)}`}
                  style={styles.publicSessionLink}
                >
                  Join viewer
                </a>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function AuthBadge({ email, roleLabel, onLogout, compact = false }) {
  return (
    <div style={{ ...styles.authBadge, ...(compact ? styles.authBadgeCompact : null) }}>
      {compact ? (
        <div style={styles.authInitials} title={`${roleLabel}: ${email}`}>
          {getInitials(email)}
        </div>
      ) : (
        <div style={styles.authBadgeText}>
          {roleLabel}: {email}
        </div>
      )}
      <button
        type="button"
        onClick={onLogout}
        style={{
          ...styles.authLogoutButton,
          ...(compact ? styles.authLogoutButtonCompact : null),
        }}
        aria-label="Logout"
        title="Logout"
      >
        {compact ? 'Out' : 'Logout'}
      </button>
    </div>
  );
}

function AuthGate({ mode, email, roleLabel, onLogin, onLogout }) {
  const isDenied = mode === 'denied';
  const title =
    mode === 'loading'
      ? 'Loading'
      : mode === 'missing-config'
        ? 'Supabase auth is not configured'
        : isDenied
          ? 'Access not approved'
          : 'TBS Live Translation';
  const message =
    mode === 'loading'
      ? 'Checking access...'
      : mode === 'missing-config'
        ? 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable admin login.'
        : isDenied
          ? 'This Google account is not currently approved for admin access.'
          : 'For admins and translators only. Viewers do not need to sign in.';

  return (
    <div style={styles.page}>
      <div style={styles.bgOrbA} />
      <div style={styles.bgOrbB} />
      <div style={{ ...styles.shell, ...styles.authShell }}>
        {mode === 'login' ? (
          <div style={styles.authIntro}>
            <h1 style={styles.authHeroTitle}>True Buddha School Live Translation</h1>
            <p style={styles.authHeroSubtitle}>
              Real-time translation trained with TBS resources
            </p>
          </div>
        ) : null}
        <div style={styles.authScreenCard}>
          {mode !== 'login' ? <h1 style={styles.authTitle}>{title}</h1> : null}
          <p style={styles.authMessage}>{message}</p>
          {roleLabel ? <div style={styles.authRolePill}>{roleLabel}</div> : null}
          {mode === 'login' ? (
            <button
              type="button"
              onClick={onLogin}
              style={{ ...styles.primaryButton, ...styles.authPrimaryButton }}
            >
              Sign in with Google
            </button>
          ) : null}
          {mode === 'login' ? (
            <div style={styles.authHelperCopy}>
              For access please contact{' '}
              <a href="mailto:chiamasterflex@gmail.com" style={styles.authHelperLink}>
                Admin
              </a>
            </div>
          ) : null}
          {isDenied ? (
            <button type="button" onClick={onLogout} style={styles.secondaryButtonDark}>
              Logout
            </button>
          ) : null}
        </div>
        {mode === 'login' ? <PublicSessionsList /> : null}
      </div>
    </div>
  );
}

export default function App() {
  const path = window.location.pathname;

  if (path === '/viewer' || path.startsWith('/viewer/')) {
    return <Viewer />;
  }

  const [authReady, setAuthReady] = useState(false);
  const [authSession, setAuthSession] = useState(null);
  const [roleReady, setRoleReady] = useState(true);
  const [dbRole, setDbRole] = useState(null);

  useEffect(() => {
    const currentUrl = new URL(window.location.href);

    logAuthDiagnostic('config', {
      supabaseUrlPresent: Boolean(SUPABASE_URL),
      supabaseKeyPresent: Boolean(SUPABASE_ANON_KEY),
      currentLocationHref: window.location.href,
      hasOAuthCode: currentUrl.searchParams.has('code'),
    });

    if (!supabase) {
      setAuthReady(true);
      return undefined;
    }

    let mounted = true;

    const syncSession = async () => {
      try {
        const url = new URL(window.location.href);
        const hasOAuthCode = url.searchParams.has('code');

        if (hasOAuthCode) {
          const { data, error } = await supabase.auth.exchangeCodeForSession(
            window.location.href
          );
          logAuthDiagnostic('exchangeCodeForSession', {
            success: !error,
            message: error?.message || 'success',
          });
          if (error) {
            console.error('supabase auth exchange failed', error);
          }
          if (!mounted) return;
          setAuthSession(data?.session || null);
          clearAuthQueryParams();
        } else {
          const { data } = await supabase.auth.getSession();
          logAuthDiagnostic('getSession', {
            hasSession: Boolean(data?.session),
            userEmail: data?.session?.user?.email || null,
          });
          if (!mounted) return;
          setAuthSession(data?.session || null);
        }
      } finally {
        if (mounted) setAuthReady(true);
      }
    };

    syncSession();

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setAuthSession(nextSession);
      setAuthReady(true);
    });

    return () => {
      mounted = false;
      data?.subscription?.unsubscribe();
    };
  }, []);

  const userEmail = String(authSession?.user?.email || '').trim().toLowerCase();
  const fallbackRole = getFallbackRole(userEmail);
  const roleLabel = dbRole || fallbackRole;
  const isAdminAuthorized = Boolean(
    authReady && roleReady && supabase && authSession && roleLabel
  );
  const isLiveMode = path !== '/study' && path !== '/review';

  useEffect(() => {
    if (!authReady) return;

    logAuthDiagnostic('state', {
      hasSession: Boolean(authSession),
      userEmail: userEmail || null,
      dbRole,
      fallbackRole,
      finalRole: roleLabel,
    });
  }, [authReady, authSession, dbRole, fallbackRole, roleLabel, userEmail]);

  useEffect(() => {
    if (!authReady) return;

    if (!supabase || !authSession || !userEmail) {
      setDbRole(null);
      setRoleReady(true);
      return;
    }

    let cancelled = false;

    const loadRole = async () => {
      setRoleReady(false);

      try {
        const { data, error } = await supabase
          .from('admin_users')
          .select('role,status')
          .eq('email', userEmail)
          .eq('status', 'active')
          .maybeSingle();

        if (cancelled) return;

        if (error) {
          console.error('admin role lookup failed', error);
          setDbRole(null);
          return;
        }

        setDbRole(formatDbRole(data));
      } catch (err) {
        if (!cancelled) {
          console.error('admin role lookup failed', err);
          setDbRole(null);
        }
      } finally {
        if (!cancelled) {
          setRoleReady(true);
        }
      }
    };

    loadRole();

    return () => {
      cancelled = true;
    };
  }, [authReady, authSession, userEmail]);

  const loginWithGoogle = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: getAuthRedirectUrl(),
      },
    });
  }, []);

  const logout = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  }, []);

  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('idle');
  const [audioDebug, setAudioDebug] = useState({
    frameCount: 0,
    totalBytes: 0,
    lastBytes: 0,
  });
  const [activeAudioMode, setActiveAudioMode] = useState(null);
  const [copiedSessionId, setCopiedSessionId] = useState(null);
  const [activeSessionId, setActiveSessionId] = useState(FIXED_SESSION_ID);
  const [availableSessions, setAvailableSessions] = useState([]);
  const [sessionListLoaded, setSessionListLoaded] = useState(false);
  const [showNewSessionInput, setShowNewSessionInput] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionEventMode, setNewSessionEventMode] = useState('');
  const [newSessionRoute, setNewSessionRoute] = useState('zh_en');
  const [isMobileViewport, setIsMobileViewport] = useState(getIsMobileViewport);
  const [sessionsExpanded, setSessionsExpanded] = useState(() => !getIsMobileViewport());

const [liveChinese, setLiveChinese] = useState('');
const [liveEnglish, setLiveEnglish] = useState('');
const [historyLines, setHistoryLines] = useState([]);
const [rollingBrainState, setRollingBrainState] = useState(null);
const [brainStateHistory, setBrainStateHistory] = useState([]);
const [sourceLanguage, setSourceLanguage] = useState('Mandarin');
const [targetLanguage, setTargetLanguage] = useState('English');

  const translationRoute = useMemo(
    () => deriveTranslationRoute(sourceLanguage, targetLanguage),
    [sourceLanguage, targetLanguage]
  );

  const wsRef = useRef(null);
const audioContextRef = useRef(null);
const mediaStreamRef = useRef(null);
const sourceRef = useRef(null);
const processorRef = useRef(null);
const pcmQueueRef = useRef([]);
const interimTimerRef = useRef(null);
const reconnectTimerRef = useRef(null);
const shouldReconnectRef = useRef(false);
const manualStopRef = useRef(false);
const audioRunIdRef = useRef(0);
const pendingReconnectModeRef = useRef(null);
const liveConfigRef = useRef({
  sourceLanguage: 'Mandarin',
  targetLanguage: 'English',
  translationRoute: 'zh_en',
  sessionId: FIXED_SESSION_ID,
});
const lastTranslatedChineseRef = useRef('');
const transcriptFeedRef = useRef(null);
const premiumScrollTimersRef = useRef(new Map());
const lastLiveSnapshotRef = useRef('');

  const handlePremiumScroll = useCallback((event) => {
    const el = event.currentTarget;
    const timers = premiumScrollTimersRef.current;

    el.classList.add('is-scrolling');

    if (timers.has(el)) {
      clearTimeout(timers.get(el));
    }

    timers.set(
      el,
      setTimeout(() => {
        el.classList.remove('is-scrolling');
        timers.delete(el);
      }, 700)
    );
  }, []);

  useEffect(() => {
    const timers = premiumScrollTimersRef.current;

    return () => {
      timers.forEach((timer, el) => {
        clearTimeout(timer);
        el.classList.remove('is-scrolling');
      });
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)');
    const handleChange = () => setIsMobileViewport(media.matches);

    handleChange();
    media.addEventListener('change', handleChange);

    return () => {
      media.removeEventListener('change', handleChange);
    };
  }, []);

  const fetchSessionList = useCallback(async () => {
    if (!isAdminAuthorized || !isLiveMode) return [];

    try {
      const res = await fetch(`${API}/api/sessions`, { cache: 'no-store' });
      if (!res.ok) return;

      const data = await res.json();
      if (Array.isArray(data)) {
        setAvailableSessions(data);
        return data;
      }
    } catch (err) {
      console.error('session list failed', err);
    } finally {
      setSessionListLoaded(true);
    }

    return [];
  }, [isAdminAuthorized, isLiveMode]);

  const registerSession = useCallback(
    async (sessionId, overrides = {}) => {
      if (!isAdminAuthorized || !isLiveMode) return null;

      const sanitized = sanitizeSessionId(sessionId) || FIXED_SESSION_ID;
      const res = await fetch(`${API}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: sanitized,
          title: overrides.title || session?.title || 'TBS Live Session',
          eventMode: overrides.eventMode || session?.eventMode || 'Live Session',
          sourceLanguage: overrides.sourceLanguage || sourceLanguage,
          targetLanguage: overrides.targetLanguage || targetLanguage,
          translationRoute: overrides.translationRoute || translationRoute,
        }),
      });

      if (!res.ok) return null;
      return res.json();
    },
    [
      isAdminAuthorized,
      isLiveMode,
      session?.eventMode,
      session?.title,
      sourceLanguage,
      targetLanguage,
      translationRoute,
    ]
  );

  useEffect(() => {
    if (!isAdminAuthorized || !isLiveMode) return;

    fetchSessionList();
  }, [fetchSessionList, isAdminAuthorized, isLiveMode]);

  useEffect(() => {
    if (!isAdminAuthorized || !isLiveMode) return;

    const init = async () => {
      try {
        setSession(null);
        setHistoryLines([]);
        setLiveChinese('');
        setLiveEnglish('');
        setRollingBrainState(null);
        setBrainStateHistory([]);
        lastTranslatedChineseRef.current = '';
        lastLiveSnapshotRef.current = '';

        const existing = await fetch(`${API}/api/session/${activeSessionId}`);
        if (existing.ok) {
          const data = await existing.json();
          setSession(data);
          setHistoryLines(data.lines || []);
          fetchSessionList();
          if (data.sourceLanguage) setSourceLanguage(data.sourceLanguage);
          if (data.targetLanguage) setTargetLanguage(data.targetLanguage);
          return;
        }

        const create = await fetch(`${API}/api/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: activeSessionId,
            title: 'TBS Live Session',
            eventMode: 'Live Session',
            sourceLanguage: 'Mandarin',
            targetLanguage: 'English',
            translationRoute: 'zh_en',
          }),
        });

        const created = await create.json();
        setSession(created);
        setHistoryLines(created.lines || []);
        fetchSessionList();
        if (created.sourceLanguage) setSourceLanguage(created.sourceLanguage);
        if (created.targetLanguage) setTargetLanguage(created.targetLanguage);
      } catch (err) {
        console.error('session init failed', err);
      }
    };

    init();
  }, [activeSessionId, fetchSessionList, isAdminAuthorized, isLiveMode]);

  useEffect(() => {
    if (!isAdminAuthorized || !isLiveMode) return;
    if (!session?.id) return;

    const sync = async () => {
      try {
        const res = await fetch(`${API}/api/session/${activeSessionId}`);
        if (!res.ok) return;
        const latest = await res.json();

        if (
          latest.sourceLanguage === sourceLanguage &&
          latest.targetLanguage === targetLanguage &&
          latest.translationRoute === translationRoute
        ) {
          return;
        }

        const update = await fetch(`${API}/api/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: activeSessionId,
            title: session.title || 'TBS Live Session',
            eventMode: session.eventMode || 'Live Session',
            sourceLanguage,
            targetLanguage,
            translationRoute,
          }),
        });

        if (update.ok) {
          const updated = await update.json();
          setSession(updated);
        }
      } catch (err) {
        console.error('session sync failed', err);
      }
    };

    sync();
  }, [activeSessionId, isAdminAuthorized, isLiveMode, session?.id, session?.title, session?.eventMode, sourceLanguage, targetLanguage, translationRoute]);

  const downsampleBuffer = (buffer, inputRate, outputRate) => {
    if (inputRate === outputRate) return buffer;

    const ratio = inputRate / outputRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);

    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;

      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }

      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  };

  const floatTo16BitPCM = (float32Array) => {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);

    let offset = 0;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return buffer;
  };

  const requestInterimTranslation = (text) => {
    if (!text || !text.trim()) return;
    if (text === lastTranslatedChineseRef.current) return;

    if (interimTimerRef.current) {
      clearTimeout(interimTimerRef.current);
    }

    interimTimerRef.current = setTimeout(async () => {
      try {
        lastTranslatedChineseRef.current = text;

        const res = await fetch(`${API}/api/translate-interim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rawCn: text,
            sessionId: activeSessionId,
            sourceLanguage,
            targetLanguage,
            translationRoute,
          }),
        });

        const data = await res.json();
        setLiveEnglish(data.en || '');
      } catch (err) {
        console.error('interim translate failed', err);
      }
    }, 180);
  };

  const getAudioStream = async (mode) => {
    if (mode === 'system') {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true });

      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('No system audio track selected');
      }

      return stream;
    }

    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });
  };

  const startAudio = async (mode = 'mic') => {
  let switchedMode = false;

  if (
    (status === 'requesting_mic' ||
      status === 'requesting_system' ||
      status === 'ws_open' ||
      status === 'listening' ||
      status === 'reconnecting') &&
    activeAudioMode !== mode
  ) {
    await stopAudio();
    switchedMode = true;
  }

  if (!switchedMode && (
    status === 'requesting_mic' ||
    status === 'requesting_system' ||
    status === 'ws_open' ||
    status === 'listening' ||
    status === 'reconnecting'
  )) {
    return;
  }

  manualStopRef.current = false;
  shouldReconnectRef.current = true;
  const runId = audioRunIdRef.current + 1;
  audioRunIdRef.current = runId;

  const openSocket = async () => {
    if (audioRunIdRef.current !== runId) return;

    try {
      setStatus(
        mediaStreamRef.current
          ? 'reconnecting'
          : mode === 'system'
            ? 'requesting_system'
            : 'requesting_mic'
      );

      const currentRoute = liveConfigRef.current.translationRoute;
      const currentSessionId = liveConfigRef.current.sessionId || FIXED_SESSION_ID;
      const ws = new WebSocket(
        `${WS_URL}?route=${encodeURIComponent(currentRoute)}&sessionId=${encodeURIComponent(currentSessionId)}`
      );
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = async () => {
        if (audioRunIdRef.current !== runId) {
          ws.close();
          return;
        }

        try {
          setStatus('ws_open');

          if (!mediaStreamRef.current) {
            const stream = await getAudioStream(mode);

            if (audioRunIdRef.current !== runId) {
              stream.getTracks().forEach((track) => track.stop());
              ws.close();
              return;
            }

            mediaStreamRef.current = stream;
            setActiveAudioMode(mode);

            stream.getAudioTracks().forEach((track) => {
              track.onended = () => {
                if (mediaStreamRef.current === stream) {
                  stopAudio();
                }
              };
            });

            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            audioContextRef.current = audioContext;

            const source = audioContext.createMediaStreamSource(stream);
            sourceRef.current = source;

            pcmQueueRef.current = [];

            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (event) => {
              const activeWs = wsRef.current;
              if (!activeWs) return;

              const inputData = event.inputBuffer.getChannelData(0);
              const downsampled = downsampleBuffer(inputData, audioContext.sampleRate, 16000);

              for (let i = 0; i < downsampled.length; i++) {
                pcmQueueRef.current.push(downsampled[i]);
              }

              const FRAME_SIZE = 800;

              while (pcmQueueRef.current.length >= FRAME_SIZE) {
                const frame = pcmQueueRef.current.splice(0, FRAME_SIZE);
                const pcmBuffer = floatTo16BitPCM(new Float32Array(frame));

                if (activeWs.readyState === WebSocket.OPEN) {
                  activeWs.send(pcmBuffer);
                }
              }
            };

            source.connect(processor);
            processor.connect(audioContext.destination);
          }

          setStatus('listening');
        } catch (err) {
          console.error('socket open bootstrap failed', err);
          setStatus('error');
        }
      };

      ws.onmessage = (event) => {
        if (audioRunIdRef.current !== runId) return;

        const msg = JSON.parse(event.data);

        if (msg.type === 'status') {
          if (msg.status === 'deepgram_ready') {
            setStatus('listening');
          } else if (msg.status === 'deepgram_closed') {
            setStatus('reconnecting');
          } else if (msg.status === 'ws_closed') {
            setStatus('stopped');
          } else {
            setStatus(msg.status);
          }
        }

        if (msg.type === 'audio_debug') {
          setAudioDebug({
            frameCount: msg.frameCount,
            totalBytes: msg.totalBytes,
            lastBytes: msg.lastBytes,
          });
        }

        if (msg.type === 'live_cn') {
          const sourceText = msg.normalizedCn || msg.text || '';
          if (sourceText && sourceText !== lastLiveSnapshotRef.current) {
            lastLiveSnapshotRef.current = sourceText;
            setLiveChinese(sourceText);
            requestInterimTranslation(sourceText);
          }
        }

        if (msg.type === 'final') {
          const line = msg.line;
          if (line) {
            setHistoryLines((prev) => [line, ...prev].slice(0, 150));
            setLiveChinese('');
            setLiveEnglish('');
            lastTranslatedChineseRef.current = '';
            lastLiveSnapshotRef.current = '';
          }
        }

        if (msg.type === 'brain_state') {
          const nextBrainState = msg.brainState || null;
          setRollingBrainState(nextBrainState);

          if (
            nextBrainState?.rollingSummary ||
            nextBrainState?.rollingIntent ||
            nextBrainState?.rollingTopic
          ) {
            setBrainStateHistory((prev) => {
              const entryId = `${nextBrainState.rollingUpdatedAt || Date.now()}-${nextBrainState.rollingTopic || ''}-${nextBrainState.rollingIntent || ''}`;
              if (prev[0]?.id === entryId) return prev;

              return [
                {
                  id: entryId,
                  rollingSummary: nextBrainState.rollingSummary || '',
                  rollingIntent: nextBrainState.rollingIntent || '',
                  rollingTopic: nextBrainState.rollingTopic || '',
                  rollingUpdatedAt:
                    nextBrainState.rollingUpdatedAt || new Date().toISOString(),
                  confidence: nextBrainState.confidence,
                },
                ...prev,
              ].slice(0, 24);
            });
          }

          return;
        }

        if (msg.type === 'error') {
          console.error('[Server error]', msg.message);
          setStatus('error');
        }
      };

      ws.onclose = () => {
        if (audioRunIdRef.current !== runId) return;

        wsRef.current = null;

        if (manualStopRef.current || !shouldReconnectRef.current) {
          setStatus('stopped');
          return;
        }

        setStatus('reconnecting');

        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }

        reconnectTimerRef.current = setTimeout(() => {
          openSocket();
        }, 900);
      };

      ws.onerror = () => {
        if (audioRunIdRef.current !== runId) return;

        setStatus('error');
      };
    } catch (err) {
      console.error('startAudio failed', err);
      setStatus('error');
    }
  };

  openSocket();
};

  const stopAudio = async () => {
  manualStopRef.current = true;
  shouldReconnectRef.current = false;
  audioRunIdRef.current += 1;
  setStatus('stopping');

  try {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
  } catch {}

  try {
    if (interimTimerRef.current) clearTimeout(interimTimerRef.current);
  } catch {}

  try {
    if (processorRef.current) processorRef.current.disconnect();
  } catch {}

  try {
    if (sourceRef.current) sourceRef.current.disconnect();
  } catch {}

  try {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
    }
  } catch {}

  try {
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      await audioContextRef.current.close();
    }
  } catch {}

  try {
    if (wsRef.current && wsRef.current.readyState <= 1) {
      wsRef.current.close();
    }
  } catch {}

  processorRef.current = null;
  sourceRef.current = null;
  mediaStreamRef.current = null;
  audioContextRef.current = null;
  wsRef.current = null;
  pcmQueueRef.current = [];
  interimTimerRef.current = null;
  reconnectTimerRef.current = null;
  setActiveAudioMode(null);

  setStatus('stopped');
};

  const copyViewerLink = async (sessionId = activeSessionId) => {
    const url = `${window.location.origin}/viewer/${encodeURIComponent(sessionId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedSessionId(sessionId);
      setTimeout(() => setCopiedSessionId(null), 1600);
    } catch (err) {
      console.error(err);
    }
  };

  const openViewerLink = (sessionId = activeSessionId) => {
    window.open(`/viewer/${encodeURIComponent(sessionId)}`, '_blank', 'noopener,noreferrer');
  };

  const clearHistory = async () => {
    try {
      await fetch(`${API}/api/session/${encodeURIComponent(activeSessionId)}/clear`, {
        method: 'POST',
      });

      setHistoryLines([]);
setLiveChinese('');
setLiveEnglish('');
setRollingBrainState(null);
setBrainStateHistory([]);
lastTranslatedChineseRef.current = '';
lastLiveSnapshotRef.current = '';
    } catch (err) {
      console.error('clear history failed', err);
    }
  };

  const getStatusLabel = () => {
    switch (status) {
      case 'listening':
        return `Listening (${activeAudioMode === 'system' ? 'System Audio' : 'Mic'})`;
      case 'requesting_mic':
        return 'Requesting microphone';
      case 'requesting_system':
        return 'Select a tab for audio';
      case 'stopping':
        return 'Stopping';
      case 'stopped':
        return 'Stopped';
      case 'error':
        return 'Something went wrong';
      default:
        return 'Ready';
    }
  };

  const isListening = status === 'listening';
  const isMicActive = isListening && activeAudioMode === 'mic';
  const isSystemActive = isListening && activeAudioMode === 'system';
  const isAudioActive =
    status === 'requesting_mic' ||
    status === 'requesting_system' ||
    status === 'ws_open' ||
    status === 'listening' ||
    status === 'reconnecting';

  const getSessionId = (entry) => sanitizeSessionId(entry?.sessionId || entry?.id || '');
  const getSessionDisplayName = (entry) => {
    const id = getSessionId(entry);
    const title = String(entry?.title || '').trim();
    if (title && title !== 'TBS Live Session') return title;
    return id || 'Session';
  };

  const backendSessionIds = useMemo(() => {
    return availableSessions
      .map((entry) => getSessionId(entry))
      .filter(Boolean);
  }, [availableSessions]);

  const realSessionIds = useMemo(() => {
    return backendSessionIds.filter(isProductSessionId);
  }, [backendSessionIds]);

  const visibleSessions = useMemo(() => {
    const rows = availableSessions.filter((entry) => {
      const id = getSessionId(entry);
      return isProductSessionId(id);
    });

    return rows.sort((a, b) => {
      const aId = getSessionId(a);
      const bId = getSessionId(b);
      if (aId === activeSessionId) return -1;
      if (bId === activeSessionId) return 1;
      return String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || ''));
    });
  }, [activeSessionId, availableSessions, realSessionIds.length]);

  const activeSessionSummary = useMemo(() => {
    return visibleSessions.find((entry) => getSessionId(entry) === activeSessionId) || null;
  }, [activeSessionId, visibleSessions]);

  const currentSessionName = activeSessionSummary
    ? getSessionDisplayName(activeSessionSummary)
    : activeSessionId === FIXED_SESSION_ID
      ? 'Default'
      : activeSessionId;
  const currentSessionIsLive = isAudioActive && status !== 'stopped' && status !== 'idle';
  const getSessionStatusLabel = (entry) => {
    const id = getSessionId(entry);
    const backendStatus = String(entry?.status || '').toLowerCase();
    if (id === activeSessionId && currentSessionIsLive) return 'LIVE';
    if (backendStatus === 'live' || backendStatus === 'listening') return 'LIVE';
    return 'Idle';
  };
  const getSessionLanguageLabel = (entry) => {
    if (entry?.translationRoute) return entry.translationRoute;
    if (entry?.sourceLanguage && entry?.targetLanguage) {
      return `${entry.sourceLanguage} -> ${entry.targetLanguage}`;
    }
    return 'zh_en';
  };

  useEffect(() => {
    if (!isAdminAuthorized || !isLiveMode) return;
    if (!sessionListLoaded) return;
    if (activeSessionId !== FIXED_SESSION_ID) return;
    if (realSessionIds.length === 0) return;

    setActiveSessionId(realSessionIds[0]);
  }, [activeSessionId, isAdminAuthorized, isLiveMode, realSessionIds, sessionListLoaded]);

  const switchSession = async (nextSessionId) => {
    const sanitized = sanitizeSessionId(nextSessionId) || FIXED_SESSION_ID;
    if (sanitized === activeSessionId) return;

    const reconnectMode = isAudioActive ? activeAudioMode || 'mic' : null;
    if (reconnectMode) {
      pendingReconnectModeRef.current = reconnectMode;
    }

    await stopAudio();
    const registered = await fetch(`${API}/api/session/${encodeURIComponent(sanitized)}`);
    if (!registered.ok) return;

    const refreshed = await fetchSessionList();
    const confirmed = Array.isArray(refreshed)
      ? refreshed.some(
          (entry) => sanitizeSessionId(entry?.sessionId || entry?.id || '') === sanitized
        )
      : false;

    if (confirmed) {
      setActiveSessionId(sanitized);
    }
  };

  const createOrJoinSession = async () => {
    const sanitized = sanitizeSessionId(newSessionName);
    if (!sanitized) return;

    const routeConfig =
      newSessionRoute === 'id_en'
        ? {
            sourceLanguage: 'Bahasa Indonesia',
            targetLanguage: 'English',
            translationRoute: 'id_en',
          }
        : {
            sourceLanguage: 'Mandarin',
            targetLanguage: 'English',
            translationRoute: 'zh_en',
          };
    const reconnectMode = isAudioActive ? activeAudioMode || 'mic' : null;
    if (reconnectMode) {
      pendingReconnectModeRef.current = reconnectMode;
    }

    await stopAudio();
    const registered = await registerSession(sanitized, {
      title: newSessionName.trim(),
      eventMode: newSessionEventMode,
      ...routeConfig,
    });
    if (!registered) return;

    setNewSessionName('');
    setNewSessionEventMode('');
    setNewSessionRoute('zh_en');
    setShowNewSessionInput(false);
    setSessionsExpanded(true);
    await fetchSessionList();
    setActiveSessionId(sanitized);
  };

  const feedItems = useMemo(() => {
    const items = [];

    if (liveChinese || liveEnglish) {
      items.push({
        id: 'live-item',
        time: 'Live',
        chinese: liveChinese,
        english: liveEnglish,
        isLive: true,
        at: new Date().toISOString(),
      });
    }

    historyLines.forEach((line) => {
      items.push({
        id: line.id,
        time: line.time || formatTime(line.at),
        chinese: line.normalizedCn || line.rawCn,
        english: line.en,
        isLive: false,
        at: line.at,
      });
    });

    return items;
  }, [liveChinese, liveEnglish, historyLines]);

  const liveContextItems = useMemo(() => {
    if (brainStateHistory.length > 0) return brainStateHistory;

    if (
      rollingBrainState?.rollingSummary ||
      rollingBrainState?.rollingIntent ||
      rollingBrainState?.rollingTopic
    ) {
      return [
        {
          id: `fallback-${rollingBrainState.rollingUpdatedAt || 'now'}`,
          rollingSummary: rollingBrainState.rollingSummary || '',
          rollingIntent: rollingBrainState.rollingIntent || '',
          rollingTopic: rollingBrainState.rollingTopic || '',
          rollingUpdatedAt: rollingBrainState.rollingUpdatedAt || new Date().toISOString(),
          confidence: rollingBrainState.confidence,
        },
      ];
    }

    return [];
  }, [brainStateHistory, rollingBrainState]);

  useEffect(() => {
    if (!isAdminAuthorized || !isLiveMode) return;
    const el = transcriptFeedRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [feedItems, isAdminAuthorized, isLiveMode]);

  useEffect(() => {
    if (!isAdminAuthorized || !isLiveMode) return;
    if (!session?.id || session.id !== activeSessionId) return;

    const reconnectMode = pendingReconnectModeRef.current;
    if (!reconnectMode) return;

    pendingReconnectModeRef.current = null;
    startAudio(reconnectMode);
  }, [activeSessionId, isAdminAuthorized, isLiveMode, session?.id]);

  useEffect(() => {
  liveConfigRef.current = {
    sourceLanguage,
    targetLanguage,
    translationRoute,
    sessionId: activeSessionId,
  };
}, [activeSessionId, sourceLanguage, targetLanguage, translationRoute]);

  if (!authReady || (authSession && !roleReady)) {
    return <AuthGate mode="loading" email={userEmail} roleLabel={roleLabel} />;
  }

  if (!supabase) {
    return <AuthGate mode="missing-config" email={userEmail} roleLabel={roleLabel} />;
  }

  if (!authSession) {
    return (
      <AuthGate
        mode="login"
        email={userEmail}
        roleLabel={roleLabel}
        onLogin={loginWithGoogle}
      />
    );
  }

  if (!roleLabel) {
    return (
      <AuthGate
        mode="denied"
        email={userEmail}
        roleLabel={roleLabel}
        onLogout={logout}
      />
    );
  }

  if (path === '/study') {
    return (
      <>
        <AuthBadge
          email={userEmail}
          roleLabel={roleLabel}
          onLogout={logout}
          compact={isMobileViewport}
        />
        <Study />
      </>
    );
  }

  if (path === '/review') {
    return (
      <>
        <AuthBadge
          email={userEmail}
          roleLabel={roleLabel}
          onLogout={logout}
          compact={isMobileViewport}
        />
        <Review />
      </>
    );
  }

  if (!session) {
    return (
      <div style={styles.page}>
        <div style={styles.bgOrbA} />
        <div style={styles.bgOrbB} />
        <div style={styles.shell}>
          <ToolTabs current="live" />
          <div style={styles.loadingWrap}>Loading…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.bgOrbA} />
      <div style={styles.bgOrbB} />

      <div style={styles.shell}>
        <AuthBadge
          email={userEmail}
          roleLabel={roleLabel}
          onLogout={logout}
          compact={isMobileViewport}
        />
        <ToolTabs current="live" />

        <div style={{ ...styles.headerCard, ...(isMobileViewport ? styles.headerCardMobile : null) }}>
          <h1 style={{ ...styles.title, ...(isMobileViewport ? styles.titleMobile : null) }}>
            True Buddha School Live Translation
          </h1>

          <div style={styles.headerActions}>
            <div style={styles.actionButtons}>
              <button onClick={clearHistory} style={styles.secondaryButtonDark}>
                Clear
              </button>
            </div>
          </div>

          <div style={{ ...styles.sessionsPanel, ...(isMobileViewport ? styles.sessionsPanelMobile : null) }}>
            <div style={styles.sessionsPanelHeader}>
              <div>
                <div style={styles.sessionsTitle}>Sessions</div>
                <div style={styles.sessionsCurrent}>
                  Current: {currentSessionName}
                  <span
                    style={{
                      ...styles.sessionStatusPill,
                      ...(currentSessionIsLive ? styles.sessionStatusLive : null),
                    }}
                  >
                    {currentSessionIsLive ? 'LIVE' : 'Idle'}
                  </span>
                </div>
              </div>

              <div style={styles.sessionHeaderActions}>
                <button
                  type="button"
                  onClick={() => copyViewerLink(activeSessionId)}
                  style={styles.tinyButtonMuted}
                >
                  {copiedSessionId === activeSessionId ? 'Copied' : 'Copy viewer link'}
                </button>
                <button
                  type="button"
                  onClick={() => setSessionsExpanded((value) => !value)}
                  style={styles.tinyButton}
                >
                  {sessionsExpanded ? 'Hide sessions' : 'Show sessions'}
                </button>
              </div>
            </div>

            {sessionsExpanded ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowNewSessionInput((value) => !value)}
                  style={styles.createSessionToggle}
                >
                  + Create session
                </button>

                {showNewSessionInput ? (
                  <div style={styles.createSessionForm}>
                    <input
                      value={newSessionName}
                      onChange={(event) => setNewSessionName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          createOrJoinSession();
                        }
                      }}
                      placeholder="Session name"
                      style={{
                        ...styles.newSessionInput,
                        ...(isMobileViewport ? styles.fullWidthControl : null),
                      }}
                    />
                    <input
                      value={newSessionEventMode}
                      onChange={(event) => setNewSessionEventMode(event.target.value)}
                      placeholder="Description"
                      style={{
                        ...styles.newSessionInput,
                        ...(isMobileViewport ? styles.fullWidthControl : null),
                      }}
                    />
                    <select
                      value={newSessionRoute}
                      onChange={(event) => setNewSessionRoute(event.target.value)}
                      style={{
                        ...styles.sessionSelect,
                        ...(isMobileViewport ? styles.fullWidthControl : null),
                      }}
                    >
                      <option value="zh_en">Mandarin to English</option>
                      <option value="id_en">Bahasa Indonesia to English</option>
                    </select>
                    <div
                      style={{
                        ...styles.createSessionActions,
                        ...(isMobileViewport ? styles.fullWidthControl : null),
                      }}
                    >
                      <button
                        type="button"
                        onClick={createOrJoinSession}
                        style={{
                          ...styles.tinyButton,
                          ...(isMobileViewport ? styles.flexButton : null),
                        }}
                      >
                        Create
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowNewSessionInput(false);
                          setNewSessionName('');
                          setNewSessionEventMode('');
                        }}
                        style={{
                          ...styles.tinyButtonMuted,
                          ...(isMobileViewport ? styles.flexButton : null),
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}

                <div style={styles.sessionRows}>
                  {visibleSessions.length === 0 ? (
                    <div style={styles.emptySessionRow}>Create a session to start.</div>
                  ) : null}

                  {visibleSessions.map((entry) => {
                    const rowSessionId = getSessionId(entry);
                    const isSelected = rowSessionId === activeSessionId;
                    const statusLabel = getSessionStatusLabel(entry);
                    const isLive = statusLabel === 'LIVE';

                    return (
                      <div
                        key={rowSessionId}
                        style={{
                          ...styles.sessionRow,
                          ...(isSelected ? styles.sessionRowActive : null),
                          ...(isMobileViewport ? styles.sessionRowMobile : null),
                        }}
                      >
                        <div style={styles.sessionRowMain}>
                          <div style={styles.sessionRowTitle}>{getSessionDisplayName(entry)}</div>
                          <div style={styles.sessionRowMeta}>
                            <span
                              style={{
                                ...styles.sessionStatusPill,
                                ...(isLive ? styles.sessionStatusLive : null),
                              }}
                            >
                              {statusLabel}
                            </span>
                            <span>{entry?.lineCount || 0} lines</span>
                            <span>{getSessionLanguageLabel(entry)}</span>
                            <span>{formatTime(entry?.updatedAt)}</span>
                          </div>
                        </div>

                        <div style={styles.sessionRowActions}>
                          <button
                            type="button"
                            onClick={() => switchSession(rowSessionId)}
                            disabled={isSelected}
                            style={{
                              ...styles.tinyButton,
                              ...(isSelected ? styles.tinyButtonDisabled : null),
                            }}
                          >
                            {isSelected ? 'Current' : 'Use'}
                          </button>
                          <button
                            type="button"
                            onClick={() => copyViewerLink(rowSessionId)}
                            style={styles.tinyButton}
                          >
                            {copiedSessionId === rowSessionId ? 'Copied' : 'Copy link'}
                          </button>
                          <button
                            type="button"
                            onClick={() => openViewerLink(rowSessionId)}
                            style={styles.tinyButtonMuted}
                          >
                            Open viewer
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>

          <div style={styles.topStats}>
            <div style={styles.topStatCard}>
              <div style={styles.topStatLabel}>Mode</div>
              <div style={styles.topStatValue}>Live</div>
            </div>

            <div style={styles.topStatCard}>
              <div style={styles.topStatLabel}>Lines</div>
              <div style={styles.topStatValue}>{historyLines.length}</div>
            </div>
          </div>
        </div>

        <div style={styles.languageAndMicWrap}>
          <div style={styles.floatingMicWrap}>
            <div style={styles.floatingStatus}>{getStatusLabel()}</div>

            <div style={styles.audioModeButtons}>
              <button
                onClick={() => (isMicActive ? stopAudio() : startAudio('mic'))}
                style={{
                  ...styles.audioModeButton,
                  ...(isMicActive ? styles.audioModeButtonActive : {}),
                }}
              >
                <img src={micIcon} alt="" style={styles.audioModeIcon} />
                Mic
              </button>

              <button
                onClick={() => (isSystemActive ? stopAudio() : startAudio('system'))}
                style={{
                  ...styles.audioModeButton,
                  ...(isSystemActive ? styles.audioModeButtonActive : {}),
                }}
              >
                System Audio
              </button>
            </div>
          </div>

          <div style={styles.languageRow}>
            <div style={styles.selectCard}>
              <div style={styles.selectLabel}>From</div>
              <select
                value={sourceLanguage}
                onChange={(e) => setSourceLanguage(e.target.value)}
                style={styles.select}
              >
                <option>Mandarin</option>
                <option>Bahasa Indonesia</option>
              </select>
            </div>

            <div style={styles.swapWrap}>
              <div style={styles.swapIcon}>⇄</div>
            </div>

            <div style={styles.selectCard}>
              <div style={styles.selectLabel}>To</div>
              <select
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value)}
                style={styles.select}
              >
                <option>English</option>
              </select>
            </div>
          </div>
        </div>



        <div style={styles.transcriptCard}>
                    {liveContextItems.length > 0 ? (
            <div style={styles.brainStateScrollCard}>
              <div style={styles.brainStateLabel}>Live context</div>
              <div
                className="scroll-premium"
                onScroll={handlePremiumScroll}
                style={styles.brainStateScrollFeed}
              >
                {liveContextItems.map((entry) => (
                  <div key={entry.id} style={styles.brainStateScrollRow}>
                    <div style={styles.brainStateScrollMeta}>
                      {entry.rollingUpdatedAt ? formatTime(entry.rollingUpdatedAt) : '—'}
                    </div>
                    <div style={styles.brainStateScrollText}>
                      {entry.rollingTopic ? `${entry.rollingTopic}: ` : ''}
                      {entry.rollingSummary || ''}
                      {entry.rollingIntent ? ` (${entry.rollingIntent})` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div style={styles.transcriptHeader}>
            <div>
              <div style={styles.cardLabel}>Transcript</div>
              <div style={styles.cardHint}>Draft line appears first, then settles into history.</div>
            </div>

            <div style={styles.debugChip}>
              {audioDebug.lastBytes ? `Audio ${audioDebug.lastBytes}b` : 'Audio idle'}
            </div>
          </div>

          <div
            ref={transcriptFeedRef}
            className="scroll-premium"
            onScroll={handlePremiumScroll}
            style={styles.transcriptFeed}
          >
            {feedItems.length === 0 ? (
              <div style={styles.emptyState}>Waiting for speech…</div>
            ) : (
              feedItems.map((item) => (
                <div
                  key={item.id}
                  style={{
                    ...styles.feedRow,
                    ...(item.isLive ? styles.feedRowLive : {}),
                  }}
                >
                  <div style={styles.feedMetaRow}>
                    <div style={styles.feedMetaLeft}>
                      <div style={styles.feedMeta}>{item.time}</div>
                      {!item.isLive && item.at ? (
                        <div style={styles.feedTimePill}>{formatTime(item.at)}</div>
                      ) : null}
                    </div>

                    {item.isLive && <div style={styles.liveBadge}>Draft</div>}
                  </div>

                  <div style={styles.feedChinese}>{item.chinese || '…'}</div>

                  <div
                    style={{
                      ...styles.feedEnglish,
                      ...(item.isLive ? styles.feedEnglishDraft : {}),
                    }}
                  >
                    {item.english || (item.isLive ? 'Translating…' : '…')}
                  </div>
                </div>
              ))
            )}
          </div>
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
    padding: '20px 16px 108px',
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
  shell: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    maxWidth: '980px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  loadingWrap: {
    minHeight: '50vh',
    display: 'grid',
    placeItems: 'center',
    color: '#fff',
    fontSize: '24px',
    fontWeight: 700,
  },
  authBadge: {
    alignSelf: 'center',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '12px',
    padding: '9px 10px 9px 14px',
    borderRadius: '999px',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.10)',
    color: '#fff',
    textAlign: 'left',
  },
  authBadgeCompact: {
    alignSelf: 'flex-end',
    gap: '8px',
    padding: '6px',
  },
  authBadgeText: {
    fontSize: '12px',
    fontWeight: 800,
    lineHeight: 1.2,
  },
  authInitials: {
    width: '28px',
    height: '28px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '999px',
    background: 'rgba(255,107,53,0.14)',
    color: '#ff8a5b',
    fontSize: '11px',
    fontWeight: 900,
  },
  authEmail: {
    fontSize: '12px',
    fontWeight: 800,
    lineHeight: 1.2,
  },
  authRole: {
    marginTop: '2px',
    color: '#8d8d95',
    fontSize: '11px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  authLogoutButton: {
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    borderRadius: '999px',
    padding: '8px 10px',
    fontSize: '12px',
    fontWeight: 800,
    cursor: 'pointer',
  },
  authLogoutButtonCompact: {
    padding: '7px 8px',
    fontSize: '11px',
  },
  authShell: {
    minHeight: 'calc(100vh - 148px)',
    justifyContent: 'center',
    gap: '14px',
  },
  authIntro: {
    width: '100%',
    maxWidth: '420px',
    margin: '0 auto',
    textAlign: 'left',
  },
  authHeroTitle: {
    margin: 0,
    color: '#fff',
    fontSize: '32px',
    lineHeight: 1.05,
    fontWeight: 900,
  },
  authHeroSubtitle: {
    margin: '8px 0 0',
    color: '#b7b7c0',
    fontSize: '15px',
    lineHeight: 1.4,
    fontWeight: 700,
  },
  authScreenCard: {
    width: '100%',
    maxWidth: '420px',
    margin: '0 auto',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '20px',
    padding: '20px',
    textAlign: 'left',
    backdropFilter: 'blur(14px)',
  },
  authTitle: {
    margin: 0,
    color: '#fff',
    fontSize: '30px',
    lineHeight: 1.1,
    fontWeight: 800,
    letterSpacing: '-0.03em',
    textAlign: 'left',
  },
  authMessage: {
    margin: '12px 0 18px',
    color: '#b7b7c0',
    fontSize: '14px',
    lineHeight: 1.45,
    textAlign: 'left',
  },
  authRolePill: {
    display: 'inline-flex',
    marginBottom: '14px',
    borderRadius: '999px',
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    padding: '8px 10px',
    fontSize: '12px',
    fontWeight: 800,
  },
  authPrimaryButton: {
    width: '100%',
  },
  authHelperCopy: {
    marginTop: '14px',
    color: '#8d8d95',
    fontSize: '12px',
    lineHeight: 1.35,
    fontWeight: 700,
  },
  authHelperLink: {
    color: '#ff8a5b',
    fontWeight: 900,
    textDecoration: 'none',
  },
  publicSessionsPanel: {
    width: '100%',
    maxWidth: '420px',
    margin: '0 auto',
    border: '1px solid rgba(255,255,255,0.08)',
    background: 'rgba(255,255,255,0.035)',
    borderRadius: '18px',
    padding: '14px',
    textAlign: 'left',
  },
  publicSessionsTitle: {
    color: '#fff',
    fontSize: '14px',
    fontWeight: 900,
    marginBottom: '10px',
  },
  publicSessionsEmpty: {
    color: '#8d8d95',
    fontSize: '12px',
    fontWeight: 700,
    lineHeight: 1.35,
  },
  publicSessionRows: {
    display: 'grid',
    gap: '8px',
  },
  publicSessionRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    border: '1px solid rgba(255,255,255,0.07)',
    background: 'rgba(0,0,0,0.14)',
    borderRadius: '14px',
    padding: '10px',
  },
  publicSessionMain: {
    minWidth: 0,
  },
  publicSessionName: {
    color: '#fff',
    fontSize: '13px',
    fontWeight: 900,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  publicSessionMeta: {
    marginTop: '5px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    color: '#8d8d95',
    fontSize: '11px',
    fontWeight: 800,
  },
  publicSessionLink: {
    flex: '0 0 auto',
    border: '1px solid rgba(255,107,53,0.22)',
    background: 'rgba(255,107,53,0.10)',
    color: '#ff8a5b',
    borderRadius: '999px',
    padding: '9px 10px',
    fontSize: '12px',
    fontWeight: 900,
    textDecoration: 'none',
  },
  headerCard: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '28px',
    padding: '24px 22px',
    textAlign: 'left',
    backdropFilter: 'blur(14px)',
  },
  headerCardMobile: {
    borderRadius: '22px',
    padding: '18px 14px',
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
  titleMobile: {
    fontSize: '30px',
    lineHeight: 1.05,
  },
  headerActions: {
    marginTop: '18px',
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  sessionControl: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexWrap: 'wrap',
  },
  sessionLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
  },
  sessionLabelText: {
    color: '#8d8d95',
    fontSize: '11px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  sessionSelect: {
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(255,255,255,0.06)',
    color: '#fff',
    borderRadius: '12px',
    padding: '10px 12px',
    fontSize: '13px',
    fontWeight: 800,
    outline: 'none',
    flex: '1 1 190px',
    minWidth: 0,
  },
  newSessionRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
  },
  newSessionInput: {
    flex: '1 1 180px',
    minWidth: 0,
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    borderRadius: '12px',
    padding: '10px 12px',
    fontSize: '13px',
    fontWeight: 700,
    outline: 'none',
  },
  tinyButton: {
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    borderRadius: '999px',
    padding: '10px 12px',
    fontSize: '12px',
    fontWeight: 800,
    cursor: 'pointer',
  },
  tinyButtonMuted: {
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'transparent',
    color: '#b7b7c0',
    borderRadius: '999px',
    padding: '10px 12px',
    fontSize: '12px',
    fontWeight: 800,
    cursor: 'pointer',
  },
  tinyButtonDisabled: {
    opacity: 0.55,
    cursor: 'default',
  },
  viewerLinkHint: {
    color: '#8d8d95',
    fontSize: '12px',
    fontWeight: 700,
  },
  viewerShareRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
  },
  actionButtons: {
    display: 'flex',
    gap: '10px',
    flexWrap: 'wrap',
  },
  sessionsPanel: {
    marginTop: '14px',
    border: '1px solid rgba(255,255,255,0.08)',
    background: 'rgba(255,255,255,0.035)',
    borderRadius: '18px',
    padding: '14px',
  },
  sessionsPanelMobile: {
    padding: '12px',
    borderRadius: '16px',
  },
  sessionsPanelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    flexWrap: 'wrap',
  },
  sessionHeaderActions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    flexWrap: 'wrap',
  },
  sessionsTitle: {
    color: '#fff',
    fontSize: '15px',
    fontWeight: 900,
    lineHeight: 1.2,
  },
  sessionsCurrent: {
    marginTop: '4px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    color: '#8d8d95',
    fontSize: '12px',
    fontWeight: 800,
  },
  createSessionForm: {
    marginTop: '12px',
    display: 'flex',
    alignItems: 'stretch',
    gap: '8px',
    flexWrap: 'wrap',
  },
  createSessionToggle: {
    marginTop: '12px',
    border: '1px solid rgba(255,107,53,0.22)',
    background: 'rgba(255,107,53,0.10)',
    color: '#ff8a5b',
    borderRadius: '999px',
    padding: '10px 12px',
    fontSize: '12px',
    fontWeight: 900,
    cursor: 'pointer',
  },
  createSessionActions: {
    display: 'flex',
    gap: '8px',
    flex: '1 1 160px',
  },
  fullWidthControl: {
    width: '100%',
    flex: '1 1 100%',
  },
  flexButton: {
    flex: 1,
  },
  sessionRows: {
    marginTop: '12px',
    display: 'grid',
    gap: '8px',
  },
  sessionRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    border: '1px solid rgba(255,255,255,0.07)',
    background: 'rgba(0,0,0,0.14)',
    borderRadius: '14px',
    padding: '10px',
  },
  sessionRowMobile: {
    alignItems: 'stretch',
    flexDirection: 'column',
  },
  sessionRowActive: {
    border: '1px solid rgba(255,107,53,0.35)',
    background: 'rgba(255,107,53,0.08)',
  },
  sessionRowMain: {
    minWidth: 0,
  },
  sessionRowTitle: {
    color: '#fff',
    fontSize: '13px',
    fontWeight: 900,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sessionRowMeta: {
    marginTop: '5px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    color: '#8d8d95',
    fontSize: '11px',
    fontWeight: 800,
  },
  sessionStatusPill: {
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(255,255,255,0.06)',
    color: '#b7b7c0',
    borderRadius: '999px',
    padding: '4px 7px',
    fontSize: '10px',
    lineHeight: 1,
    fontWeight: 900,
    letterSpacing: '0.04em',
  },
  sessionStatusLive: {
    border: '1px solid rgba(255,107,53,0.42)',
    background: 'rgba(255,107,53,0.14)',
    color: '#ff8a5b',
  },
  sessionRowActions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    flexWrap: 'wrap',
  },
  emptySessionRow: {
    border: '1px dashed rgba(255,255,255,0.10)',
    borderRadius: '14px',
    padding: '12px',
    color: '#8d8d95',
    fontSize: '12px',
    fontWeight: 800,
  },
  primaryButton: {
    border: 'none',
    background: 'linear-gradient(135deg, #ff6b35 0%, #ff8a5b 100%)',
    color: '#111',
    borderRadius: '999px',
    padding: '12px 16px',
    fontSize: '13px',
    fontWeight: 800,
    cursor: 'pointer',
    boxShadow: '0 10px 24px rgba(255,107,53,0.22)',
  },
  secondaryButtonDark: {
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(255,255,255,0.04)',
    color: '#fff',
    borderRadius: '999px',
    padding: '12px 16px',
    fontSize: '13px',
    fontWeight: 800,
    cursor: 'pointer',
  },
  topStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '12px',
    marginTop: '18px',
    maxWidth: '420px',
  },
  topStatCard: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '18px',
    padding: '14px 16px',
    textAlign: 'left',
  },
  topStatLabel: {
    fontSize: '11px',
    fontWeight: 800,
    color: '#8d8d95',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '8px',
    textAlign: 'left',
  },
  topStatValue: {
    fontSize: '15px',
    fontWeight: 800,
    color: '#fff',
    lineHeight: 1.35,
    textAlign: 'left',
  },
  languageAndMicWrap: {
    position: 'relative',
    paddingTop: '10px',
    marginTop: '-4px',
    zIndex: 3,
  },
  floatingMicWrap: {
  position: 'fixed',
  left: '50%',
  bottom: '24px',
  transform: 'translateX(-50%)',
  zIndex: 999,

  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '10px 14px',

  borderRadius: '999px',
  background: 'rgba(20,20,20,0.65)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',

  border: '1px solid rgba(255,255,255,0.14)',

  boxShadow: `
    0 20px 50px rgba(0,0,0,0.35),
    0 4px 12px rgba(0,0,0,0.15),
    inset 0 1px 0 rgba(255,255,255,0.08)
  `,
},
  floatingStatus: {
    color: '#fff',
    fontSize: '14px',
    fontWeight: 700,
    textAlign: 'left',
    paddingLeft: '6px',
    whiteSpace: 'nowrap',
  },
  audioModeButtons: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  audioModeButton: {
    minHeight: '44px',
    borderRadius: '999px',
    padding: '0 14px',
    border: '1px solid rgba(255,255,255,0.18)',
    background: 'rgba(255,255,255,0.86)',
    color: '#111',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 800,
    boxShadow:
      '0 8px 18px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.55)',
    backdropFilter: 'blur(8px)',
  },
  audioModeButtonActive: {
    background: 'linear-gradient(135deg, #ff6b35 0%, #ff8a5b 100%)',
  },
  audioModeIcon: {
    width: '16px',
    height: '16px',
    objectFit: 'contain',
    display: 'block',
  },
  languageRow: {
    display: 'grid',
    gridTemplateColumns: '1fr auto 1fr',
    gap: '12px',
    alignItems: 'center',
  },
  selectCard: {
    background: 'rgba(255,255,255,0.92)',
    borderRadius: '20px',
    padding: '12px 14px',
    textAlign: 'left',
    boxShadow: '0 10px 24px rgba(0,0,0,0.12)',
  },
  selectLabel: {
    fontSize: '11px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#777',
    marginBottom: '6px',
    textAlign: 'left',
  },
  select: {
    width: '100%',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    fontSize: '16px',
    fontWeight: 700,
    color: '#111',
    textAlign: 'left',
  },
  swapWrap: {
    display: 'grid',
    placeItems: 'center',
  },
  swapIcon: {
    width: '38px',
    height: '38px',
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.88)',
    display: 'grid',
    placeItems: 'center',
    fontSize: '16px',
    fontWeight: 700,
    color: '#111',
    boxShadow: '0 8px 18px rgba(0,0,0,0.12)',
  },
  transcriptCard: {
    background: '#ff764a',
    borderRadius: '28px',
    padding: '18px',
    color: '#111',
    textAlign: 'left',
    boxShadow: '0 24px 60px rgba(0,0,0,0.22)',
  },
  brainStateScrollCard: {
    background: 'rgba(255,255,255,0.72)',
    border: '1px solid rgba(17,17,17,0.08)',
    borderRadius: '18px',
    padding: '14px 16px',
    marginBottom: '14px',
    textAlign: 'left',
  },
  brainStateLabel: {
    fontSize: '11px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#6a4130',
    marginBottom: '8px',
    textAlign: 'left',
  },
  brainStateScrollFeed: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    maxHeight: '180px',
    overflowY: 'auto',
    paddingRight: '4px',
  },
  brainStateScrollRow: {
    display: 'grid',
    gridTemplateColumns: '84px 1fr',
    gap: '10px',
    alignItems: 'start',
    paddingBottom: '10px',
    borderBottom: '1px solid rgba(17,17,17,0.08)',
    textAlign: 'left',
  },
  brainStateScrollMeta: {
    fontSize: '12px',
    fontWeight: 800,
    color: '#7a5a4a',
    textAlign: 'left',
  },
  brainStateScrollText: {
    fontSize: '14px',
    lineHeight: 1.45,
    fontWeight: 700,
    color: '#222',
    textAlign: 'left',
  },
  transcriptHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '14px',
    flexWrap: 'wrap',
  },
  cardLabel: {
    fontSize: '12px',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#5a3a2e',
    textAlign: 'left',
  },
  cardHint: {
    marginTop: '6px',
    fontSize: '14px',
    color: '#6a4130',
    textAlign: 'left',
  },
  debugChip: {
    background: '#111',
    color: '#fff',
    borderRadius: '999px',
    padding: '9px 12px',
    fontSize: '12px',
    fontWeight: 700,
  },
  transcriptFeed: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    maxHeight: '56vh',
    overflowY: 'auto',
    background: '#fff8f2',
    borderRadius: '22px',
    padding: '6px 0',
    scrollBehavior: 'smooth',
  },
  feedRow: {
    padding: '14px 16px 16px',
    borderBottom: '1px solid rgba(17,17,17,0.08)',
    textAlign: 'left',
    transition: 'background 160ms ease',
  },
  feedRowLive: {
    background: '#fff0e8',
  },
  feedMetaRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    marginBottom: '8px',
  },
  feedMetaLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  feedMeta: {
    fontSize: '12px',
    fontWeight: 700,
    color: '#777',
    textAlign: 'left',
  },
  feedTimePill: {
    background: '#f3e7d8',
    color: '#5b4b40',
    borderRadius: '999px',
    padding: '5px 8px',
    fontSize: '11px',
    fontWeight: 800,
  },
  liveBadge: {
    fontSize: '11px',
    fontWeight: 800,
    color: '#7a4a38',
    background: '#ffd8c8',
    borderRadius: '999px',
    padding: '6px 9px',
  },
  feedChinese: {
    fontSize: '24px',
    lineHeight: 1.26,
    fontWeight: 800,
    color: '#111',
    marginBottom: '8px',
    textAlign: 'left',
    wordBreak: 'break-word',
  },
  feedEnglish: {
    fontSize: '20px',
    lineHeight: 1.4,
    fontWeight: 700,
    color: '#2450d8',
    textAlign: 'left',
    wordBreak: 'break-word',
    transition: 'opacity 160ms ease, color 160ms ease',
  },
  feedEnglishDraft: {
    color: '#5c72c9',
    opacity: 0.82,
  },
  emptyState: {
    padding: '18px 16px',
    color: '#666',
    fontSize: '15px',
    textAlign: 'left',
  },
};
