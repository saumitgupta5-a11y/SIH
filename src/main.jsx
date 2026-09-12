import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// ── Constants ──────────────────────────────────────────────────────────────
const typeLabels = {
  FIR: "FIR / Police Report",
  WITNESS_STATEMENT: "Witness Statement",
  CHARGESHEET: "Charge Sheet",
  FORENSIC_REPORT: "Forensic Report",
  COURT_ORDER: "Court Order / Judgment",
  OTHER: "Legal Notice / Other"
};

// Frontend capability map — mirrors ROLE_PERMISSION_MATRIX on the backend.
// Used only for UI gating (disabling buttons). Backend remains the final authority.
const capabilities = {
  administrator:      { openCase: true,  changeStatus: true,  register: true,  seal: false },
  investigatingOfficer: { openCase: true,  changeStatus: false, register: true,  seal: false },
  forensicAnalyst:    { openCase: false, changeStatus: false, register: false, seal: false },
  prosecutor:         { openCase: false, changeStatus: false, register: false, seal: false },
  courtClerk:         { openCase: true,  changeStatus: true,  register: false, seal: true  }
};

const roleTierColors = {
  1: "#176b87", 2: "#2f6f55", 3: "#176b87", 4: "#9a6b20", 5: "#a33a3a"
};

// ── API helpers ────────────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "include", ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || "The request could not be completed", response.status);
  return payload;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
}

// Render AI text: **bold**, bullet points (•/-), and newlines → JSX
function AiText({ text }) {
  if (!text) return null;
  const lines = text.split("\n");
  return (
    <div className="ai-text-body">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} style={{ height: 6 }} />;
        // Bold: **text** → <strong>
        const parts = trimmed.split(/\*\*(.*?)\*\*/g);
        const rendered = parts.map((part, j) => j % 2 === 1 ? <strong key={j}>{part}</strong> : part);
        const isBullet = /^[•\-–]\s/.test(trimmed);
        if (isBullet) {
          return <div key={i} className="ai-bullet">
            <span className="ai-bullet-dot">›</span>
            <span>{parts.map((part, j) => j % 2 === 1 ? <strong key={j}>{part}</strong> : part.replace(/^[•\-–]\s/, ""))}</span>
          </div>;
        }
        // Emoji headings (lines starting with emoji)
        const isHeading = /^[📁📄👤📌🔒⏳✅⚠️🔍]/.test(trimmed);
        if (isHeading) return <div key={i} className="ai-heading">{rendered}</div>;
        return <div key={i} className="ai-line">{rendered}</div>;
      })}
    </div>
  );
}

