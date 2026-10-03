import { useEffect, useState } from "react";
import {
  openTrackerForm,
  type TrackerFormModel,
  type TrackerFormSeed,
} from "@/tracker/tracker-form-model";

// Construct ONCE per mount (useState initializer, never useMemo keyed on live data) — see
// docs/forms.md. The caller re-mounts this via a `key` when the seed identity changes.
export function useTrackerFormModel(seed: TrackerFormSeed): TrackerFormModel {
  const [model] = useState(() => openTrackerForm(seed));
  useEffect(() => () => model.close(), [model]);
  return model;
}
