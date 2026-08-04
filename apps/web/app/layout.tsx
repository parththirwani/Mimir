import type { Metadata } from "next";
import { Archivo, DM_Sans } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-sans",
});

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-archivo",
});

export const metadata: Metadata = {
  title: "Mimir",
  description:
    "Mimir is one continuous AI assistant. Tell it something once; it watches your Gmail, Calendar, Notion, Linear, GitHub and Slack and only interrupts when it matters.",
  icons: {
    icon: "/icon.png",
    apple: "/apple-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${dmSans.variable} ${archivo.variable}`}>
      <body style={{ backgroundColor: "oklch(0.145 0.004 285)" }}>{children}</body>
    </html>
  );
}
