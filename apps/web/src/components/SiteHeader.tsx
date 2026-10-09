"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./Icon";

const LINKS = [
  { href: "/console", label: "Console" },
  { href: "/publisher", label: "Publisher" },
  { href: "/owner", label: "Owner" },
  { href: "/verify", label: "Verify" },
  { href: "/log", label: "Log" },
] as const;

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link href="/" className="brand" aria-label="Recourse, home">
          <span className="brand__mark">
            <Icon name="receipt" size={20} />
          </span>
          Recourse
        </Link>
        <nav className="nav" aria-label="Main">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} {...(pathname === l.href || pathname.startsWith(`${l.href}/`) ? { "aria-current": "page" as const } : {})}>
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
