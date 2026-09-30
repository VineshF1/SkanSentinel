import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SkanSentinel",
  description: "Heartbeat monitor for scheduled background jobs.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100">{children}</body>
    </html>
  );
}
