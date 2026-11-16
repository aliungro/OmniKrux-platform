import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Shell } from "./features/shell/Shell";
export default function App() {
 const [client] = useState(() => new QueryClient());
 return <QueryClientProvider client={client}><Shell /></QueryClientProvider>;
}
