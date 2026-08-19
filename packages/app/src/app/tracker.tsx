import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { IssuesScreen } from "@/screens/issues-screen";

export default function TrackerRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <IssuesScreen />
    </HostRouteBootstrapBoundary>
  );
}
