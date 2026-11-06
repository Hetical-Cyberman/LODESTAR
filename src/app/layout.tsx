import type { Metadata } from "next";
import "./globals.css";
import "@near-wallet-selector/modal-ui/styles.css";
import { WalletProvider } from "@/app/wallet-provider";

export const metadata: Metadata = {
  title: "Guardian | Wallet protection",
  description: "A NEAR wallet guardian that pauses unusual spending for review.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><WalletProvider>{children}</WalletProvider></body></html>;
}
