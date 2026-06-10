import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  description: "AIAgent bootstrap control plane",
  title: "AIAgent"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

