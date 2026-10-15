import { NotFound } from "./components/NotFound";
import { matchRoute, usePathname } from "./lib/router";
import Home from "./pages/Home";
import RoomPage from "./pages/RoomPage";

export default function App() {
  const route = matchRoute(usePathname());
  switch (route.page) {
    case "home":
      return <Home />;
    case "room":
      return <RoomPage key={route.id} id={route.id} />;
    case "missing":
      return <NotFound title="Page not found" />;
  }
}
