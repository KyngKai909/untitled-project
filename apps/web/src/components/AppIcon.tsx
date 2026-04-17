import { ReactNode } from "react";

type AppIconName =
  | "arrow-left"
  | "chart"
  | "clock"
  | "close"
  | "eye"
  | "home"
  | "library"
  | "list"
  | "megaphone"
  | "menu"
  | "monitor"
  | "plus"
  | "refresh"
  | "send"
  | "skip-next"
  | "skip-prev"
  | "stop"
  | "trash"
  | "upload"
  | "user"
  | "wallet"
  | "zap";

interface AppIconProps {
  name: AppIconName;
  className?: string;
}

function iconPath(name: AppIconName): ReactNode {
  switch (name) {
    case "arrow-left":
      return (
        <>
          <path d="M19 12H5" />
          <path d="m12 5-7 7 7 7" />
        </>
      );
    case "chart":
      return (
        <>
          <path d="M4 19h16" />
          <path d="M7 16V9" />
          <path d="M12 16V5" />
          <path d="M17 16v-4" />
        </>
      );
    case "clock":
      return (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v5l3 2" />
        </>
      );
    case "close":
      return (
        <>
          <path d="m6 6 12 12" />
          <path d="m18 6-12 12" />
        </>
      );
    case "eye":
      return (
        <>
          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
          <circle cx="12" cy="12" r="2.5" />
        </>
      );
    case "home":
      return (
        <>
          <path d="M4 10.5 12 4l8 6.5V20H4z" />
          <path d="M9 20v-5h6v5" />
        </>
      );
    case "library":
      return (
        <>
          <path d="M4 5h6v14H4z" />
          <path d="M14 5h6v14h-6z" />
          <path d="M10 8h4" />
          <path d="M10 12h4" />
          <path d="M10 16h4" />
        </>
      );
    case "list":
      return (
        <>
          <path d="M8 6h12" />
          <path d="M8 12h12" />
          <path d="M8 18h12" />
          <circle cx="4" cy="6" r="1" />
          <circle cx="4" cy="12" r="1" />
          <circle cx="4" cy="18" r="1" />
        </>
      );
    case "megaphone":
      return (
        <>
          <path d="M3 11v2l8-1V10z" />
          <path d="M11 10V7l8-2v14l-8-2v-3" />
          <path d="M5 13v5h3l1-5" />
        </>
      );
    case "menu":
      return (
        <>
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </>
      );
    case "monitor":
      return (
        <>
          <rect x="3" y="5" width="18" height="12" rx="1" />
          <path d="M9 20h6" />
          <path d="M12 17v3" />
        </>
      );
    case "plus":
      return (
        <>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </>
      );
    case "refresh":
      return (
        <>
          <path d="M20 11a8 8 0 1 0 2 5.5" />
          <path d="m20 4 2 5-5 2" />
        </>
      );
    case "send":
      return (
        <>
          <path d="M3 11 21 3 13 21l-2-8z" />
          <path d="M11 13 21 3" />
        </>
      );
    case "skip-next":
      return (
        <>
          <path d="M6 7v10l8-5z" />
          <path d="M17 7v10" />
        </>
      );
    case "skip-prev":
      return (
        <>
          <path d="M18 7v10l-8-5z" />
          <path d="M7 7v10" />
        </>
      );
    case "stop":
      return <rect x="6" y="6" width="12" height="12" />;
    case "trash":
      return (
        <>
          <path d="M4 7h16" />
          <path d="M9 7V5h6v2" />
          <path d="M7 7l1 12h8l1-12" />
          <path d="M10 11v5" />
          <path d="M14 11v5" />
        </>
      );
    case "upload":
      return (
        <>
          <path d="M12 16V5" />
          <path d="m8 9 4-4 4 4" />
          <path d="M4 19h16" />
        </>
      );
    case "user":
      return (
        <>
          <circle cx="12" cy="8" r="3" />
          <path d="M5 19a7 7 0 0 1 14 0" />
        </>
      );
    case "wallet":
      return (
        <>
          <path d="M3 7h18v10H3z" />
          <path d="M17 12h4" />
          <circle cx="16.5" cy="12" r="1" />
          <path d="M5 7V5h12v2" />
        </>
      );
    case "zap":
      return (
        <>
          <path d="M13 3 5 13h6l-1 8 8-10h-6z" />
        </>
      );
  }
}

export default function AppIcon({ name, className }: AppIconProps) {
  return (
    <svg
      className={`uiIcon${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPath(name)}
    </svg>
  );
}
