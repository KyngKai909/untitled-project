import { NavLink } from "react-router-dom";

function navClassName(input: { isActive: boolean }): string {
  return input.isActive ? "navLink active" : "navLink";
}

export default function AppHeader() {
  return (
    <header className="appHeader">
      <div className="appHeaderInner">
        <NavLink to="/" end className="brandLink">
          <span className="brandDot" aria-hidden="true" />
          OpenChannel
        </NavLink>

        <nav className="topNav" aria-label="Primary">
          <NavLink to="/" end className={navClassName}>
            Explore
          </NavLink>
          <NavLink to="/studio" className={navClassName}>
            Creator Studio
          </NavLink>
        </nav>
      </div>
    </header>
  );
}
