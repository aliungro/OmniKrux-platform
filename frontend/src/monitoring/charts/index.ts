// The chart chunk. Import it lazily (`import("../charts")`): a static import would pull it into
// the initial bundle. Only types are exported besides the view.

import ChartView from "./ChartView";

export type { ChartViewProps } from "./ChartView";
export default ChartView;
