import { NavLink } from "react-router-dom";
import AppIcon from "./AppIcon";

interface AppHeaderProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

function navClass({ isActive }: { isActive: boolean }): string {
  return `topnav__link${isActive ? " isActive" : ""}`;
}

export default function AppHeader({ theme, onToggleTheme }: AppHeaderProps) {
  return (
    <header className="topbar">
      <div className="topbar__inner">
        <NavLink className="brandLockup" to="/dashboard" aria-label="OpenCast Core">
          <span className="brandLockup__glyph" aria-hidden />
          <span className="brandLockup__title">OpenCast Core</span>
          <span className="brandLockup__subtitle">Live Channel Operations</span>
        </NavLink>

        <nav className="topnav" aria-label="Primary">
          <NavLink to="/" className={navClass} end>
            <span className="uiInline">
              <AppIcon name="user" />
              Login
            </span>
          </NavLink>
          <NavLink to="/dashboard" className={navClass}>
            <span className="uiInline">
              <AppIcon name="home" />
              Workspace
            </span>
          </NavLink>
        </nav>

        <button className="themeSwitch" type="button" onClick={onToggleTheme}>
          <span className="themeSwitch__dot" aria-hidden />
          {theme === "dark" ? "Dark" : "Light"}
        </button>
      </div>
    </header>
  );
}
