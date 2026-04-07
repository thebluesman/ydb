import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { ThemeToggle } from "./components/ThemeToggle";
import { NavLinks, ConfigLink } from "./components/NavLinks";
import "./globals.css";

const clashDisplay = localFont({
  src: "./fonts/ClashDisplay-Variable.ttf",
  variable: "--font-clash-display",
  display: "swap",
});
const clashGrotesk = localFont({
  src: "./fonts/ClashGrotesk-Variable.ttf",
  variable: "--font-clash-grotesk",
  display: "swap",
});
const ibmPlexMono = localFont({
  src: [
    { path: "./fonts/IBMPlexMono-Thin.ttf",       weight: "100" },
    { path: "./fonts/IBMPlexMono-ExtraLight.ttf",  weight: "200" },
    { path: "./fonts/IBMPlexMono-Light.ttf",       weight: "300" },
    { path: "./fonts/IBMPlexMono-Regular.ttf",     weight: "400" },
    { path: "./fonts/IBMPlexMono-Medium.ttf",      weight: "500" },
    { path: "./fonts/IBMPlexMono-SemiBold.ttf",    weight: "600" },
    { path: "./fonts/IBMPlexMono-Bold.ttf",        weight: "700" },
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
      <head>
        {/* Prevent flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark')document.documentElement.classList.add('dark')}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <header
          className="sticky top-0 z-50 flex items-center gap-8 px-6 py-3 shrink-0"
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
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <ConfigLink />
          </div>
        </header>
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
