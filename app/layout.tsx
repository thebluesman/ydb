import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import Script from "next/script";
import { ThemeToggle } from "./components/ThemeToggle";
import { NavLinks, ConfigLink, MobileNav } from "./components/NavLinks";
import { ToastProvider } from "./_components/ui";
import "./globals.css";

const clashDisplay = localFont({
  src: "./fonts/ClashDisplay-Variable.woff2",
  variable: "--font-clash-display",
  display: "swap",
});
const clashGrotesk = localFont({
  src: "./fonts/ClashGrotesk-Variable.woff2",
  variable: "--font-clash-grotesk",
  display: "swap",
});
const ibmPlexMono = localFont({
  src: [
    { path: "./fonts/IBMPlexMono-Regular.woff2",   weight: "400" },
    { path: "./fonts/IBMPlexMono-Medium.woff2",    weight: "500" },
    { path: "./fonts/IBMPlexMono-SemiBold.woff2",  weight: "600" },
  ],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ydb — Your Digital Bookkeeper",
  description: "Private, local-first personal accounting",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${clashDisplay.variable} ${clashGrotesk.variable} ${ibmPlexMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        <ToastProvider>
        {/* Prevent flash of wrong theme. 'system' (or no stored preference at
            all) falls back to prefers-color-scheme so first visit respects
            the OS setting instead of always landing on light. */}
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark')}catch(e){}})()`,
          }}
        />
        <header
          className="sticky top-0 z-50 flex items-center gap-4 md:gap-8 px-4 md:px-6 py-3 shrink-0"
          style={{
            backgroundColor: "var(--bg-nav)",
            backdropFilter: "blur(12px)",
            borderBottom: "1px solid var(--border-warm)",
          }}
        >
          <Link
            href="/"
            className="text-base transition-colors duration-150"
            style={{ color: "var(--tx-primary)", fontFamily: "var(--font-clash-display)", fontWeight: 700, fontSize: "1.5rem", lineHeight: 1 }}
          >
            ydb
          </Link>
          <NavLinks />
          <div className="hidden md:flex items-center gap-2">
            <ThemeToggle />
            <ConfigLink />
          </div>
          <div className="flex md:hidden items-center gap-1 flex-1 justify-end">
            <ThemeToggle />
            <MobileNav />
          </div>
        </header>
        <main className="flex-1 flex flex-col">{children}</main>
        </ToastProvider>
      </body>
    </html>
  );
}
