"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GuardRequest, GuardianSnapshot, NewRequestInput } from "@/lib/types";
import { useNearWallet } from "@/app/wallet-provider";

type Toast = { tone: "success" | "error"; message: string };

const scenarios: { title: string; caption: string; input: NewRequestInput }[] = [
  { title: "Normal payment", caption: "Known vendor · 0.25 NEAR", input: { kind: "transfer", recipient: "vendor.testnet", amount: "0.25" } },
  { title: "Large transfer", caption: "82 NEAR · above your cap", input: { kind: "transfer", recipient: "friend.testnet", amount: "82" } },
  { title: "New recipient", caption: "First payment · 0.4 NEAR", input: { kind: "transfer", recipient: "new-recipient.testnet", amount: "0.4" } },
  { title: "Key change", caption: "New access key request", input: { kind: "add_key", recipient: "New full access key" } },
];

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function shortId(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function validTestnetAccount(value: string) {
  return /^[a-z0-9._-]{2,64}$/.test(value) && value.endsWith(".testnet");
}

function kindLabel(request: GuardRequest) {
  if (request.kind === "add_key") return "Add access key";
  if (request.kind === "delete_key") return "Remove access key";
  return "NEAR transfer";
}

function StateIcon({ state }: { state: GuardRequest["status"] }) {
  if (state === "pending") return <span className="status-dot status-dot--amber" />;
  if (state === "processing") return <span className="status-dot status-dot--blue" />;
  if (state === "sent") return <span className="status-dot status-dot--green" />;
  return <span className="status-dot status-dot--red" />;
}

export default function Home() {
  const ownerWallet = useNearWallet();
  const [snapshot, setSnapshot] = useState<GuardianSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [activeView, setActiveView] = useState<"overview" | "activity" | "rules">("overview");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [transferRecipient, setTransferRecipient] = useState("");
  const [transferAmount, setTransferAmount] = useState("");

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("lodestar-theme");
    if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme);
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load Guardian data.");
    setSnapshot(await response.json() as GuardianSnapshot);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setToast({ tone: "error", message: "Guardian data could not be loaded." }))
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const pending = useMemo(() => snapshot?.requests.filter((request) => request.status === "pending") ?? [], [snapshot]);
  const totals = useMemo(() => ({
    held: snapshot?.requests.filter((request) => request.status === "pending").length ?? 0,
    passed: snapshot?.requests.filter((request) => request.status === "sent").length ?? 0,
    denied: snapshot?.requests.filter((request) => request.status === "denied").length ?? 0,
  }), [snapshot]);

  useEffect(() => {
    if (snapshot?.mode !== "testnet" || !snapshot.requests.some((request) => request.status === "processing")) return;
    const timer = window.setInterval(() => { void refresh(); }, 4500);
    return () => window.clearInterval(timer);
  }, [snapshot, refresh]);

  async function submit(input: NewRequestInput) {
    try {
      if (snapshot?.mode === "testnet" && snapshot.setupError) throw new Error(snapshot.setupError);
      if (snapshot?.mode === "testnet") {
        if (input.kind !== "transfer") throw new Error("The on-chain policy contract currently supports NEAR transfers only.");
        if (!snapshot.callbackReady) throw new Error("The deployed policy contract needs the callback-enabled V2.1 upgrade before transfers can be submitted safely.");
        if (!ownerWallet.accountId) throw new Error("Connect the contract owner’s Meteor Wallet first.");
        if (ownerWallet.accountId !== snapshot.ownerAccountId) throw new Error(`Connect ${snapshot.ownerAccountId} to submit contract requests.`);
        if (!validTestnetAccount(input.recipient)) throw new Error("Enter a valid NEAR testnet recipient account.");
        const [whole, fraction = ""] = (input.amount ?? "").split(".");
        if (!/^\d+$/.test(whole) || fraction.length > 24 || !/^\d*$/.test(fraction)) throw new Error("Enter a valid NEAR amount.");
        const yoctoValue = BigInt(whole) * (BigInt("10") ** BigInt("24")) + BigInt(fraction.padEnd(24, "0") || "0");
        if (yoctoValue <= BigInt("0")) throw new Error("Transfer amount must be greater than zero.");
        const yoctoAmount = yoctoValue.toString();
        await ownerWallet.callContract(snapshot.accountId, "request_transfer", { recipient: input.recipient, amount: yoctoAmount });
        await refresh();
        setToast({ tone: "success", message: "Request recorded by the NEAR policy contract. Any transfer is awaiting its on-chain result." });
        return;
      }
      const response = await fetch("/api/requests", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Request could not be processed.");
      await refresh();
      setToast({ tone: "success", message: payload.status === "pending" ? "Unusual activity held for review." : "Rules passed. Preview transaction recorded locally." });
    } catch (error) {
      setToast({ tone: "error", message: error instanceof Error ? error.message : "Something went wrong." });
    }
  }

  async function decide(id: string, decision: "approve" | "deny") {
    setBusyId(id);
    try {
      if (snapshot?.mode === "testnet") {
        if (snapshot.setupError) throw new Error(snapshot.setupError);
        if (!snapshot.callbackReady) throw new Error("The deployed policy contract needs the callback-enabled V2.1 upgrade before approvals can be submitted safely.");
        if (!ownerWallet.accountId) throw new Error("Connect the contract owner’s Meteor Wallet first.");
        if (ownerWallet.accountId !== snapshot.ownerAccountId) throw new Error(`Only ${snapshot.ownerAccountId} can decide this request.`);
        await ownerWallet.callContract(snapshot.accountId, decision === "approve" ? "approve_request" : "deny_request", { request_id: Number(id) });
        await refresh();
        setToast({ tone: "success", message: decision === "approve" ? "Approval submitted on-chain. The request will update after NEAR confirms the transfer." : "Denial recorded by the NEAR policy contract." });
        return;
      }
      const response = await fetch(`/api/requests/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Decision could not be saved.");
      await refresh();
      setToast({ tone: "success", message: decision === "approve" ? "Approved in local preview. No on-chain transaction was sent." : "Request denied in local preview." });
    } catch (error) {
      setToast({ tone: "error", message: error instanceof Error ? error.message : "Something went wrong." });
    } finally {
      setBusyId(null);
    }
  }

  async function runBurst() {
    if (snapshot?.mode === "testnet") {
      setToast({ tone: "error", message: "The burst simulator is mock-only. Submit individual owner-authorized testnet requests instead." });
      return;
    }
    for (let index = 0; index < 4; index += 1) {
      const response = await fetch("/api/requests", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "transfer", recipient: "vendor.testnet", amount: "0.15" }),
      });
      if (!response.ok) {
        const payload = await response.json();
        setToast({ tone: "error", message: payload.error ?? "Burst scenario failed." });
        return;
      }
    }
    await refresh();
    setToast({ tone: "success", message: "Four rapid transfers simulated. The request over the velocity limit is held." });
  }

  return (
    <main className={`shell ${theme === "dark" ? "theme-dark" : ""} ${sidebarOpen ? "" : "shell--sidebar-hidden"}`}>
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="LODESTAR home" data-tooltip="LODESTAR" title="LODESTAR">
          <span className="brand-mark"><ShieldGlyph /></span>
          <span className="brand-copy"><strong>LODESTAR</strong><small>WALLET SECURITY</small></span>
        </a>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="nav-list" aria-label="Main navigation">
          <button className={`nav-item ${activeView === "overview" ? "nav-item--active" : ""}`} data-tooltip="Overview" title="Overview" onClick={() => setActiveView("overview")}><GridGlyph />Overview</button>
          <button className={`nav-item ${activeView === "activity" ? "nav-item--active" : ""}`} data-tooltip="Activity" title="Activity" onClick={() => setActiveView("activity")}><ActivityGlyph />Activity<span className="nav-count">{pending.length || ""}</span></button>
          <button className={`nav-item ${activeView === "rules" ? "nav-item--active" : ""}`} data-tooltip="Protection rules" title="Protection rules" onClick={() => setActiveView("rules")}><SlidersGlyph />Protection rules</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="support-card">
            <span className="support-icon"><SparkGlyph /></span>
            <strong>Built to pause<br />before it moves.</strong>
            <p>Your guardian checks every request against your rules.</p>
          </div>
          <div className="profile-row"><span className="avatar">{ownerWallet.accountId?.slice(0, 1).toUpperCase() ?? "G"}</span><span><strong>{ownerWallet.accountId ?? "Guardian workspace"}</strong><small>{snapshot?.mode === "testnet" ? "NEAR Testnet owner" : "Local preview"}</small></span><span className="more">···</span></div>
        </div>
      </aside>

      <section className="main-panel" id="top">
        <header className="topbar">
          <button className="menu-toggle" type="button" aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"} aria-expanded={sidebarOpen} title={sidebarOpen ? "Hide sidebar" : "Show sidebar"} onClick={() => setSidebarOpen((open) => !open)}><MenuGlyph /></button>
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{activeView === "overview" ? "Overview" : activeView === "activity" ? "Activity" : "Protection rules"}</strong></div>
          <div className="topbar-right"><button className="theme-toggle" type="button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={() => setTheme((current) => { const next = current === "dark" ? "light" : "dark"; window.localStorage.setItem("lodestar-theme", next); return next; })}><ThemeGlyph dark={theme === "dark"} /></button><span className="mode-pill"><span className="mode-light" />{snapshot?.mode === "testnet" ? "NEAR TESTNET · ON-CHAIN" : "LOCAL PREVIEW"}</span><button className="avatar avatar--small" aria-label="Account profile">{ownerWallet.accountId?.slice(0, 1).toUpperCase() ?? "D"}</button></div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div><div className="eyebrow"><span className="eyebrow-line" />{snapshot?.mode === "testnet" ? "V2 POLICY CONSOLE · NEAR TESTNET" : "LOCAL PREVIEW · NO CHAIN ACTIVITY"}</div><h1>{activeView === "overview" ? "Treasury protection." : activeView === "activity" ? "On-chain activity." : "Policy controls."}</h1><p className="page-subtitle">{activeView === "overview" ? "Review policy decisions and transfers secured by the NEAR contract." : activeView === "activity" ? "A live record of requests and outcomes read from the policy contract." : "Manage the contract’s amount threshold and trusted recipients."}</p></div>
            <button className="connect-button" onClick={ownerWallet.connect} disabled={!ownerWallet.ready} title="Connect the deployed contract owner account"><span className="connect-dot" />{ownerWallet.accountId ?? (ownerWallet.ready ? "Connect owner wallet" : "Loading wallet…")}<ChevronDown /></button>
          </div>

          {snapshot?.mode === "testnet" && <div className={`live-notice ${snapshot.setupError || !snapshot.callbackReady ? "live-notice--error" : ""}`}><strong>Policy contract · {snapshot.accountId}</strong><span>Owner: {snapshot.ownerAccountId} · Guardian agent: {snapshot.guardianAccountId}</span>{snapshot.contractGuardianId !== snapshot.guardianAccountId && <div className="guardian-config"><span>Contract currently authorizes <b>{snapshot.contractGuardianId}</b>. Update it to the restricted agent account before enabling agent requests.</span><button onClick={() => void ownerWallet.callContract(snapshot.accountId, "set_guardian", { guardian_id: snapshot.guardianAccountId! }).then(() => refresh()).catch((error) => setToast({ tone: "error", message: error instanceof Error ? error.message : "Could not update contract Guardian." }))} disabled={ownerWallet.accountId !== snapshot.ownerAccountId}>Authorize Guardian account</button></div>}{!snapshot.callbackReady && <span>Contract upgrade required: transfer outcomes must be finalized by the V2.1 callback. Requests and approvals are disabled until the upgraded contract is deployed.</span>}{snapshot.setupError && <span>{snapshot.setupError}</span>}</div>}

          {activeView === "overview" && <>
            <section className="hero-card">
              <div className="hero-pattern" aria-hidden="true" />
              <div className="hero-copy"><span className="hero-kicker"><span className="pulse-dot" />{snapshot?.mode === "testnet" ? "POLICY CONTRACT CONNECTED" : "LOCAL PREVIEW"}</span><h2>Policy enforced<br /><em>on NEAR.</em></h2><p>{snapshot?.mode === "testnet" ? "The contract evaluates every transfer. Held requests stay on-chain until the owner decides." : "Preview the policy experience without sending transactions."}</p><button className="hero-action" onClick={() => setActiveView("activity")}>View on-chain activity <ArrowRight /></button></div>
              <div className="hero-illustration" aria-hidden="true"><span className="orbit orbit--one" /><span className="orbit orbit--two" /><span className="orbit orbit--three" /><span className="guardian-orb"><ShieldGlyph /></span><span className="orb-chip orb-chip--one"><CheckGlyph /></span><span className="orb-chip orb-chip--two"><LockGlyph /></span></div>
              <div className="hero-foot"><span>POLICY CONTRACT</span><strong>{snapshot?.accountId ?? "—"}</strong><span className="hero-foot-right">NETWORK <strong>{snapshot?.mode === "testnet" ? "NEAR Testnet" : "Local"}</strong></span></div>
            </section>

            <div className="stat-grid">
              <article className="stat-card stat-card--treasury"><div className="stat-top"><span>{snapshot?.mode === "testnet" ? "CONTRACT TREASURY" : "LOCAL PREVIEW BALANCE"}</span><span className="stat-icon stat-icon--lavender"><CoinGlyph /></span></div><div className="stat-number">{snapshot ? snapshot.balance : "—"}<span> NEAR</span></div><div className="stat-foot"><span className="mini-dot mini-dot--lavender" />{snapshot?.mode === "testnet" ? "Funds held by policy contract" : "Preview only · no real funds"}</div><MiniChart variant="treasury" /></article>
              <article className="stat-card stat-card--held"><div className="stat-top"><span>HELD FOR REVIEW</span><span className="stat-icon stat-icon--amber"><PauseGlyph /></span></div><div className="stat-number">{totals.held}<span> requests</span></div><div className="stat-foot"><span className="mini-dot mini-dot--amber" />Waiting for your decision</div><MiniChart variant="held" /></article>
              <article className="stat-card stat-card--submitted"><div className="stat-top"><span>{snapshot?.mode === "testnet" ? "SUBMITTED" : "MOCK PASSED"}</span><span className="stat-icon stat-icon--green"><CheckGlyph /></span></div><div className="stat-number">{totals.passed}<span> requests</span></div><div className="stat-foot"><span className="mini-dot mini-dot--green" />{snapshot?.mode === "testnet" ? "Confirmed on NEAR testnet" : "No rules were triggered"}</div><MiniChart variant="submitted" /></article>
            </div>

            <div className="section-head"><div><h2>Needs your attention <span className="section-count">{pending.length}</span></h2><p>These requests are waiting for your approval.</p></div><button className="text-button" onClick={() => setActiveView("activity")}>View all activity <ArrowRight /></button></div>
            <div className="request-list">
              {loading ? <div className="empty-state">Loading policy contract…</div> : pending.length ? pending.slice(0, 3).map((request) => <RequestCard key={request.id} request={request} busy={busyId === request.id} live={snapshot?.mode === "testnet"} locked={snapshot?.mode === "testnet" && !snapshot.callbackReady} onDecision={decide} />) : <div className="empty-state empty-state--clear"><span className="clear-check"><CheckGlyph /></span><strong>Nothing waiting on you</strong><span>New contract requests will appear here.</span></div>}
            </div>
            <div className="section-head scenarios-head"><div><h2>{snapshot?.mode === "testnet" ? "Create a protected transfer" : "Local preview"}</h2><p>{snapshot?.mode === "testnet" ? "Your connected owner wallet calls the policy contract. Funds are paid from the contract balance." : "Use the sample cases to explore the interface. Preview data is stored locally."}</p></div>{snapshot?.mode !== "testnet" && <button className="burst-button" onClick={() => void runBurst()}><BurstGlyph />Simulate transfer burst</button>}</div>
            {snapshot?.mode === "testnet" ? <form className="testnet-form" onSubmit={(event) => { event.preventDefault(); void submit({ kind: "transfer", recipient: transferRecipient.trim(), amount: transferAmount.trim() }); }}>
              <label>Recipient account<input value={transferRecipient} onChange={(event) => setTransferRecipient(event.target.value)} placeholder="recipient.testnet" autoComplete="off" required /></label>
              <label>Amount in NEAR<input value={transferAmount} onChange={(event) => setTransferAmount(event.target.value)} placeholder="0.25" inputMode="decimal" required /></label>
              <button className="testnet-review" type="submit" disabled={!ownerWallet.accountId || ownerWallet.accountId !== snapshot.ownerAccountId || Boolean(snapshot.setupError) || !snapshot.callbackReady}>Review in Meteor Wallet</button>
            </form> : <div className="scenario-grid">{scenarios.map((scenario) => <button className="scenario-card" key={scenario.title} onClick={() => void submit(scenario.input)}><span className="scenario-arrow"><ArrowUpRight /></span><strong>{scenario.title}</strong><small>{scenario.caption}</small></button>)}</div>}
          </>}

          {activeView === "activity" && <ActivityView snapshot={snapshot} loading={loading} busyId={busyId} onDecision={decide} />}
          {activeView === "rules" && <RulesView snapshot={snapshot} live={snapshot?.mode === "testnet"} ownerReady={ownerWallet.accountId === snapshot?.ownerAccountId} onAllowlist={async (method, accountId) => {
            if (!snapshot) return;
            await ownerWallet.callContract(snapshot.accountId, method, { account_id: accountId });
            await refresh();
          }} />}

          <footer className="footer"><span><span className="footer-lock"><LockGlyph /></span>{snapshot?.mode === "testnet" ? "Policy and request state read from NEAR" : "Local preview · no chain activity"}</span><span>{snapshot?.mode === "testnet" ? "OWNER ACTIONS REQUIRE METEOR WALLET" : "DEMO DATA IS LOCAL ONLY"}</span></footer>
        </div>
      </section>
      {toast && <div className={`toast toast--${toast.tone}`} role="status"><span>{toast.tone === "success" ? "✓" : "!"}</span>{toast.message}</div>}
    </main>
  );
}

function RequestCard({ request, busy, live, locked, onDecision }: { request: GuardRequest; busy: boolean; live: boolean; locked: boolean; onDecision: (id: string, decision: "approve" | "deny") => void }) {
  return <article className="request-card">
    <div className="request-main"><div className="request-avatar"><ShieldGlyph /></div><div className="request-details"><div className="request-title"><strong>{kindLabel(request)}</strong><span className="pending-badge"><span className="mini-dot mini-dot--amber" />ON HOLD</span></div><div className="request-recipient">{request.kind === "transfer" ? `To ${request.recipient}` : request.recipient} <span>·</span> {formatTime(request.createdAt)}</div><div className="request-reason">{request.reason}</div></div></div>
    <div className="request-side">{request.amount && <div className="request-amount">{request.amount}<span> NEAR</span></div>}<div className="request-actions"><button className="deny-button" onClick={() => onDecision(request.id, "deny")} disabled={busy || locked}>{busy ? "Working…" : "Deny"}</button><button className="approve-button" onClick={() => onDecision(request.id, "approve")} disabled={busy || locked}>{busy ? "Submitting…" : locked ? "Contract upgrade required" : live ? "Approve & submit" : "Approve"}</button></div></div>
  </article>;
}

function ActivityView({ snapshot, loading, busyId, onDecision }: { snapshot: GuardianSnapshot | null; loading: boolean; busyId: string | null; onDecision: (id: string, decision: "approve" | "deny") => void }) {
  const live = snapshot?.mode === "testnet";
  const locked = live && !snapshot?.callbackReady;
  return <section className="content-panel"><div className="panel-heading"><div><h2>Transaction requests</h2><p>{live ? "Only Guardian-signed testnet submissions move funds; every owner decision is audited." : "Mock decisions are recorded locally. They are not submitted to NEAR."}</p></div><span className="panel-count">{snapshot?.requests.length ?? 0} RECORDS</span></div>
    {loading ? <div className="empty-state">Loading activity…</div> : <div className="activity-table"><div className="table-head"><span>REQUEST</span><span>REASON</span><span>STATUS</span><span>TIME</span></div>{snapshot?.requests.map((request) => <div className="table-row" key={request.id}><div className="table-request"><span className="table-request-icon"><StateIcon state={request.status} /></span><span><strong>{kindLabel(request)}</strong><small>{request.recipient}{request.amount ? ` · ${request.amount} NEAR` : ""}{request.transactionHash && <span className="tx-hash">Tx {shortId(request.transactionHash)}</span>}</small></span></div><span className="table-reason">{request.reason ?? "No guard rule triggered"}</span><span className={`table-status table-status--${request.status}`}><StateIcon state={request.status} />{request.status === "sent" ? live ? "Confirmed · testnet" : "Passed · preview" : request.status}</span><span className="table-time">{formatTime(request.createdAt)}<small>Request #{request.id}</small></span>{request.status === "pending" && <div className="table-actions"><button onClick={() => onDecision(request.id, "deny")} disabled={busyId === request.id || locked}>Deny</button><button onClick={() => onDecision(request.id, "approve")} disabled={busyId === request.id || locked}>{locked ? "Upgrade required" : live ? "Approve & submit" : "Approve"}</button></div>}</div>)}</div>}
    <div className="audit-heading"><div><h2>Audit trail</h2><p>Every Guardian decision is logged.</p></div></div><div className="audit-list">{snapshot?.audit.map((event) => <div className="audit-row" key={event.id}><span className={`audit-icon audit-icon--${event.action.includes("denied") ? "red" : event.action.includes("held") ? "amber" : "green"}`}><StateIcon state={event.action.includes("denied") ? "denied" : event.action.includes("held") ? "pending" : "sent"} /></span><span><strong>{event.action.replaceAll("_", " ")}</strong><small>{event.detail}</small></span><time>{formatTime(event.createdAt)}</time></div>)}</div>
  </section>;
}

function RulesView({ snapshot, live, ownerReady, onAllowlist }: {
  snapshot: GuardianSnapshot | null;
  live: boolean;
  ownerReady: boolean;
  onAllowlist: (method: "add_allowlist" | "remove_allowlist", accountId: string) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const rules = snapshot?.rules;
  async function changeAllowlist(method: "add_allowlist" | "remove_allowlist", value: string) {
    setBusy(true);
    setMessage("");
    try {
      if (!validTestnetAccount(value)) throw new Error("Enter a valid NEAR testnet account ID.");
      await onAllowlist(method, value);
      if (method === "add_allowlist") setAccountId("");
      setMessage(method === "add_allowlist" ? "Recipient added to the on-chain policy." : "Recipient removed from the on-chain policy.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update the on-chain allowlist.");
    } finally { setBusy(false); }
  }
  return <section className="rules-layout"><div className="rules-intro"><span className="rules-symbol"><SlidersGlyph /></span><h2>Rules that keep the wallet steady.</h2><p>Requests are evaluated in code before they can be sent. The language model never decides whether to release a payment.</p></div>
    <div className="rule-list"><RuleRow icon="↗" title="Amount cap" description={live ? "Transfers above this limit require owner approval." : "Pause a single payment above your local limit."} value={`${rules?.amountCap ?? "—"} NEAR`} /><RuleRow icon="◎" title="Trusted recipient" description="Only allowlisted accounts can pass automatically." value="Contract enforced" />{!live && <><RuleRow icon="⌁" title="Transfer burst" description="Pause when too many transfers arrive in a short window." value={`${rules?.burstLimit ?? "—"} in ${rules?.burstWindowSeconds ?? "—"} sec`} /><RuleRow icon="⌘" title="Anomaly score" description="Compare a payment against this wallet’s typical amounts." value={`Z-score > ${rules?.anomalyZScore ?? "—"}`} /><RuleRow icon="⌑" title="Access key change" description="Always pause adding or removing an account key." value="Always hold" /></>}</div>
    <div className="allowlist-card"><span className="allowlist-icon"><CheckGlyph /></span><div className="allowlist-management"><strong>{live ? "Contract allowlist" : "Preview recipients"}</strong><p>{live ? "Changes are submitted to the policy contract and require the owner wallet." : "Sample trusted recipients for the local preview."}</p><div className="recipient-chips">{rules?.allowlist.map((recipient) => <span className="recipient-chip" key={recipient}><span><span className="mini-dot mini-dot--green" />{recipient}</span>{live && <button aria-label={`Remove ${recipient}`} disabled={!ownerReady || busy} onClick={() => void changeAllowlist("remove_allowlist", recipient)}>Remove</button>}</span>)}</div>{live && <form className="allowlist-form" onSubmit={(event) => { event.preventDefault(); void changeAllowlist("add_allowlist", accountId.trim()); }}><input value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="recipient.testnet" required /><button type="submit" disabled={!ownerReady || busy}>{busy ? "Submitting…" : "Add recipient"}</button></form>}{message && <p className="allowlist-message" role="status">{message}</p>}</div></div>
    <div className="notice-box"><LockGlyph /><span><strong>{live ? "Funds are held by the policy contract." : "Preview mode."}</strong> {live ? "The contract sends from its own NEAR balance. This dashboard does not guard transfers sent directly from a personal wallet outside the contract." : "Mock changes are local and do not affect the testnet contract."}</span></div>
  </section>;
}

function RuleRow({ icon, title, description, value }: { icon: string; title: string; description: string; value: string }) {
  return <article className="rule-row"><span className="rule-icon">{icon}</span><span className="rule-copy"><strong>{title}</strong><small>{description}</small></span><span className="rule-value">{value}</span><span className="rule-toggle" aria-label="Rule enabled"><span /></span></article>;
}

function MiniChart({ variant }: { variant: "treasury" | "held" | "submitted" }) {
  if (variant === "held") return <svg className="stat-chart stat-chart--held" viewBox="0 0 320 76" preserveAspectRatio="none" aria-hidden="true"><path className="chart-baseline" d="M0 70H320" />{[[12, 43], [48, 27], [84, 48], [120, 18], [156, 35], [192, 10], [228, 42], [264, 24], [300, 33]].map(([x, y]) => <rect key={x} x={x} y={y} width="12" height={70 - y} rx="3" />)}</svg>;
  const path = variant === "treasury" ? "M0 58 C32 51 50 63 83 46 S134 42 165 33 S214 35 244 20 S285 22 320 5" : "M0 63 C38 58 53 47 85 52 S137 29 166 38 S208 32 238 18 S283 26 320 9";
  return <svg className={`stat-chart stat-chart--${variant}`} viewBox="0 0 320 76" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id={`chart-fill-${variant}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--chart-color)" stopOpacity=".48" /><stop offset="1" stopColor="var(--chart-color)" stopOpacity="0" /></linearGradient></defs><path className="chart-area" d={`${path} L320 76 L0 76Z`} /><path className="chart-line" d={path} /></svg>;
}

function MenuGlyph() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>; }
function ThemeGlyph({ dark }: { dark: boolean }) { return dark ? <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3.8" stroke="currentColor" strokeWidth="1.6"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg> : <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20.5 15.2A8.4 8.4 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>; }

function ShieldGlyph() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 19 6v5.2c0 4.1-2.8 7.8-7 9.8-4.2-2-7-5.7-7-9.8V6l7-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function GridGlyph() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.6"/><rect x="14" y="4" width="6" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.6"/><rect x="4" y="14" width="6" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.6"/><rect x="14" y="14" width="6" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.6"/></svg>; }
function ActivityGlyph() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 13h4l2.2-6 4.1 11 2.1-5H20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function SlidersGlyph() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><circle cx="15" cy="7" r="2" stroke="currentColor" strokeWidth="1.6"/><circle cx="9" cy="17" r="2" stroke="currentColor" strokeWidth="1.6"/></svg>; }
function SparkGlyph() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 1.7 6.3L20 11l-6.3 1.7L12 19l-1.7-6.3L4 11l6.3-1.7L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" fill="currentColor"/></svg>; }
function CoinGlyph() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6"/><path d="m8.4 13.2 3.5-6.1 3.7 6.1h-7.2Zm1.4 2.2h4.6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>; }
function PauseGlyph() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6"/><path d="M10 9v6m4-6v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>; }
function CheckGlyph() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.5 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function LockGlyph() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.6"/><path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><circle cx="12" cy="15" r="1" fill="currentColor"/></svg>; }
function ArrowRight() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ArrowUpRight() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ChevronDown() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 10 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function BurstGlyph() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 10-13h-7l1-7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>; }
