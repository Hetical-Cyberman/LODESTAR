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
  const [keyRequestKind, setKeyRequestKind] = useState<"add_key" | "delete_key">("add_key");
  const [keyRequest, setKeyRequest] = useState("");

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

  async function submit(input: NewRequestInput) {
    try {
      if (snapshot?.mode === "testnet" && snapshot.setupError) throw new Error(snapshot.setupError);
      let authorized: Record<string, string> = {};
      if (snapshot?.mode === "testnet" || ownerWallet.accountId) {
        if (!ownerWallet.accountId) throw new Error("Connect the configured owner’s Meteor Wallet before creating a testnet request.");
        const challengeResponse = await fetch("/api/guardian/challenges", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "create", ...input }),
        });
        const challenge = await challengeResponse.json();
        if (!challengeResponse.ok) throw new Error(challenge.error ?? "Could not prepare owner authorization.");
        const signed = await ownerWallet.signMessage(challenge.message, challenge.recipient, challenge.nonce);
        authorized = { requestId: challenge.requestId, challengeId: challenge.id, ...signed };
      }
      const response = await fetch("/api/requests", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, ...authorized }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Request could not be processed.");
      await refresh();
      setToast({ tone: "success", message: snapshot?.mode === "testnet"
        ? payload.status === "sent" ? `Guardian sent the testnet transaction${payload.transactionHash ? ` · ${payload.transactionHash.slice(0, 10)}…` : ""}.`
          : payload.status === "processing" ? `Submission status is still confirming${payload.transactionHash ? ` · tx ${payload.transactionHash.slice(0, 10)}…` : ""}. Do not retry it.`
            : "Guardian held the request for owner review; no transaction was sent."
        : payload.status === "pending" ? "Unusual activity held for review." : "Rules passed. Mock transaction recorded." });
    } catch (error) {
      setToast({ tone: "error", message: error instanceof Error ? error.message : "Something went wrong." });
    }
  }

  async function decide(id: string, decision: "approve" | "deny") {
    setBusyId(id);
    try {
      let authorization = {};
      if (snapshot?.mode === "testnet" && snapshot.setupError) throw new Error(snapshot.setupError);
      if (snapshot?.mode === "testnet" || ownerWallet.accountId) {
        if (!ownerWallet.accountId) throw new Error("Connect the configured owner’s Meteor Wallet to authorize this decision.");
        const challengeResponse = await fetch("/api/guardian/challenges", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: id, decision }),
        });
        const challenge = await challengeResponse.json();
        if (!challengeResponse.ok) throw new Error(challenge.error ?? "Could not prepare owner approval.");
        const signed = await ownerWallet.signMessage(challenge.message, challenge.recipient, challenge.nonce);
        authorization = { challengeId: challenge.id, ...signed };
      }
      const response = await fetch(`/api/requests/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...authorization }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Decision could not be saved.");
      await refresh();
      setToast({ tone: payload.status === "processing" ? "error" : "success", message: ownerWallet.accountId
        ? snapshot?.mode === "testnet"
          ? decision === "approve" ? payload.status === "sent" ? "Owner approved. Guardian submitted the testnet request." : `Owner approved. Submission needs confirmation${payload.transactionHash ? ` · tx ${payload.transactionHash.slice(0, 10)}…` : ""}. Do not retry.` : "Request denied; Guardian did not submit it."
          : `Owner signature verified. ${decision === "approve" ? "Mock request approved" : "Mock request denied"}; no transaction was sent.`
        : decision === "approve" ? "Approved in mock mode." : "Request denied." });
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
    <main className="shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="Guardian home">
          <span className="brand-mark"><ShieldGlyph /></span>
          <span className="brand-copy"><strong>guardian</strong><small>WALLET SECURITY</small></span>
        </a>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="nav-list" aria-label="Main navigation">
          <button className={`nav-item ${activeView === "overview" ? "nav-item--active" : ""}`} onClick={() => setActiveView("overview")}><GridGlyph />Overview</button>
          <button className={`nav-item ${activeView === "activity" ? "nav-item--active" : ""}`} onClick={() => setActiveView("activity")}><ActivityGlyph />Activity<span className="nav-count">{pending.length || ""}</span></button>
          <button className={`nav-item ${activeView === "rules" ? "nav-item--active" : ""}`} onClick={() => setActiveView("rules")}><SlidersGlyph />Protection rules</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="support-card">
            <span className="support-icon"><SparkGlyph /></span>
            <strong>Built to pause<br />before it moves.</strong>
            <p>Your guardian checks every request against your rules.</p>
          </div>
          <div className="profile-row"><span className="avatar">D</span><span><strong>DAWNIK Demo</strong><small>Testnet workspace</small></span><span className="more">···</span></div>
        </div>
      </aside>

      <section className="main-panel" id="top">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{activeView === "overview" ? "Overview" : activeView === "activity" ? "Activity" : "Protection rules"}</strong></div>
          <div className="topbar-right"><span className="mode-pill"><span className="mode-light" />{snapshot?.mode === "testnet" ? "NEAR TESTNET" : "MOCK DASHBOARD"}</span><button className="avatar avatar--small" aria-label="Demo profile">D</button></div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div><div className="eyebrow"><span className="eyebrow-line" />NEAR TESTNET · WALLET GUARDIAN</div><h1>{activeView === "overview" ? "Your wallet, watched." : activeView === "activity" ? "Activity & decisions." : "Protection rules."}</h1><p className="page-subtitle">{activeView === "overview" ? "Unusual spending pauses here until you say so." : activeView === "activity" ? "A clear record of what passed, paused, or was denied." : "Every request is checked before the Guardian lets it through."}</p></div>
            <button className="connect-button" onClick={ownerWallet.connect} disabled={!ownerWallet.ready} title="Connect the owner’s NEAR testnet account with Meteor Wallet"><span className="connect-dot" />{ownerWallet.accountId ?? (ownerWallet.ready ? "Connect owner wallet" : "Loading wallet…")}<ChevronDown /></button>
          </div>

          {snapshot?.mode === "testnet" && <div className="live-notice"><strong>Guardian testnet signer active.</strong> Meteor Wallet signs request and review approvals; only the Guardian server key sends transactions. {snapshot.setupError && <span>{snapshot.setupError}</span>}</div>}

          {activeView === "overview" && <>
            <section className="hero-card">
              <div className="hero-pattern" aria-hidden="true" />
              <div className="hero-copy"><span className="hero-kicker"><span className="pulse-dot" />GUARDIAN IS ACTIVE</span><h2>Your wallet has<br /><em>room to breathe.</em></h2><p>Every payment is checked. Anything unusual waits here for your approval.</p><button className="hero-action" onClick={() => setActiveView("activity")}>Review activity <ArrowRight /></button></div>
              <div className="hero-illustration" aria-hidden="true"><span className="orbit orbit--one" /><span className="orbit orbit--two" /><span className="orbit orbit--three" /><span className="guardian-orb"><ShieldGlyph /></span><span className="orb-chip orb-chip--one"><CheckGlyph /></span><span className="orb-chip orb-chip--two"><LockGlyph /></span></div>
              <div className="hero-foot"><span>PROTECTED ACCOUNT</span><strong>{snapshot?.accountId ?? "guardian-demo.testnet"}</strong><span className="hero-foot-right">LAST CHECK <strong>Just now</strong></span></div>
            </section>

            <div className="stat-grid">
              <article className="stat-card"><div className="stat-top"><span>{snapshot?.mode === "testnet" ? "TESTNET BALANCE" : "DEMO BALANCE"}</span><span className="stat-icon stat-icon--lavender"><CoinGlyph /></span></div><div className="stat-number">{snapshot ? snapshot.balance : "—"}<span> NEAR</span></div><div className="stat-foot"><span className="mini-dot mini-dot--lavender" />{snapshot?.mode === "testnet" ? "Live account balance" : "Mock balance · no funds at risk"}</div></article>
              <article className="stat-card"><div className="stat-top"><span>HELD FOR REVIEW</span><span className="stat-icon stat-icon--amber"><PauseGlyph /></span></div><div className="stat-number">{totals.held}<span> requests</span></div><div className="stat-foot"><span className="mini-dot mini-dot--amber" />Waiting for your decision</div></article>
              <article className="stat-card"><div className="stat-top"><span>{snapshot?.mode === "testnet" ? "SUBMITTED" : "MOCK PASSED"}</span><span className="stat-icon stat-icon--green"><CheckGlyph /></span></div><div className="stat-number">{totals.passed}<span> requests</span></div><div className="stat-foot"><span className="mini-dot mini-dot--green" />{snapshot?.mode === "testnet" ? "Confirmed on NEAR testnet" : "No rules were triggered"}</div></article>
            </div>

            <div className="section-head"><div><h2>Needs your attention <span className="section-count">{pending.length}</span></h2><p>These requests are waiting for your approval.</p></div><button className="text-button" onClick={() => setActiveView("activity")}>View all activity <ArrowRight /></button></div>
            <div className="request-list">
              {loading ? <div className="empty-state">Loading Guardian…</div> : pending.length ? pending.slice(0, 3).map((request) => <RequestCard key={request.id} request={request} busy={busyId === request.id} live={snapshot?.mode === "testnet"} onDecision={decide} />) : <div className="empty-state empty-state--clear"><span className="clear-check"><CheckGlyph /></span><strong>Nothing waiting on you</strong><span>New requests will appear here if a rule is triggered.</span></div>}
            </div>
            <div className="section-head scenarios-head"><div><h2>{snapshot?.mode === "testnet" ? "Submit an owner-authorized request" : "Try a demo scenario"}</h2><p>{snapshot?.mode === "testnet" ? "Meteor Wallet will sign this exact request. Requests that pass rules may be sent by the Guardian immediately." : "See how Guardian handles a request. All activity stays in mock mode."}</p></div>{snapshot?.mode !== "testnet" && <button className="burst-button" onClick={() => void runBurst()}><BurstGlyph />Simulate transfer burst</button>}</div>
            <div className="scenario-grid">{scenarios.filter((scenario) => snapshot?.mode !== "testnet" || scenario.input.kind === "transfer").map((scenario) => <button className="scenario-card" key={scenario.title} onClick={() => void submit(scenario.input)} disabled={snapshot?.mode === "testnet" && (!ownerWallet.accountId || Boolean(snapshot.setupError))}><span className="scenario-arrow"><ArrowUpRight /></span><strong>{scenario.title}</strong><small>{scenario.caption}</small></button>)}</div>
            {snapshot?.mode === "testnet" && <form className="key-request-form" onSubmit={(event) => { event.preventDefault(); void submit({ kind: keyRequestKind, recipient: keyRequest.trim() }); }}>
              <strong>Guard an access-key change</strong><p>Key changes are always held. Approval submits this exact change with the Guardian key.</p>
              <select value={keyRequestKind} onChange={(event) => setKeyRequestKind(event.target.value as "add_key" | "delete_key")}><option value="add_key">Add full-access key</option><option value="delete_key">Remove key</option></select>
              <input value={keyRequest} onChange={(event) => setKeyRequest(event.target.value)} placeholder="ed25519:…" autoComplete="off" />
              <button type="submit" disabled={!ownerWallet.accountId || Boolean(snapshot.setupError)}>Sign request</button>
            </form>}
          </>}

          {activeView === "activity" && <ActivityView snapshot={snapshot} loading={loading} busyId={busyId} onDecision={decide} />}
          {activeView === "rules" && <RulesView snapshot={snapshot} />}

          <footer className="footer"><span><span className="footer-lock"><LockGlyph /></span>Protected by deterministic rules</span><span>DEMO RULES · TESTNET TRANSFERS NEED WALLET SIGNATURE</span></footer>
        </div>
      </section>
      {toast && <div className={`toast toast--${toast.tone}`} role="status"><span>{toast.tone === "success" ? "✓" : "!"}</span>{toast.message}</div>}
    </main>
  );
}

function RequestCard({ request, busy, live, onDecision }: { request: GuardRequest; busy: boolean; live: boolean; onDecision: (id: string, decision: "approve" | "deny") => void }) {
  return <article className="request-card">
    <div className="request-main"><div className="request-avatar"><ShieldGlyph /></div><div className="request-details"><div className="request-title"><strong>{kindLabel(request)}</strong><span className="pending-badge"><span className="mini-dot mini-dot--amber" />ON HOLD</span></div><div className="request-recipient">{request.kind === "transfer" ? `To ${request.recipient}` : request.recipient} <span>·</span> {formatTime(request.createdAt)}</div><div className="request-reason">{request.reason}</div></div></div>
    <div className="request-side">{request.amount && <div className="request-amount">{request.amount}<span> NEAR</span></div>}<div className="request-actions"><button className="deny-button" onClick={() => onDecision(request.id, "deny")} disabled={busy}>{busy ? "Working…" : "Deny"}</button><button className="approve-button" onClick={() => onDecision(request.id, "approve")} disabled={busy}>{busy ? "Submitting…" : live ? "Approve & submit" : "Approve"}</button></div></div>
  </article>;
}

function ActivityView({ snapshot, loading, busyId, onDecision }: { snapshot: GuardianSnapshot | null; loading: boolean; busyId: string | null; onDecision: (id: string, decision: "approve" | "deny") => void }) {
  const live = snapshot?.mode === "testnet";
  return <section className="content-panel"><div className="panel-heading"><div><h2>Transaction requests</h2><p>{live ? "Only Guardian-signed testnet submissions move funds; every owner decision is audited." : "Mock decisions are recorded locally. They are not submitted to NEAR."}</p></div><span className="panel-count">{snapshot?.requests.length ?? 0} RECORDS</span></div>
    {loading ? <div className="empty-state">Loading activity…</div> : <div className="activity-table"><div className="table-head"><span>REQUEST</span><span>REASON</span><span>STATUS</span><span>TIME</span></div>{snapshot?.requests.map((request) => <div className="table-row" key={request.id}><div className="table-request"><span className="table-request-icon"><StateIcon state={request.status} /></span><span><strong>{kindLabel(request)}</strong><small>{request.recipient}{request.amount ? ` · ${request.amount} NEAR` : ""}{request.transactionHash && <span className="tx-hash">Tx {shortId(request.transactionHash)}</span>}</small></span></div><span className="table-reason">{request.reason ?? "No guard rule triggered"}</span><span className={`table-status table-status--${request.status}`}><StateIcon state={request.status} />{request.status === "sent" ? live ? "Sent · testnet" : "Passed · mock" : request.status}</span><span className="table-time">{formatTime(request.createdAt)}<small>{shortId(request.id)}</small></span>{request.status === "pending" && <div className="table-actions"><button onClick={() => onDecision(request.id, "deny")} disabled={busyId === request.id}>Deny</button><button onClick={() => onDecision(request.id, "approve")} disabled={busyId === request.id}>{live ? "Approve & submit" : "Approve"}</button></div>}</div>)}</div>}
    <div className="audit-heading"><div><h2>Audit trail</h2><p>Every Guardian decision is logged.</p></div></div><div className="audit-list">{snapshot?.audit.map((event) => <div className="audit-row" key={event.id}><span className={`audit-icon audit-icon--${event.action.includes("denied") ? "red" : event.action.includes("held") ? "amber" : "green"}`}><StateIcon state={event.action.includes("denied") ? "denied" : event.action.includes("held") ? "pending" : "sent"} /></span><span><strong>{event.action.replaceAll("_", " ")}</strong><small>{event.detail}</small></span><time>{formatTime(event.createdAt)}</time></div>)}</div>
  </section>;
}

function RulesView({ snapshot }: { snapshot: GuardianSnapshot | null }) {
  const rules = snapshot?.rules;
  return <section className="rules-layout"><div className="rules-intro"><span className="rules-symbol"><SlidersGlyph /></span><h2>Rules that keep the wallet steady.</h2><p>Requests are evaluated in code before they can be sent. The language model never decides whether to release a payment.</p></div>
    <div className="rule-list"><RuleRow icon="↗" title="Amount cap" description="Pause a single payment above your limit." value={`${rules?.amountCap ?? "—"} NEAR`} /><RuleRow icon="◎" title="New recipient" description="Pause payments to an address with no wallet history." value="Always hold" /><RuleRow icon="⌁" title="Transfer burst" description="Pause when too many transfers arrive in a short window." value={`${rules?.burstLimit ?? "—"} in ${rules?.burstWindowSeconds ?? "—"} sec`} /><RuleRow icon="⌘" title="Anomaly score" description="Compare a payment against this wallet’s typical amounts." value={`Z-score > ${rules?.anomalyZScore ?? "—"}`} /><RuleRow icon="⌑" title="Access key change" description="Always pause adding or removing an account key." value="Always hold" /></div>
    <div className="allowlist-card"><span className="allowlist-icon"><CheckGlyph /></span><div><strong>Trusted recipients</strong><p>Known recipients skip the new recipient rule. Other limits still apply.</p><div className="recipient-chips">{rules?.allowlist.map((recipient) => <span key={recipient}><span className="mini-dot mini-dot--green" />{recipient}</span>)}</div></div></div>
    <div className="notice-box"><LockGlyph /><span><strong>Clear by design.</strong> These rules are fixed for this prototype. Editable policies will be added after the signing flow is in place.</span></div>
  </section>;
}

function RuleRow({ icon, title, description, value }: { icon: string; title: string; description: string; value: string }) {
  return <article className="rule-row"><span className="rule-icon">{icon}</span><span className="rule-copy"><strong>{title}</strong><small>{description}</small></span><span className="rule-value">{value}</span><span className="rule-toggle" aria-label="Rule enabled"><span /></span></article>;
}

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
