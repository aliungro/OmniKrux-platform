import { Component, Suspense, type ReactNode } from "react";
import s from "../dock/Dock.module.css";

export class ViewBoundary extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    const { label, children } = this.props;
    if (this.state.failed) return <p className={s.hint} role="alert">Couldn't load {label}. Reload the page.</p>;
    return <Suspense fallback={<p className={s.hint} role="status">Loading {label}…</p>}>{children}</Suspense>;
  }
}
