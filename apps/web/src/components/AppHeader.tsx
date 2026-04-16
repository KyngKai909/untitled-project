import { NavLink } from "react-router-dom";

interface AppHeaderProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

function navClass({ isActive }: { isActive: boolean }): string {
  return `appNav__link${isActive ? " isActive" : ""}`;
}

export default function AppHeader({ theme, onToggleTheme }: AppHeaderProps) {
  return (
    <header className="appHeader">
      <div className="appHeader__inner">
        <NavLink to="/dashboard" className="brand" aria-label="OpenCast Core Home">
          <span className="brand__mark" aria-hidden />
          <span className="brand__text">OpenCast Core</span>
          <span className="brand__tag">Broadcast OS</span>
        </NavLink>

        <nav className="appNav" aria-label="Primary">
          <NavLink to="/" className={navClass} end>
            Login
          </NavLink>
          <NavLink to="/dashboard" className={navClass}>
            Dashboard
          </NavLink>
        </nav>

        <button type="button" className="themeToggle" onClick={onToggleTheme}>
          <span className="themeToggle__dot" aria-hidden />
          {theme === "dark" ? "Dark" : "Light"}
        </button>
      </div>
    </header>
  );
}
