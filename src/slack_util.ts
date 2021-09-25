import { ViewOutput } from "@slack/bolt";

import { app } from "./app";
import { ConversationsListResult } from "./slack_results";

export const MAX_CHANNEL_NAME_LENGTH: number = 79;
export const MAX_NUM_OPTIONS: number = 100;
export const MAX_OPTION_LENGTH: number = 75;

export async function findChannelIdForChannelName(channelName: string): Promise<string | null> {
  let cursor = undefined;
  do {
    const listConversationsResult = await app.client.conversations.list({
      token: process.env.SLACK_USER_TOKEN,
      cursor,
      types: "public_channel,private_channel",
    }) as ConversationsListResult;
    for (const channel of listConversationsResult.channels) {
      if (channel.name === channelName) {
        return channel.id;
      }
    }
    cursor = listConversationsResult.response_metadata.next_cursor;
  } while (cursor);
  return null;
}

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
        case "checkboxes":
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