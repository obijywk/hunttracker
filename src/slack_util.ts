import { ViewOutput } from "@slack/bolt";

export function getViewStateValues(view: ViewOutput) {
  const stateValues = (view.state as any)["values"];
  const values: any = {};
  for (const inputId of Object.keys(stateValues)) {
    for (const input of Object.values(stateValues[inputId])) {
      switch ((input as any).type) {
        case "plain_text_input":
          values[inputId] = (input as any).value;
          break;
        case "static_select":
          values[inputId] = (input as any)["selected_option"].value;
          break;
        case "multi_static_select":
          values[inputId] = [];
          const selectedOptions = (input as any)["selected_options"];
          if (selectedOptions) {
            for (const option of selectedOptions) {
              values[inputId].push(option.value);
            }
          }
          break;
      }
    }
  }
  return values;
}