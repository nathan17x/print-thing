"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PrinterIcon, ShieldIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  const path = usePathname();
  const link = (href: string, label: string, Icon: typeof PrinterIcon) => {
    const active = href === "/" ? path === "/" : path.startsWith(href);
    return (
      <Link
        href={href}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
          active ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Icon className="size-4" />
        {label}
      </Link>
    );
  };
  return (
    <header className="sticky top-0 z-30 border-b bg-background/70 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <PrinterIcon className="size-4" />
          </span>
          Centennial Printers
        </Link>
        <nav className="flex items-center gap-1">
          {link("/", "Print", PrinterIcon)}
          {link("/admin", "Admin", ShieldIcon)}
        </nav>
      </div>
    </header>
  );
}
