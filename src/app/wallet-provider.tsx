"use client";

import { Buffer } from "buffer";
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type SignedOwnerMessage = { accountId: string; publicKey: string; signature: string };
type WalletContextValue = {
  accountId: string | null;
  ready: boolean;
  connect: () => void;
  signMessage: (message: string, recipient: string, nonceBase64: string) => Promise<SignedOwnerMessage>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void setupWalletSelector({ network: "testnet", modules: [setupHotWallet()] }).then((nextSelector) => {
      if (!active) return;
      const nextModal = setupModal(nextSelector, {
        theme: "dark",
        description: "Connect the configured owner’s NEAR testnet wallet to sign a Guardian review decision.",
      });
      const updateAccount = () => {
        const current = nextSelector.store.getState().accounts.find((account) => account.active)
          ?? nextSelector.store.getState().accounts[0];
        setAccountId(current?.accountId ?? null);
      };
      updateAccount();
      const subscription = nextSelector.store.observable.subscribe(updateAccount);
      unsubscribe = () => subscription.unsubscribe();
      setSelector(nextSelector);
      setModal(nextModal);
      setReady(true);
    }).catch(() => setReady(true));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const connect = useCallback(() => modal?.show(), [modal]);
  const signMessage = useCallback(async (message: string, recipient: string, nonceBase64: string) => {
    if (!selector || !accountId) throw new Error("Connect the owner’s HOT Wallet first.");
    const wallet = await selector.wallet();
    const signed = await wallet.signMessage({ message, recipient, nonce: Buffer.from(nonceBase64, "base64") });
    if (!signed) throw new Error("The wallet did not return a signature.");
    return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature };
  }, [selector, accountId]);

  const value = useMemo(() => ({ accountId, ready, connect, signMessage }), [accountId, ready, connect, signMessage]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useNearWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useNearWallet must be used within WalletProvider.");
  return value;
}
