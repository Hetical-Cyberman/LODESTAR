"use client";

import { useEffect, useState, type FormEvent } from "react";
import { actionCreators, setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import type { WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";

type TransferIntent = { accountId: string; recipient: string; amount: string; reason: string | null };

function toYoctoNear(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * BigInt(10) ** BigInt(24) + BigInt((fraction + "0".repeat(24)).slice(0, 24));
}

export default function TestnetWallet() {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [intent, setIntent] = useState<TransferIntent | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    let modal: ReturnType<typeof setupModal> | undefined;

    void setupWalletSelector({
      network: "testnet",
      modules: [setupHotWallet()],
    }).then((created) => {
      if (!alive) return;
      modal = setupModal(created, { theme: "dark", description: "Connect a HOT Wallet testnet account" });
      setModal(modal);
      const syncAccount = () => {
        const active = created.store.getState().accounts.find((account) => account.active);
        setAccountId(active?.accountId ?? "");
      };
      syncAccount();
      const subscription = created.store.observable.subscribe(syncAccount);
      unsubscribe = () => subscription.unsubscribe();
      setSelector(created);
    }).catch(() => setNotice("Wallet options could not be loaded. Check your connection and reload."));

    return () => {
      alive = false;
      unsubscribe?.();
      modal?.hide();
    };
  }, []);

  function reviewTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const cleanRecipient = recipient.trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,64}$/.test(cleanRecipient) || !cleanRecipient.endsWith(".testnet")) {
      setNotice("Enter a valid .testnet account ID.");
      return;
    }
    if (amount.length > 48 || !/^\d+(\.\d{1,24})?$/.test(amount) || Number(amount) <= 0) {
      setNotice("Enter a positive amount with up to 24 decimal places and no more than 48 characters.");
      return;
    }
    const reasons: string[] = [];
    if (Number(amount) > 5) reasons.push("This exceeds the 5 NEAR demo limit.");
    if (!new Set(["vendor.testnet", "friend.testnet"]).has(cleanRecipient)) reasons.push("This is not in the demo trusted-recipient list.");
    setIntent({ accountId, recipient: cleanRecipient, amount, reason: reasons.length ? reasons.join(" ") : null });
    setNotice(reasons.length ? "This request is held for your review." : "Rules passed. Review and approve before your wallet is asked to sign.");
  }

  async function approveAndSend() {
    if (!selector || !accountId || !intent) return;
    setBusy(true);
    setNotice("");
    try {
      const wallet = await selector.wallet();
      const result = await wallet.signAndSendTransaction({
        signerId: accountId,
        receiverId: intent.recipient,
        actions: [actionCreators.transfer(toYoctoNear(intent.amount))],
      });
      const txHash = result?.transaction?.hash;
      setIntent(null);
      setNotice(txHash ? `Testnet transaction submitted. Hash: ${txHash}` : "Wallet flow completed. Check your testnet wallet for the transaction status.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The wallet did not complete the transaction.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!selector) return;
    try {
      const wallet = await selector.wallet();
      await wallet.signOut();
      setIntent(null);
      setNotice("Wallet disconnected.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not disconnect wallet.");
    }
  }

  return (
    <section className="testnet-panel" aria-labelledby="testnet-heading">
      <div className="testnet-panel__head">
        <div><span className="testnet-eyebrow">OPTIONAL · NEAR TESTNET</span><h2 id="testnet-heading">Try a guarded transfer</h2><p>Connect a testnet wallet, review the request, then approve it in your wallet.</p></div>
        {accountId ? <button className="testnet-connect" onClick={() => void disconnect()} title="Disconnect testnet wallet">{accountId}<span>Disconnect</span></button> : <button className="testnet-connect" disabled={!selector} onClick={() => modal?.show()}>{selector ? "Connect HOT Wallet" : "Loading wallet options…"}</button>}
      </div>
      <div className="testnet-boundary"><strong>Testnet only.</strong> Only transfers started here are checked. The wallet asks you to sign before anything is broadcast. Checks use the demo rules and trusted-recipient list, not live wallet history.</div>
      {accountId && <form className="testnet-form" onSubmit={reviewTransfer}>
        <label>Recipient account<input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="name.testnet" autoComplete="off" /></label>
        <label>Amount in NEAR<input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.25" /></label>
        <button type="submit" className="testnet-review">Check request</button>
      </form>}
      {intent && accountId && <div className="testnet-intent">
        <div><strong>{intent.amount} NEAR</strong><span>to {intent.recipient}</span>{intent.reason && <p>{intent.reason}</p>}</div>
        <div className="testnet-intent__actions"><button onClick={() => setIntent(null)} disabled={busy}>Cancel</button><button onClick={() => void approveAndSend()} disabled={busy}>{busy ? "Waiting for wallet…" : "Approve & send"}</button></div>
      </div>}
      {notice && <p className="testnet-notice" role="status">{notice}</p>}
    </section>
  );
}
