import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const typeLabels = {
  FIR: "FIR / Police Report",
  WITNESS_STATEMENT: "Witness Statement",
  CHARGESHEET: "Charge Sheet",
  FORENSIC_REPORT: "Forensic Report",
  COURT_ORDER: "Court Order / Judgment",
  OTHER: "Legal Notice / Other"
};

const capabilities = {
  administrator: { openCase: true, changeStatus: true, register: true, seal: false },
  investigatingOfficer: { openCase: true, changeStatus: false, register: true, seal: false },
  forensicAnalyst: { openCase: false, changeStatus: false, register: false, seal: false },
  prosecutor: { openCase: false, changeStatus: false, register: false, seal: false },
  courtClerk: { openCase: true, changeStatus: true, register: false, seal: true }
};

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
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

function Pill({ children, tone = "slate" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

function LoginScreen({ accounts, error, onSubmit, busy }) {
  const [username, setUsername] = useState("officer");
  const [password, setPassword] = useState("Nyaya@Officer");
  return (
    <main className="login-shell">
      <div className="login-card">
        <div className="brand"><div className="brand-mark">N</div><div><strong>NyayaVault</strong><span>Secure legal document workspace</span></div></div>
        <p className="eyebrow">AUTHENTICATED ACCESS</p>
        <h1>Sign in to the evidence registry</h1>
        <p className="hero-copy">Role-bound sessions protect FIRs, forensic reports, charge sheets, and court records. Identity is no longer a dropdown.</p>
        {error && <div className="notice error"><span>!</span>{error}</div>}
        <form onSubmit={(event) => { event.preventDefault(); onSubmit(username, password); }}>
          <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        <div className="demo-accounts">
          <p className="form-title">Demo credentials</p>
          <ul>
            {(accounts.length ? accounts : [
              { username: "officer", password: "Nyaya@Officer", label: "Investigating Officer" }
            ]).map((item) => (
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
  const intakeFileRef = useRef(null);
  const versionFileRef = useRef(null);
  const verifyFileRef = useRef(null);

  const actor = session?.actorKey;
  const caps = capabilities[actor] || {};
  const activeActor = useMemo(() => config?.actors.find((item) => item.key === actor), [config, actor]);

  const handleAuthFailure = useCallback((error) => {
    if (error.status === 401) {
      setSession(null);
      setConfig(null);
      setSelected(null);
      setSelectedId("");
    }
  }, []);

  const refresh = useCallback(async () => {
    const [nextCases, nextDocs, nextActivity] = await Promise.all([
      api("/api/cases"),
      api("/api/documents"),
      api("/api/activity")
    ]);
    setCases(nextCases);
    setDocuments(nextDocs);
    setActivity(nextActivity);
    return nextDocs;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const payload = await api("/api/session");
        setSession(payload.user);
        setDemoAccounts(payload.demoAccounts || []);
      } catch (error) {
        setDemoAccounts(error.status === 401 ? [] : []);
        try {
          const options = await fetch("/api/login-options", { credentials: "include" });
          const body = await options.json().catch(() => ({}));
          setDemoAccounts(body.demoAccounts || []);
        } catch { /* login screen still works */ }
      } finally {
        setBootstrapped(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const nextConfig = await api("/api/config");
        setConfig(nextConfig);
        const nextDocs = await refresh();
        if (nextDocs[0]) setSelectedId(nextDocs[0].documentId);
      } catch (error) {
        handleAuthFailure(error);
        setNotice({ type: "error", text: error.message });
      }
    })();
  }, [session, refresh, handleAuthFailure]);

  useEffect(() => {
    if (!session || !selectedId || busy) return;
    let cancelled = false;
    api(`/api/documents/${selectedId}`)
      .then((detail) => {
        if (cancelled) return;
        setSelected(detail);
        setVerify((current) => ({ ...current, version: String(detail.versions.length), result: null }));
      })
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
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      await refresh();
      if (successText) setNotice({ type: "success", text: typeof successText === "function" ? successText(result) : successText });
      return result;
    } catch (error) {
      handleAuthFailure(error);
      setNotice({ type: "error", text: error.message });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function signIn(username, password) {
    setBusy(true);
    setLoginError("");
    try {
      const payload = await api("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      setDemoAccounts(payload.demoAccounts || []);
      setSession(payload.user);
    } catch (error) {
      setLoginError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await api("/api/logout", { method: "POST" }).catch(() => undefined);
    setSession(null);
    setSelected(null);
    setSelectedId("");
    setDocuments([]);
    setCases([]);
    setActivity([]);
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
      link.href = url;
      link.download = match?.[1] || "evidence.bin";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  }

  const filteredDocuments = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return documents.filter((item) => {
      if (caseFilter && item.caseId !== caseFilter) return false;
      if (!needle) return true;
      return [item.title, item.caseReference, item.documentReference, item.documentId].join(" ").toLowerCase().includes(needle);
    });
  }, [documents, query, caseFilter]);

  const metadata = selected?.files?.find((file) => file.version === selected?.versions?.length);
  const participantName = (address) => {
    const participant = config?.actors.find((item) => item.address.toLowerCase() === address?.toLowerCase());
    return participant?.label || "Authorized participant";
  };
  const isCurrentCustodian = Boolean(
    selected && activeActor && selected.currentCustodian?.toLowerCase() === activeActor.address?.toLowerCase()
  );
  const caseAllowsDocumentChanges = ["OPEN", "UNDER_TRIAL"].includes(selected?.caseStatus);
  const canModifyDocument = Boolean(isCurrentCustodian && !selected?.sealed && caseAllowsDocumentChanges);
  const canManageAccess = Boolean(isCurrentCustodian || actor === "administrator" || actor === "courtClerk");
  const accessTarget = config?.actors.find((item) => item.key === access);
  const accessTargetIsCustodian = Boolean(
    accessTarget && selected?.currentCustodian?.toLowerCase() === accessTarget.address.toLowerCase()
  );

  if (!bootstrapped) return <main className="login-shell"><p className="quiet">Connecting to NyayaVault…</p></main>;
  if (!session) return <LoginScreen accounts={demoAccounts} error={loginError} onSubmit={signIn} busy={busy} />;

  return <main className="shell">
    {busy && <div className="busy-bar" aria-hidden="true" />}
    <header className="topbar">
      <div className="brand"><div className="brand-mark">N</div><div><strong>NyayaVault</strong><span>Secure legal document workspace</span></div></div>
      <div className="network"><span className="network-dot" /> Local blockchain <span>{config ? "Secure connection" : "Connecting…"}</span></div>
      <div className="session-chip">
        <span>Signed in</span>
        <strong>{session.label}</strong>
        <button type="button" className="text-button" onClick={signOut}>Sign out</button>
      </div>
    </header>

    <section className="hero">
      <div>
        <p className="eyebrow">SECURE DIGITAL DOCUMENT MANAGEMENT</p>
        <h1>Centralised records with a<br /><em>verifiable history.</em></h1>
        <p className="hero-copy">Digitise FIRs, witness statements, forensic reports, charge sheets, and court orders. Files stay off-chain while their integrity, versions, custody, access grants, and judicial seals are securely recorded.</p>
      </div>
      <div className="hero-trust"><span>CHAIN OF CUSTODY</span><strong>Authenticated<br />audit trail</strong><div><Pill tone="green">Session</Pill><Pill>SHA-256</Pill><Pill tone="blue">RBAC</Pill></div></div>
    </section>

    {notice && <div className={`notice ${notice.type}`}><span>{notice.type === "success" ? "✓" : "!"}</span>{notice.text}<button onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}

    <section className="stats">
      <article><span>ACTIVE CASES</span><strong>{cases.filter((item) => item.status === "OPEN" || item.status === "UNDER_TRIAL").length}</strong><small>{cases.length} indexed locally</small></article>
      <article><span>ACCESSIBLE DOCUMENTS</span><strong>{documents.length}</strong><small>{activeActor?.label || "Participant"} view</small></article>
      <article><span>AUDIT EVENTS</span><strong>{activity.length}</strong><small>Latest 60 actions</small></article>
      <article className="actor-card"><span>AUTHENTICATED ROLE</span><strong>{activeActor?.role || "—"}</strong><small>Verified signed-in identity</small></article>
    </section>

    <section className="workspace">
      <aside className="control-panel">
        <div className="panel-heading"><p className="eyebrow">CASE DESK</p><h2>Create &amp; control</h2></div>
        <form onSubmit={(event) => { event.preventDefault(); run(async () => {
          await api("/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(caseForm) });
          setCaseForm({ reference: "", title: "" });
        }, "Case opened and recorded on-chain."); }}>
          <label>Case reference<input required placeholder="FIR-2026-0042" value={caseForm.reference} onChange={(event) => setCaseForm({ ...caseForm, reference: event.target.value })} /></label>
          <label>Case title<input required placeholder="State v. Example" value={caseForm.title} onChange={(event) => setCaseForm({ ...caseForm, title: event.target.value })} /></label>
          <button className="primary" disabled={busy || !caps.openCase}>{caps.openCase ? <>Open case <span>→</span></> : "Officer / court / admin only"}</button>
        </form>
        <div className="divider" />
        <form onSubmit={(event) => { event.preventDefault(); run(async () => api(`/api/cases/${caseStatus.caseId}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: Number(caseStatus.status) }) }), "Case status written to the contract."); }}>
          <p className="form-title">Case lifecycle</p>
          <label>Case<select required value={caseStatus.caseId} onChange={(event) => setCaseStatus({ ...caseStatus, caseId: event.target.value })}><option value="">Select a case</option>{cases.map((item) => <option key={item.caseId} value={item.caseId}>{item.reference} · {item.status}</option>)}</select></label>
          <label>New status<select value={caseStatus.status} onChange={(event) => setCaseStatus({ ...caseStatus, status: event.target.value })}>{config?.caseStatuses.map((item, index) => <option key={item} value={index}>{item.replaceAll("_", " ")}</option>)}</select></label>
          <button className="secondary" disabled={busy || !caps.changeStatus}>{caps.changeStatus ? "Update status" : "Court / admin only"}</button>
        </form>
      </aside>

      <section className="documents-panel">
        <div className="section-heading"><div><p className="eyebrow">REGISTRY</p><h2>Document ledger</h2></div><span className="muted">Hashes only are stored on-chain</span></div>
        <div className="ledger-tools">
          <input placeholder="Search title, case number, or document reference" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select value={caseFilter} onChange={(event) => setCaseFilter(event.target.value)}>
            <option value="">All cases</option>
            {cases.map((item) => <option key={item.caseId} value={item.caseId}>{item.reference}</option>)}
          </select>
        </div>
        {filteredDocuments.length ? <div className="document-list">{filteredDocuments.map((item) => <button key={item.documentId} onClick={() => setSelectedId(item.documentId)} className={`document-row ${selectedId === item.documentId ? "selected" : ""}`}>
          <div className="doc-icon">{item.title.slice(0, 1).toUpperCase()}</div><div className="doc-main"><strong>{item.title}</strong><span>{item.caseReference} · {item.documentReference}</span></div><Pill tone="blue">{item.createdBy === actor ? "CREATED" : "GRANTED"}</Pill><span className="hash">Integrity recorded</span><span className="chevron">›</span>
        </button>)}</div> : <div className="empty"><div>⌁</div><strong>No matching documents</strong><p>Open a case, then register its first record, or clear the search filters.</p></div>}
      </section>
    </section>

    <section className="intake-section">
      <div><p className="eyebrow">DOCUMENT INTAKE</p><h2>Register an evidence file</h2><p>An integrity record and file details become version 1 on the blockchain. The file itself stays securely in this local prototype.</p></div>
      <form className="intake-form" onSubmit={(event) => { event.preventDefault(); run(async () => {
        const body = new FormData();
        Object.entries(documentForm).forEach(([key, value]) => { if (value !== null) body.append(key, value); });
        const created = await api("/api/documents", { method: "POST", body });
        setDocumentForm({ caseReference: "", documentReference: "", title: "", docType: "0", file: null });
        if (intakeFileRef.current) intakeFileRef.current.value = "";
        setSelectedId(created.documentId);
      }, "Document registered. Integrity is now anchored on-chain."); }}>
        <label>Case<select required value={documentForm.caseReference} onChange={(event) => setDocumentForm({ ...documentForm, caseReference: event.target.value })}><option value="">Choose an active case</option>{cases.filter((item) => item.status === "OPEN" || item.status === "UNDER_TRIAL").map((item) => <option key={item.caseId} value={item.reference}>{item.reference} — {item.title} · {item.status.replaceAll("_", " ")}</option>)}</select></label>
        <label>Document reference<input required placeholder="EVD-001" value={documentForm.documentReference} onChange={(event) => setDocumentForm({ ...documentForm, documentReference: event.target.value })} /></label>
        <label>Document title<input required placeholder="Initial incident report" value={documentForm.title} onChange={(event) => setDocumentForm({ ...documentForm, title: event.target.value })} /></label>
        <label>Document type<select value={documentForm.docType} onChange={(event) => setDocumentForm({ ...documentForm, docType: event.target.value })}>{config?.documentTypes.map((item, index) => <option key={item} value={index}>{typeLabels[item]}</option>)}</select></label>
        <label className="file-label">Evidence file<input ref={intakeFileRef} required type="file" onChange={(event) => setDocumentForm({ ...documentForm, file: event.target.files?.[0] || null })} /><span>{documentForm.file ? documentForm.file.name : "Choose a file · max 15 MB"}</span></label>
        <button className="primary intake-button" disabled={busy || !caps.register}>{caps.register ? <>Hash &amp; register <span>→</span></> : "Officer / admin only"}</button>
      </form>
    </section>

    <section className="detail-section">
      <div className="section-heading"><div><p className="eyebrow">DOCUMENT WORKBENCH</p><h2>{selected?.title || "Select a document"}</h2></div>{selected && <div className="detail-badges"><Pill tone={selected.sealed ? "red" : "green"}>{selected.sealed ? "SEALED / IMMUTABLE" : selected.caseStatus}</Pill><Pill tone="blue">{selected.docType.replaceAll("_", " ")}</Pill></div>}</div>
      {!selected ? <div className="empty detail-empty"><div>▣</div><strong>Choose a document from the ledger</strong><p>Blockchain state, audit history, and permitted actions appear here.</p></div> : <>
        <div className="integrity-strip"><div><span>CASE REFERENCE</span><strong>{selected.caseReference}</strong></div><div><span>DOCUMENT REFERENCE</span><strong>{selected.documentReference}</strong></div><div><span>CURRENT CUSTODIAN</span><strong>{participantName(selected.currentCustodian)}</strong></div><div><span>INTEGRITY STATUS</span><strong>Recorded · Version {selected.versions.length}</strong></div><button type="button" className="download" onClick={() => downloadDocument(selected.documentId)}>Download latest ↗</button></div>
        <div className="detail-grid">
          <article className="timeline-card"><h3>Version history</h3>{selected.versions.map((version) => <div className="timeline" key={version.version}><span className="timeline-dot" /><div><strong>Version {version.version}</strong><p>Integrity record secured on blockchain</p><small>{formatDate(version.timestamp)} by {participantName(version.createdBy)}</small></div><button type="button" className="text-button" onClick={() => downloadDocument(selected.documentId, version.version)}>file ↗</button></div>)}</article>
          <article className="timeline-card"><h3>Chain of custody</h3>{selected.custody.length ? selected.custody.map((event, index) => <div className="timeline" key={`${event.timestamp}-${index}`}><span className="timeline-dot amber" /><div><strong>{event.action}</strong><p>{participantName(event.from)} → {participantName(event.to)}</p><small>{formatDate(event.timestamp)}</small></div></div>) : <p className="quiet">No transfers recorded. The registering officer remains the custodian.</p>}</article>
          <article className="timeline-card"><h3>Local file record</h3><p className="quiet">{metadata?.originalName || "No local file metadata"}</p><p className="quiet">Stored locally; its integrity record is protected on the blockchain.</p></article>
        </div>
        <div className="actions-grid">
          <form className="action-card" onSubmit={(event) => { event.preventDefault(); if (!canModifyDocument) return; run(async () => { const body = new FormData(); body.append("file", versionFile); await api(`/api/documents/${selected.documentId}/versions`, { method: "POST", body }); setVersionFile(null); if (versionFileRef.current) versionFileRef.current.value = ""; }, "New document version anchored on-chain."); }}><h3>Add version</h3><p>Only the current custodian can replace a mutable document.</p><input ref={versionFileRef} required disabled={!canModifyDocument} type="file" onChange={(event) => setVersionFile(event.target.files?.[0] || null)} /><button className="secondary" disabled={busy || !canModifyDocument}>{isCurrentCustodian ? "Create next version" : "Custodian only"}</button></form>
          <form className="action-card" onSubmit={(event) => { event.preventDefault(); if (!canModifyDocument) return; run(async () => api(`/api/documents/${selected.documentId}/custody`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(transfer) }), "Custody transfer recorded on-chain."); }}><h3>Transfer custody</h3><p>Current custodian signs the handoff and reason.</p><select disabled={!canModifyDocument} value={transfer.toActor} onChange={(event) => setTransfer({ ...transfer, toActor: event.target.value })}>{config?.actors.filter((item) => item.key !== actor).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select><input required disabled={!canModifyDocument} value={transfer.action} onChange={(event) => setTransfer({ ...transfer, action: event.target.value })} /><button className="secondary" disabled={busy || !canModifyDocument}>{isCurrentCustodian ? "Record transfer" : "Custodian only"}</button></form>
          <form className="action-card" onSubmit={(event) => { event.preventDefault(); if (!canManageAccess) return; run(async () => api(`/api/documents/${selected.documentId}/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ granteeActor: access, grant: true }) }), "Access permission updated on-chain."); }}><h3>Grant read access</h3><p>Custodian, court, or administrator can permit another participant.</p><select disabled={!canManageAccess} value={access} onChange={(event) => setAccess(event.target.value)}>{config?.actors.filter((item) => item.key !== actor).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select><button className="secondary" disabled={busy || !canManageAccess}>{canManageAccess ? "Grant access" : "No grant authority"}</button><button type="button" className="text-button" disabled={busy || !canManageAccess || accessTargetIsCustodian} onClick={() => run(async () => api(`/api/documents/${selected.documentId}/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ granteeActor: access, grant: false }) }), "Access revoked on-chain.")}>{accessTargetIsCustodian ? "Custodian access cannot be revoked" : "Revoke selected access"}</button></form>
          <form className="action-card verify-card" onSubmit={(event) => { event.preventDefault(); run(async () => { const body = new FormData(); body.append("file", verify.file); body.append("version", verify.version); const result = await api(`/api/documents/${selected.documentId}/verify`, { method: "POST", body }); setVerify({ ...verify, result }); return result; }, (result) => result?.verified ? "File matches the protected record." : "File does not match this version."); }}><h3>Verify integrity</h3><p>Compare a local file with the protected record for this version.</p><select value={verify.version} onChange={(event) => setVerify({ ...verify, version: event.target.value, result: null })}>{selected.versions.map((item) => <option key={item.version} value={item.version}>Version {item.version}</option>)}</select><input ref={verifyFileRef} required type="file" onChange={(event) => setVerify({ ...verify, file: event.target.files?.[0] || null, result: null })} /><button className="primary" disabled={busy}>Verify file</button>{verify.result && <div className={`verify-result ${verify.result.verified ? "match" : "mismatch"}`}>{verify.result.verified ? "✓ File matches the protected record" : "× File does not match this version"}</div>}</form>
          <div className="action-card seal-card"><h3>Judicial seal</h3><p>Only the court role can permanently freeze versions and custody transfers.</p><button className="danger" disabled={busy || selected.sealed || !caps.seal} onClick={() => run(async () => api(`/api/documents/${selected.documentId}/seal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }), "Document sealed permanently on-chain.")}>{selected.sealed ? "Already sealed" : caps.seal ? "Seal document permanently" : "Sign in as Court Clerk"}</button><small>Sign out and authenticate as Court Clerk to perform this action.</small></div>
        </div>
      </>}
    </section>

    <section className="activity-section"><div className="section-heading"><div><p className="eyebrow">AUDIT LOG</p><h2>Recent recorded activity</h2></div></div>{activity.length ? <div className="audit-list">{activity.slice(0, 8).map((item) => <div className="audit-row" key={item.id}><span className="audit-icon">{item.type.includes("SEALED") ? "◆" : item.type.includes("ACCESS") ? "⌘" : "↗"}</span><div><strong>{item.description}</strong><small>{item.actor} · {formatDate(item.at)}</small></div><span className="audit-status">On-chain record</span></div>)}</div> : <p className="quiet">Authenticated actions recorded through this local MVP appear here.</p>}</section>
    <footer>NyayaVault prototype · Local demo with session authentication · Do not use embedded keys for production evidence.</footer>
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
