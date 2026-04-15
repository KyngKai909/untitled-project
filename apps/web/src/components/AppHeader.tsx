import { NavLink } from "react-router-dom";
import { cn } from "../lib/utils";

function navClass(input: { isActive: boolean }) {
  return cn(
    "inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white",
    input.isActive && "bg-slate-100 text-slate-900 hover:bg-slate-200"
  );
}

export default function AppHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
        <NavLink to="/" className="text-sm font-semibold tracking-wide text-slate-100">
          OpenCast Core
        </NavLink>
        <nav className="ml-auto flex items-center gap-1" aria-label="Primary">
          <NavLink to="/" className={navClass} end>
            Login
          </NavLink>
          <NavLink to="/dashboard" className={navClass}>
            Creator Dashboard
          </NavLink>
        </nav>
      </div>
    </header>
  );
}
