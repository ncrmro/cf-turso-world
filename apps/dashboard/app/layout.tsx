import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Turso World Dashboard",
  description: "Workflow orchestration dashboard for Cloudflare Workers and Turso",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
