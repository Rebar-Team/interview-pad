import { NotFound } from "@/components/NotFound";
import { useMe } from "@/lib/api";
import { Loader2 } from "lucide-react";

import Dashboard from "./Dashboard";
import Login from "./Login";

export default function Home() {
  const me = useMe();
  if (me.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  // Only a 401 means signed out; anything else is the server having a bad time.
  if (me.isError) {
    return (
      <NotFound
        title="Couldn't reach RebarPad"
        description={me.error.message}
      />
    );
  }
  if (!me.data) return <Login />;
  return <Dashboard me={me.data} />;
}
