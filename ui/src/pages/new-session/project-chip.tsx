import { lazy } from "solid-js";
import type { ProjectRecent } from "../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { ProjectBrowserFocus } from "./draft-place-browser.types.ts";
import { SessionPicker } from "./picker.tsx";
import type { resolveProjectChip } from "./project-chip.ts";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

const ProjectPickerContent = lazy(() => import("./project-picker-content.tsx"), {
  export: "ProjectPickerContent",
});

export type ProjectChipProps = {
  params: NewSessionPlaceControlsOptions;
  state: ReturnType<typeof resolveProjectChip>;
  recents: readonly ProjectRecent[];
  nativeTerminal: boolean;
  focus?: ProjectBrowserFocus;
};

export function ProjectChip(props: ProjectChipProps) {
  const label = () =>
    props.params.place.deviceFolder ? t("newSession.deviceFolder") : props.state.label;
  return (
    <SessionPicker
      lazy
      kind="project"
      label={`${t("newSession.what")}: ${label()}`}
      value={label()}
      icon={<Icon name={props.params.place.browser.projectId ? "gitBranch" : "folder"} />}
      triggerAttributes={{ "data-project-id": props.params.place.browser.projectId || undefined }}
      params={props.params}
    >
      <ProjectPickerContent
        params={props.params}
        state={props.state}
        recents={props.recents}
        nativeTerminal={props.nativeTerminal}
        focus={props.focus}
      />
    </SessionPicker>
  );
}
