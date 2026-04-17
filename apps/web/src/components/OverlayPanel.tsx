import { ReactNode, useEffect } from "react";
import AppIcon from "./AppIcon";

interface OverlayPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  mode?: "center" | "left" | "right";
  children: ReactNode;
}

export default function OverlayPanel({
  open,
  onClose,
  title,
  subtitle,
  mode = "center",
  children
}: OverlayPanelProps) {
  useEffect(() => {
    if (!open) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="overlayBackdrop" onMouseDown={onClose} role="presentation">
      <section
        className={`overlayPanel overlayPanel--${mode}`}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="overlayPanel__head">
          <div className="overlayPanel__title">
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="overlayPanel__close" type="button" onClick={onClose} aria-label="Close panel">
            <AppIcon name="close" />
          </button>
        </header>
        <div className="overlayPanel__body">{children}</div>
      </section>
    </div>
  );
}
