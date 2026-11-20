import type { TabNav } from "../features/shell/browserHistory";
import type { AppTabs } from "../features/shell/workspace";
import type { MonitoringTabAction, MonitoringView } from "./shell/tabState";

/** What the shell hands the Monitoring app. The shell imports this type only, so this module stays lazy. */
export interface MonitoringAppProps {
  tabs: AppTabs<MonitoringView>;
  nav: TabNav<MonitoringView>;
  dispatchTabs(action: MonitoringTabAction): void;
  onOpenSettings(): void;
  onOpenKubernetes(): void;
}

// A temporary entry: the app's layout replaces this body.
export default function MonitoringApp(_props: MonitoringAppProps) {
  return <h1>Monitoring</h1>;
}
