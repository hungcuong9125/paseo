import { useEffect, useState } from "react";
import { openIssueForm, type IssueFormModel, type IssueFormSeed } from "@/issues/issue-form-model";

// Construct ONCE per mount (useState initializer, never useMemo keyed on live data) — see
// docs/forms.md. The caller re-mounts this via a `key` when the seed identity changes.
export function useIssueFormModel(seed: IssueFormSeed): IssueFormModel {
  const [model] = useState(() => openIssueForm(seed));
  useEffect(() => () => model.close(), [model]);
  return model;
}
