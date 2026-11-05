import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Guardian | Wallet protection",
  description: "A NEAR wallet guardian that pauses unusual spending for review.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