// ── Shared small components ────────────────────────────────────────────────
function Pill({ children, tone = "slate" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

function AppNavigation() {
  const links = [
    ["#overview", "Overview"],
    ["#cases", "Cases & registry"],
    ["#intake", "Evidence intake"],
    ["#workbench", "Document workbench"],
    ["#audit", "Audit trail"]
  ];
  return (
    <nav className="app-navigation" aria-label="Evidence platform sections">
      <p>OPERATIONS</p>
      {links.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
      <div className="nav-infrastructure">
        <span className="network-dot" />
        <div><strong>Integrity infrastructure</strong><small>Local network connected</small></div>
      </div>
    </nav>
  );
}

function AiBadge({ model }) {
  return (
    <span className="ai-badge" title={model ? `AI model: ${model}` : "AI-generated response"}>
      AI {model && <span className="ai-model-tag">· {model}</span>}
    </span>
  );
}

// ── Login screen ───────────────────────────────────────────────────────────
function LoginScreen({ accounts, error, onSubmit, busy }) {
  const [username, setUsername] = useState("officer");
  const [password, setPassword] = useState("Nyaya@Officer");
  return (
    <main className="login-shell">
      <div className="login-card">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div><strong>NYAYAVAULT</strong><span>Secure Digital Evidence Platform</span></div>
        </div>
        <p className="eyebrow" style={{ marginTop: 22 }}>AUTHENTICATED ACCESS</p>
        <h1>Sign in to the<br />evidence platform</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 8, lineHeight: 1.6 }}>
          Role-bound sessions protect cases, documents, custody records, and judicial actions.
          Your verified authority determines available operations.
        </p>
        {error && <div className="notice error"><span>!</span>{error}</div>}
        <form onSubmit={(e) => { e.preventDefault(); onSubmit(username, password); }}>
          <label>Username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        <div className="demo-accounts">
          <p className="form-title">Demo credentials</p>
          <ul>
            {(accounts.length ? accounts : [{ username: "officer", password: "Nyaya@Officer", label: "Investigating Officer" }]).map((item) => (
              <li key={item.username}>
                <button type="button" className="text-button" onClick={() => { setUsername(item.username); setPassword(item.password); }}>
                  {item.label}
                </button>
                <code>{item.username} / {item.password}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  );
}

// ── Authority context strip ────────────────────────────────────────────────
function AuthorityStrip({ meInfo }) {
  if (!meInfo) return null;
  const tierColor = roleTierColors[meInfo.authorityTier] || "#a78bfa";
  return (
    <div className="authority-strip">
      <div className="auth-role">
        <span className="tier-dot" style={{ background: tierColor, boxShadow: `0 0 0 3px ${tierColor}30` }} />
        {meInfo.authorityLabel}
        <span style={{ color: "var(--ai-border)", fontSize: 9 }}>|</span>
        Tier {meInfo.authorityTier}
      </div>
      <span className="auth-sep">·</span>
      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{meInfo.description}</span>
      <span style={{ marginLeft: "auto" }} />
      <div className="ai-guard">
        <span className="shield-icon">🛡</span>
        <span>AI: permission-filtered · fail-closed</span>
      </div>
    </div>
  );
}

// ── Role dashboard ─────────────────────────────────────────────────────────
function RoleDashboard({ meInfo, dashboardData, onSelectDocument }) {
  const [open, setOpen] = useState(true);
  if (!dashboardData) return null;
  const { dashboard, authority } = dashboardData;
  if (!dashboard) return null;

  const caps = dashboard.capabilities || {};
  const allCaps = [
    { key: "canOpenCase",       label: "Open Case" },
    { key: "canRegisterDoc",    label: "Register Doc" },
    { key: "canSealDoc",        label: "Judicial Seal" },
    { key: "canChangeStatus",   label: "Change Status" },
    { key: "canGrantAccess",    label: "Grant Access" },
    { key: "canVerify",         label: "Verify" },
    { key: "canDownload",       label: "Download" },
    { key: "canViewAudit",      label: "View Audit" },
    { key: "canViewBlockchain", label: "Blockchain View" },
    { key: "canAdministerUsers",label: "Admin Users" }
  ];

  return (
    <div className="role-dashboard">
      <div className="role-dashboard-header">
        <div>
          <div className="ai-avatar">AI</div>
          <div>
            <h3>Authorized workspace</h3>
            <p>{authority?.authorityLabel || dashboard.authorityLabel} — {authority?.description || dashboard.description}</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {dashboard.summary && (
            <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--ai-text-dim)", marginRight: 8 }}>
              <span><strong style={{ color: "var(--ai-light)", fontSize: 18, display: "block" }}>{dashboard.summary.totalAccessibleDocuments}</strong>Accessible Docs</span>
              <span><strong style={{ color: "var(--ai-light)", fontSize: 18, display: "block" }}>{dashboard.summary.openCases}</strong>Open Cases</span>
              <span><strong style={{ color: "var(--ai-light)", fontSize: 18, display: "block" }}>{dashboard.summary.documentsInCustody}</strong>In Custody</span>
            </div>
          )}
          <button type="button" className="text-button" style={{ color: "var(--ai-text-dim)" }} onClick={() => setOpen((o) => !o)}>
            {open ? "Collapse ↑" : "Expand ↓"}
          </button>
        </div>
      </div>

      {open && (
        <>
          {dashboard.widgets?.length > 0 && (
            <div className="dashboard-widgets">
              {dashboard.widgets.map((widget) => (
                <div key={widget.id} className="dashboard-widget">
                  <h4>{widget.title}</h4>
                  <div className="widget-count">{widget.count}</div>
                  <div className="widget-items">
                    {widget.items?.length > 0
                      ? widget.items.map((item) => (
                          <button
                            key={item.documentId}
                            className="widget-item"
                            onClick={() => onSelectDocument && onSelectDocument(item.documentId)}
                          >
                            <div>
                              <strong>{item.title}</strong>
                              <span>{item.caseReference}{item.docType ? ` · ${item.docType.replaceAll("_", " ")}` : ""}</span>
                            </div>
                            <span className="chevron">›</span>
                          </button>
                        ))
                      : <p className="widget-empty">Nothing in this category for your current access.</p>
                    }
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="dashboard-caps">
            {allCaps.map(({ key, label }) => (
              <span key={key} className={`cap-badge ${caps[key] ? "allowed" : "denied"}`}>
                <span className="cap-dot">{caps[key] ? "✓" : "✗"}</span>
                {label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── AI Chat bubble ─────────────────────────────────────────────────────────
function ChatBubble({ msg }) {
  const isAi = msg.role === "ai";
  return (
    <div className={`chat-bubble-row ${isAi ? "ai" : "user"}`}>
      <div className={`chat-avatar ${isAi ? "ai-av" : "usr-av"}`}>{isAi ? "AI" : "You"}</div>
      <div className={`chat-bubble ${isAi ? "ai" : "user"}`}>
        {isAi ? <AiText text={msg.text} /> : <p>{msg.text}</p>}
        {isAi && (
          <div className="ai-meta">
            <AiBadge model={msg.model} />
            <span>Permission-filtered · {formatDate(msg.at)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── AI Assistant panel ─────────────────────────────────────────────────────
function AiAssistant({ session, selected, selectedId, meInfo, onSelectDocument }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const chatEndRef = useRef(null);

  const scrollToBottom = () => chatEndRef.current?.scrollIntoView({ behavior: "smooth" });

  useEffect(() => { scrollToBottom(); }, [messages]);

  async function send(question = input) {
    const prompt = question.trim();
    if (!prompt || busy) return;
    setInput("");
    setBusy(true);
    const userMsg = { role: "user", text: prompt, at: new Date().toISOString() };
    setMessages((m) => [...m, userMsg]);
    try {
      const result = await api("/api/ai/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: prompt, selectedDocumentId: selected?.documentId || selectedId || "" })
      });
      setAiResult(result);
      const aiMsg = {
        role: "ai",
        text: result.answer,
        model: result.modelUsed,
        at: new Date().toISOString()
      };
      setMessages((m) => [...m, aiMsg]);
    } catch (error) {
      setMessages((m) => [...m, { role: "ai", text: "I can't provide that information with your current access.", at: new Date().toISOString() }]);
    } finally {
      setBusy(false);
    }
  }

  const examples = [
    "Show me all my cases",
    "Give me a summary of all cases",
    "What documents are in my custody?",
    "What should I do next?",
    "Show all forensic reports",
    "Which documents are sealed?"
  ];

  return (
    <section className="ai-copilot" aria-labelledby="ai-assistant-title">
      {/* Header */}
      <div className="ai-copilot-header">
        <div className="ai-header-brand">
          <div className="ai-avatar-large">AI</div>
          <div>
            <div className="ai-name-row">
              <h2 id="ai-assistant-title">AI Evidence Assistant</h2>
              <AiBadge model={aiResult?.modelUsed || "local"} />
            </div>
            <p>
              Authority-aware assistance for your authorized evidence workspace.
              Retrieval remains subject to your verified role permissions.
              {meInfo && <span style={{ color: "var(--ai)", fontWeight: 600 }}> Active authority: {meInfo.authorityLabel}.</span>}
            </p>
          </div>
        </div>
        <div className="ai-shield">
          <span className="shield-icon">✓</span>
          <strong>Permission-filtered</strong>
          <small>Authorization remains enforced before evidence is retrieved.</small>
        </div>
      </div>

      {/* Chat body */}
      <div className="ai-chat-body">
        {messages.length === 0 && (
          <div style={{ color: "var(--ai-text-dim)", fontSize: 13, textAlign: "center", padding: "24px 0" }}>
            <strong style={{ color: "var(--ai-text)", display: "block", marginBottom: 6 }}>
              Evidence assistance for this workspace
            </strong>
            <span style={{ color: "var(--ai-text-dim)", lineHeight: 1.6 }}>
              Ask me anything about your authorized cases and documents.<br />
              I'll always tell you the <strong>case name</strong>, <strong>document title</strong>, and what you can do.
            </span>
          </div>
        )}
        {messages.map((msg, i) => <ChatBubble key={i} msg={msg} />)}
        {busy && (
          <div className="chat-bubble-row ai">
            <div className="chat-avatar ai-av">✦</div>
            <div className="chat-bubble ai">
              <div className="typing-dots"><span /><span /><span /></div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Example prompts */}
      <div className="ai-examples">
        <span style={{ color: "var(--text-quiet)", fontSize: 10 }}>Try:</span>
        {examples.map((ex) => (
          <button key={ex} type="button" className="ex-btn" disabled={busy} onClick={() => send(ex)}>{ex}</button>
        ))}
      </div>

      {/* Query bar */}
      <div className="ai-query-bar">
        <input
          value={input}
          maxLength="800"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask about authorized documents, custody history, or workflow…"
          aria-label="Ask NyayaVault AI"
        />
        <button className="ai-primary" disabled={busy || !input.trim()} onClick={() => send()}>
          {busy ? "Checking access…" : "Ask"}
        </button>
      </div>

      {/* AI result cards */}
      {aiResult?.results?.length > 0 && (
        <div className="ai-results-panel">
          <h3>
            <AiBadge /> Authorized results ({aiResult.totalAuthorizedDocuments} in your access scope)
          </h3>
          <div className="ai-result-cards">
            {aiResult.results.map((item) => (
              <div key={item.documentId} className="ai-result-card">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{item.title}</strong>
                  <div className="doc-meta">
                    {item.caseTitle && item.caseTitle !== item.caseReference
                      ? <><span style={{ color: "var(--ai-text-dim)", fontWeight: 600 }}>{item.caseTitle}</span>{" · "}</>
                      : null}
                    {item.caseReference} · {item.documentReference} · {typeLabels[item.docType] || item.docType?.replaceAll("_"," ")}
                  </div>
                  <div className="action-pills">
                    {item.actions?.slice(0, 4).map((action) => (
                      <Pill key={action.key} tone="violet">{action.key.replaceAll("_", " ")}</Pill>
                    ))}
                    {item.sealed && <Pill tone="red">SEALED</Pill>}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-open"
                  onClick={() => { onSelectDocument(item.documentId); window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); }}
                >
                  Open →
                </button>
              </div>
            ))}
          </div>
          {aiResult.recommendation && (
            <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 6, background: "rgba(139,92,246,.08)", border: "1px solid rgba(139,92,246,.18)", fontSize: 12, color: "var(--ai-text-dim)" }}>
              <AiBadge /> <strong style={{ color: "var(--ai-light)" }}>Recommended:</strong>{" "}
              {aiResult.recommendation.reason}
            </div>
          )}
          <p style={{ fontSize: 10, color: "var(--text-quiet)", marginTop: 10 }}>{aiResult.security}</p>
        </div>
      )}
    </section>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────
function App() {
  const [session, setSession] = useState(null);
  const [demoAccounts, setDemoAccounts] = useState([]);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [config, setConfig] = useState(null);
  const [cases, setCases] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [activity, setActivity] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [caseFilter, setCaseFilter] = useState("");
  const [caseForm, setCaseForm] = useState({ reference: "", title: "" });
  const [documentForm, setDocumentForm] = useState({ caseReference: "", documentReference: "", title: "", docType: "0", file: null });
  const [caseStatus, setCaseStatus] = useState({ caseId: "", status: "1" });
  const [versionFile, setVersionFile] = useState(null);
  const [transfer, setTransfer] = useState({ toActor: "forensicAnalyst", action: "Handed over for forensic examination" });
  const [access, setAccess] = useState("prosecutor");
  const [verify, setVerify] = useState({ file: null, version: "1", result: null });
  const [meInfo, setMeInfo] = useState(null);
  const [dashboardData, setDashboardData] = useState(null);
  const intakeFileRef  = useRef(null);
  const versionFileRef = useRef(null);
  const verifyFileRef  = useRef(null);

  const actor = session?.actorKey;
  const caps  = capabilities[actor] || {};
  const activeActor = useMemo(() => config?.actors.find((item) => item.key === actor), [config, actor]);

  const handleAuthFailure = useCallback((error) => {
    if (error.status === 401) {
      setSession(null); setConfig(null); setSelected(null); setSelectedId("");
      setMeInfo(null); setDashboardData(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    const [nextCases, nextDocs, nextActivity] = await Promise.all([
      api("/api/cases"),
      api("/api/documents"),
      api("/api/activity")
    ]);
    setCases(nextCases); setDocuments(nextDocs); setActivity(nextActivity);
    return nextDocs;
  }, []);

  // Load demo accounts / existing session on mount
  useEffect(() => {
    (async () => {
      try {
        const payload = await api("/api/session");
        setSession(payload.user);
        setDemoAccounts(payload.demoAccounts || []);
      } catch {
        try {
          const opts = await fetch("/api/login-options", { credentials: "include" });
          const body = await opts.json().catch(() => ({}));
          setDemoAccounts(body.demoAccounts || []);
        } catch { /* login screen still works */ }
      } finally {
        setBootstrapped(true);
      }
    })();
  }, []);

  // Load config + data on session change
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const [nextConfig, nextMe, nextDash] = await Promise.all([
          api("/api/config"),
          api("/api/me"),
          api("/api/ai/dashboard")
        ]);
        setConfig(nextConfig);
        setMeInfo(nextMe);
        setDashboardData(nextDash);
        const nextDocs = await refresh();
        if (nextDocs[0]) setSelectedId(nextDocs[0].documentId);
      } catch (error) {
        handleAuthFailure(error);
        setNotice({ type: "error", text: error.message });
      }
    })();
  }, [session, refresh, handleAuthFailure]);

  // Refresh dashboard whenever documents change
  useEffect(() => {
    if (!session) return;
    api("/api/ai/dashboard").then(setDashboardData).catch(() => {});
  }, [documents, session]);

  // Load selected document detail
  useEffect(() => {
    if (!session || !selectedId || busy) return;
    let cancelled = false;
    api(`/api/documents/${selectedId}`)
      .then((detail) => { if (!cancelled) { setSelected(detail); setVerify((v) => ({ ...v, version: String(detail.versions.length), result: null })); } })
      .catch((error) => {
        if (cancelled) return;
        handleAuthFailure(error);
        setSelected(null);
        if (error.status === 403) setSelectedId("");
        setNotice({ type: "error", text: error.message });
      });
    return () => { cancelled = true; };
  }, [selectedId, session, busy, handleAuthFailure]);

  async function run(action, successText) {
    setBusy(true); setNotice(null);
    try {
      const result = await action();
      await refresh();
      if (successText) setNotice({ type: "success", text: typeof successText === "function" ? successText(result) : successText });
      return result;
    } catch (error) {
      handleAuthFailure(error);
      setNotice({ type: "error", text: error.message });
      return null;
    } finally { setBusy(false); }
  }

  async function signIn(username, password) {
    setBusy(true); setLoginError("");
    try {
      const payload = await api("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      setDemoAccounts(payload.demoAccounts || []);
      setSession(payload.user);
    } catch (error) { setLoginError(error.message); }
    finally { setBusy(false); }
  }

  async function signOut() {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    setSession(null); setSelected(null); setSelectedId("");
    setDocuments([]); setCases([]); setActivity([]);
    setMeInfo(null); setDashboardData(null);
  }

  async function downloadDocument(documentId, version) {
    const suffix = version ? `?version=${version}` : "";
    try {
      const response = await fetch(`/api/documents/${documentId}/download${suffix}`, { credentials: "include" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Download failed");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const header = response.headers.get("content-disposition") || "";
      const match = header.match(/filename="?([^"]+)"?/i);
      link.href = url; link.download = match?.[1] || "evidence.bin"; link.click();
      URL.revokeObjectURL(url);
    } catch (error) { setNotice({ type: "error", text: error.message }); }
  }

  const filteredDocuments = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return documents.filter((item) => {
      if (caseFilter && item.caseId !== caseFilter) return false;
      if (!needle) return true;
      return [item.title, item.caseReference, item.documentReference, item.documentId].join(" ").toLowerCase().includes(needle);
    });
  }, [documents, query, caseFilter]);

  const participantName = (address) => {
    const p = config?.actors.find((item) => item.address.toLowerCase() === address?.toLowerCase());
    return p?.label || "Authorized participant";
  };
  const isCurrentCustodian = Boolean(selected && activeActor && selected.currentCustodian?.toLowerCase() === activeActor.address?.toLowerCase());
  const caseAllowsDocumentChanges = ["OPEN", "UNDER_TRIAL"].includes(selected?.caseStatus);
  const canModifyDocument = Boolean(isCurrentCustodian && !selected?.sealed && caseAllowsDocumentChanges);
  const canManageAccess   = Boolean(isCurrentCustodian || actor === "administrator" || actor === "courtClerk");
  const accessTarget = config?.actors.find((item) => item.key === access);
  const accessTargetIsCustodian = Boolean(accessTarget && selected?.currentCustodian?.toLowerCase() === accessTarget.address.toLowerCase());
  const metadata = selected?.files?.find((file) => file.version === selected?.versions?.length);

  if (!bootstrapped) return <main className="login-shell"><p className="quiet">Connecting to NyayaVault…</p></main>;
  if (!session)      return <LoginScreen accounts={demoAccounts} error={loginError} onSubmit={signIn} busy={busy} />;

  return (
    <main className="shell">
      {busy && <div className="busy-bar" aria-hidden="true" />}

      {/* Topbar */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div><strong>NYAYAVAULT</strong><span>Secure Digital Evidence Platform</span></div>
        </div>
        <div className="network"><span className="network-dot" /> Integrity network <span>{config ? "Connected" : "Connecting…"}</span></div>
        <div className="session-chip">
          <span>Signed in</span>
          <strong>{session.label}</strong>
          <button type="button" className="text-button" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <AppNavigation />

      {/* Authority strip — always visible, reminds user of their role */}
      <AuthorityStrip meInfo={meInfo} />

      {/* Hero */}
      <section className="hero" id="overview">
        <div>
          <p className="eyebrow">EVIDENCE OPERATIONS</p>
          <h1>Secure evidence records.<br /><span>Verifiable history.</span></h1>
          <p className="hero-copy">
            Manage legal evidence with accountable custody, retained versions, access controls, and
            integrity records. The platform presents blockchain as trusted audit infrastructure.
          </p>
        </div>
        <div className="hero-trust">
          <span>SYSTEM ASSURANCE</span>
          <strong>Evidence lifecycle<br />under control</strong>
          <div>
            <Pill tone="green">Session</Pill>
            <Pill>SHA-256</Pill>
            <Pill tone="blue">RBAC</Pill>
            <Pill tone="violet">AI access</Pill>
          </div>
        </div>
      </section>

      {notice && (
        <div className={`notice ${notice.type}`}>
          <span>{notice.type === "success" ? "✓" : "!"}</span>
          {notice.text}
          <button onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Stats */}
      <section className="stats">
        <article>
          <span>ACTIVE CASES</span>
          <strong>{cases.filter((item) => item.status === "OPEN" || item.status === "UNDER_TRIAL").length}</strong>
          <small>{cases.length} indexed locally</small>
        </article>
        <article>
          <span>ACCESSIBLE DOCUMENTS</span>
          <strong>{documents.length}</strong>
          <small>{activeActor?.label || "Participant"} view</small>
        </article>
        <article>
          <span>AUDIT EVENTS</span>
          <strong>{activity.length}</strong>
          <small>Latest 60 actions</small>
        </article>
        <article className="actor-card">
          <span>CURRENT AUTHORITY</span>
          <strong>{activeActor?.role || "—"}</strong>
          <small>{meInfo ? `Authority Tier ${meInfo.authorityTier}` : "Verified signed-in identity"}</small>
        </article>
      </section>

      {/* AI-powered Role Dashboard */}
      <RoleDashboard
        meInfo={meInfo}
        dashboardData={dashboardData}
        onSelectDocument={setSelectedId}
      />

      {/* AI Chat Assistant */}
      <AiAssistant
        session={session}
        selected={selected}
        selectedId={selectedId}
        meInfo={meInfo}
        onSelectDocument={setSelectedId}
      />

      {/* Case desk + Document ledger */}
      <section className="workspace" id="cases">
        <aside className="control-panel">
          <div className="panel-heading"><p className="eyebrow">CASE MANAGEMENT</p><h2>Case controls</h2></div>

          <form onSubmit={(e) => { e.preventDefault(); run(async () => {
            await api("/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(caseForm) });
            setCaseForm({ reference: "", title: "" });
          }, "Case opened and recorded on-chain."); }}>
            <label>Case reference<input required placeholder="FIR-2026-0042" value={caseForm.reference} onChange={(e) => setCaseForm({ ...caseForm, reference: e.target.value })} /></label>
            <label>Case title<input required placeholder="State v. Example" value={caseForm.title} onChange={(e) => setCaseForm({ ...caseForm, title: e.target.value })} /></label>
            <button className="primary" disabled={busy || !caps.openCase}>
              {caps.openCase ? <>Open case <span>→</span></> : "Officer / court / admin only"}
            </button>
          </form>

          <div className="divider" />

          <form onSubmit={(e) => { e.preventDefault(); run(async () =>
            api(`/api/cases/${caseStatus.caseId}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: Number(caseStatus.status) }) }),
          "Case status written to the contract."); }}>
            <p className="form-title">Case lifecycle</p>
            <label>Case
              <select required value={caseStatus.caseId} onChange={(e) => setCaseStatus({ ...caseStatus, caseId: e.target.value })}>
                <option value="">Select a case</option>
                {cases.map((item) => <option key={item.caseId} value={item.caseId}>{item.reference} · {item.status}</option>)}
              </select>
            </label>
            <label>New status
              <select value={caseStatus.status} onChange={(e) => setCaseStatus({ ...caseStatus, status: e.target.value })}>
                {config?.caseStatuses.map((item, index) => <option key={item} value={index}>{item.replaceAll("_", " ")}</option>)}
              </select>
            </label>
            <button className="secondary" disabled={busy || !caps.changeStatus}>
              {caps.changeStatus ? "Update status" : "Court / admin only"}
            </button>
          </form>
        </aside>

        <section className="documents-panel">
          <div className="section-heading">
            <div><p className="eyebrow">EVIDENCE REGISTRY</p><h2>Document records</h2></div>
            <span className="muted">Integrity records anchored on-chain</span>
          </div>
          <div className="ledger-tools">
            <input placeholder="Search title, case number, or document reference" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select value={caseFilter} onChange={(e) => setCaseFilter(e.target.value)}>
              <option value="">All cases</option>
              {cases.map((item) => <option key={item.caseId} value={item.caseId}>{item.reference}</option>)}
            </select>
          </div>

          {filteredDocuments.length
            ? <div className="document-list">
                {filteredDocuments.map((item) => (
                  <button key={item.documentId} onClick={() => setSelectedId(item.documentId)}
                    className={`document-row ${selectedId === item.documentId ? "selected" : ""}`}>
                    <div className="doc-icon">{item.title.slice(0, 1).toUpperCase()}</div>
                    <div className="doc-main">
                      <strong>{item.title}</strong>
                      <span>{item.caseReference} · {item.documentReference}</span>
                    </div>
                    <Pill tone="blue">{item.createdBy === actor ? "CREATED" : "GRANTED"}</Pill>
                    <span className="hash">Integrity recorded</span>
                    <span className="chevron">›</span>
                  </button>
                ))}
              </div>
            : <div className="empty">
                <div>⌁</div>
                <strong>No matching documents</strong>
                <p>Open a case, then register its first record, or clear the search filters.</p>
              </div>
          }
        </section>
      </section>

      {/* Document intake */}
      <section className="intake-section" id="intake">
        <div>
          <p className="eyebrow">DOCUMENT INTAKE</p>
          <h2>Register an evidence file</h2>
          <p>The file remains in local storage. Its SHA-256 integrity record and evidence metadata are registered as version 1.</p>
        </div>
        <form className="intake-form" onSubmit={(e) => { e.preventDefault(); run(async () => {
          const body = new FormData();
          Object.entries(documentForm).forEach(([key, value]) => { if (value !== null) body.append(key, value); });
          const created = await api("/api/documents", { method: "POST", body });
          setDocumentForm({ caseReference: "", documentReference: "", title: "", docType: "0", file: null });
          if (intakeFileRef.current) intakeFileRef.current.value = "";
          setSelectedId(created.documentId);
        }, "Document registered. Integrity is now anchored on-chain."); }}>
          <label>Case
            <select required value={documentForm.caseReference} onChange={(e) => setDocumentForm({ ...documentForm, caseReference: e.target.value })}>
              <option value="">Choose an active case</option>
              {cases.filter((item) => item.status === "OPEN" || item.status === "UNDER_TRIAL")
                .map((item) => <option key={item.caseId} value={item.reference}>{item.reference} — {item.title} · {item.status.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <label>Document reference<input required placeholder="EVD-001" value={documentForm.documentReference} onChange={(e) => setDocumentForm({ ...documentForm, documentReference: e.target.value })} /></label>
          <label>Document title<input required placeholder="Initial incident report" value={documentForm.title} onChange={(e) => setDocumentForm({ ...documentForm, title: e.target.value })} /></label>
          <label>Document type
            <select value={documentForm.docType} onChange={(e) => setDocumentForm({ ...documentForm, docType: e.target.value })}>
              {config?.documentTypes.map((item, index) => <option key={item} value={index}>{typeLabels[item]}</option>)}
            </select>
          </label>
          <label className="file-label">Evidence file
            <input ref={intakeFileRef} required type="file" onChange={(e) => setDocumentForm({ ...documentForm, file: e.target.files?.[0] || null })} />
            <span>{documentForm.file ? documentForm.file.name : "Choose a file · max 15 MB"}</span>
          </label>
          <button className="primary intake-button" disabled={busy || !caps.register}>
            {caps.register ? <>Hash &amp; register <span>→</span></> : "Officer / admin only"}
          </button>
        </form>
      </section>

      {/* Document workbench */}
      <section className="detail-section" id="workbench">
        <div className="section-heading">
          <div><p className="eyebrow">DOCUMENT WORKBENCH</p><h2>{selected?.title || "Select an evidence record"}</h2></div>
          {selected && (
            <div className="detail-badges">
              <Pill tone={selected.sealed ? "red" : "green"}>{selected.sealed ? "SEALED / IMMUTABLE" : selected.caseStatus}</Pill>
              <Pill tone="blue">{selected.docType.replaceAll("_", " ")}</Pill>
            </div>
          )}
        </div>

        {!selected
          ? <div className="empty detail-empty"><div>▣</div><strong>Choose a document from the ledger</strong><p>Blockchain state, audit history, and permitted actions appear here.</p></div>
          : <>
              <div className="integrity-strip">
                <div><span>CASE REFERENCE</span><strong>{selected.caseReference}</strong></div>
                <div><span>DOCUMENT REFERENCE</span><strong>{selected.documentReference}</strong></div>
                <div><span>CURRENT CUSTODIAN</span><strong>{participantName(selected.currentCustodian)}</strong></div>
                <div><span>INTEGRITY STATUS</span><strong>Verified record · Version {selected.versions.length}</strong></div>
                <button type="button" className="download" onClick={() => downloadDocument(selected.documentId)}>Download latest</button>
              </div>

              <div className="detail-grid">
                <article className="timeline-card">
                  <h3>Version history</h3>
                  {selected.versions.map((version) => (
                    <div className="timeline" key={version.version}>
                      <span className="timeline-dot" />
                      <div>
                        <strong>Version {version.version}</strong>
                        <p>SHA-256 integrity record retained</p>
                        <small>{formatDate(version.timestamp)} by {participantName(version.createdBy)}</small>
                      </div>
                      <button type="button" className="text-button" onClick={() => downloadDocument(selected.documentId, version.version)}>file ↗</button>
                    </div>
                  ))}
                </article>

                <article className="timeline-card">
                  <h3>Chain of custody</h3>
                  {selected.custody.length
                    ? selected.custody.map((event, index) => (
                        <div className="timeline" key={`${event.timestamp}-${index}`}>
                          <span className="timeline-dot amber" />
                          <div>
                            <strong>{event.action}</strong>
                            <p>{participantName(event.from)} → {participantName(event.to)}</p>
                            <small>{formatDate(event.timestamp)}</small>
                          </div>
                        </div>
                      ))
                    : <p className="quiet">No transfers recorded. The registering officer remains the custodian.</p>
                  }
                </article>

                <article className="timeline-card">
                  <h3>Local file record</h3>
                  <p className="quiet">{metadata?.originalName || "No local file metadata"}</p>
                  <p className="quiet">Stored locally; the integrity record is anchored in the audit infrastructure.</p>
                </article>
              </div>

              <div className="actions-grid">
                {/* Add version */}
                <form className="action-card" onSubmit={(e) => { e.preventDefault(); if (!canModifyDocument) return; run(async () => {
                  const body = new FormData(); body.append("file", versionFile);
                  await api(`/api/documents/${selected.documentId}/versions`, { method: "POST", body });
                  setVersionFile(null); if (versionFileRef.current) versionFileRef.current.value = "";
                }, "New document version anchored on-chain."); }}>
                  <h3>Add version</h3>
                  <p>Only the current custodian can replace a mutable document.</p>
                  <input ref={versionFileRef} required disabled={!canModifyDocument} type="file" onChange={(e) => setVersionFile(e.target.files?.[0] || null)} />
                  <button className="secondary" disabled={busy || !canModifyDocument}>
                    {isCurrentCustodian ? "Create next version" : "Custodian only"}
                  </button>
                </form>

                {/* Transfer custody */}
                <form className="action-card" onSubmit={(e) => { e.preventDefault(); if (!canModifyDocument) return; run(async () =>
                  api(`/api/documents/${selected.documentId}/custody`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(transfer) }),
                "Custody transfer recorded on-chain."); }}>
                  <h3>Transfer custody</h3>
                  <p>Current custodian signs the handoff and reason.</p>
                  <select disabled={!canModifyDocument} value={transfer.toActor} onChange={(e) => setTransfer({ ...transfer, toActor: e.target.value })}>
                    {config?.actors.filter((item) => item.key !== actor).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                  </select>
                  <input required disabled={!canModifyDocument} value={transfer.action} onChange={(e) => setTransfer({ ...transfer, action: e.target.value })} />
                  <button className="secondary" disabled={busy || !canModifyDocument}>
                    {isCurrentCustodian ? "Record transfer" : "Custodian only"}
                  </button>
                </form>

                {/* Grant access */}
                <form className="action-card" onSubmit={(e) => { e.preventDefault(); if (!canManageAccess) return; run(async () =>
                  api(`/api/documents/${selected.documentId}/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ granteeActor: access, grant: true }) }),
                "Access permission updated on-chain."); }}>
                  <h3>Grant read access</h3>
                  <p>Custodian, court, or administrator can permit another participant.</p>
                  <select disabled={!canManageAccess} value={access} onChange={(e) => setAccess(e.target.value)}>
                    {config?.actors.filter((item) => item.key !== actor).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                  </select>
                  <button className="secondary" disabled={busy || !canManageAccess}>
                    {canManageAccess ? "Grant access" : "No grant authority"}
                  </button>
                  <button type="button" className="text-button" disabled={busy || !canManageAccess || accessTargetIsCustodian}
                    onClick={() => run(async () =>
                      api(`/api/documents/${selected.documentId}/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ granteeActor: access, grant: false }) }),
                    "Access revoked on-chain.")}>
                    {accessTargetIsCustodian ? "Custodian access cannot be revoked" : "Revoke selected access"}
                  </button>
                </form>

                {/* Verify integrity */}
                <form className="action-card verify-card" onSubmit={(e) => { e.preventDefault(); run(async () => {
                  const body = new FormData(); body.append("file", verify.file); body.append("version", verify.version);
                  const result = await api(`/api/documents/${selected.documentId}/verify`, { method: "POST", body });
                  setVerify({ ...verify, result }); return result;
                }, (result) => result?.verified ? "File matches the protected record." : "File does not match this version."); }}>
                  <h3>Verify integrity</h3>
                  <p>Compare a local file with the protected record for this version.</p>
                  <select value={verify.version} onChange={(e) => setVerify({ ...verify, version: e.target.value, result: null })}>
                    {selected.versions.map((item) => <option key={item.version} value={item.version}>Version {item.version}</option>)}
                  </select>
                  <input ref={verifyFileRef} required type="file" onChange={(e) => setVerify({ ...verify, file: e.target.files?.[0] || null, result: null })} />
                  <button className="primary" disabled={busy}>Verify file</button>
                  {verify.result && (
                    <div className={`verify-result ${verify.result.verified ? "match" : "mismatch"}`}>
                      {verify.result.verified ? "✓ File matches the protected record" : "× File does not match this version"}
                    </div>
                  )}
                </form>

                {/* Judicial seal */}
                <div className="action-card seal-card">
                  <h3>Judicial seal</h3>
                  <p>Only the court role can permanently freeze versions and custody transfers.</p>
                  <button className="danger" disabled={busy || selected.sealed || !caps.seal}
                    onClick={() => run(async () =>
                      api(`/api/documents/${selected.documentId}/seal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }),
                    "Document sealed permanently on-chain.")}>
                    {selected.sealed ? "Already sealed" : caps.seal ? "Seal document permanently" : "Sign in as Court Clerk"}
                  </button>
                  <small>Sign out and authenticate as Court Clerk to perform this action.</small>
                </div>
              </div>
            </>
        }
      </section>

      {/* Audit log */}
      <section className="activity-section" id="audit">
        <div className="section-heading">
          <div><p className="eyebrow">AUDIT TRAIL</p><h2>Recent recorded activity</h2></div>
        </div>
        {activity.length
          ? <div className="audit-list">
              {activity.slice(0, 10).map((item) => (
                <div className="audit-row" key={item.id}>
                  <span className={`audit-icon ${item.type === "AI_ASSISTED_RETRIEVAL" ? "ai-event" : ""}`}>
                    {item.type === "AI_ASSISTED_RETRIEVAL" ? "AI" : item.type.includes("SEALED") ? "S" : item.type.includes("ACCESS") ? "A" : "R"}
                  </span>
                  <div>
                    <strong>{item.description}</strong>
                    <small>{item.actor} · {formatDate(item.at)}</small>
                  </div>
                  <span className="audit-status">
                    {item.type === "AI_ASSISTED_RETRIEVAL" ? <AiBadge /> : "Integrity record"}
                  </span>
                </div>
              ))}
            </div>
          : <p className="quiet" style={{ padding: "18px 24px" }}>Authenticated actions recorded through this local MVP appear here.</p>
        }
      </section>

      <footer>
        NYAYAVAULT · Secure digital evidence operations · Local demonstration environment ·
        AI retrieval is permission-filtered and authority-aware.
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
