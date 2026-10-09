import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

const display = localFont({
  src: [
    { path: "../fonts/SpaceGrotesk-Medium.ttf", weight: "500" },
    { path: "../fonts/SpaceGrotesk-SemiBold.ttf", weight: "600" },
    { path: "../fonts/SpaceGrotesk-Bold.ttf", weight: "700" },
  ],
  variable: "--nf-display",
  display: "swap",
});

const body = localFont({
  src: [{ path: "../fonts/DMSans-Variable.ttf", weight: "300 700" }],
  variable: "--nf-body",
  display: "swap",
});

const mono = localFont({
  src: [
    { path: "../fonts/DMMono-Regular.ttf", weight: "400" },
    { path: "../fonts/DMMono-Medium.ttf", weight: "500" },
  ],
  variable: "--nf-mono",
  display: "swap",
});

const serif = localFont({
  src: [{ path: "../fonts/InstrumentSerif-Italic.ttf", weight: "400", style: "italic" }],
  variable: "--nf-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Recourse: buyer protection for AI agents", template: "%s | Recourse" },
  description:
    "x402 payments have no recourse. Now they do. Signed offers, verified deliveries, hash-chained receipts and PayPal refunds for agents that pay for web content.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F6F1E9" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable} ${serif.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
