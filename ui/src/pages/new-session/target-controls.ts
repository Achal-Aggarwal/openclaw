import type { ApplicationContext } from "../../app/context.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { NewSessionRouteData } from "./location.ts";

export type NewSessionPlaceControlsOptions = {
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  gateway: DraftGatewayState;
  place: DraftPlaceState;
  submitting: boolean;
  pendingPlacement: boolean;
  onConnectMachine: () => void;
  onNavigate: ApplicationContext["navigate"];
  onFocusComposer: () => void;
  onChange: () => void;
};
