import { ViewOutput } from "@slack/bolt";

export function getViewStateValues(view: ViewOutput) {
  const stateValues = (view.state as any)["values"];
  const values: any = {};
  for (const inputId of Object.keys(stateValues)) {
    for (const input of Object.values(stateValues[inputId])) {
      values[inputId] = (input as any).value;
    }
  }
  return values;
}