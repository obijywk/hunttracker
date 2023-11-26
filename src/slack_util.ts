import { BlockAction, ButtonAction, SlackAction, ViewOutput } from "@slack/bolt";

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
        case "radio_buttons":
        case "static_select":
          values[inputId] = (input as any)["selected_option"].value;
          break;
        case "checkboxes":
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

export function getSlackActionValue(slackAction: SlackAction, actionId: string): string | null {
  const blockAction = slackAction as BlockAction;
  if (blockAction.actions === undefined) {
    return null;
  }
  for (const action of blockAction.actions) {
    const buttonAction = action as ButtonAction;
    if (action.action_id === actionId && buttonAction.value !== undefined) {
      return buttonAction.value;
    }
  }
  return null;
}

export function makeSlackChannelUrlPrefix(useSlackWebLinks: boolean): string {
  if (useSlackWebLinks) {
    return `https://app.slack.com/client/${process.env.SLACK_TEAM_ID}/`;
  }
  return `slack://channel?team=${process.env.SLACK_TEAM_ID}&id=`;
}

export function makeSlackHuddleUrlPrefix(): string {
  return `https://app.slack.com/huddle/${process.env.SLACK_TEAM_ID}/`;
}