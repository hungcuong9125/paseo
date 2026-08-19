import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { TrackerScreen } from "@/screens/tracker-screen";

export default function TrackerRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <TrackerScreen />
    </HostRouteBootstrapBoundary>
  );
}
