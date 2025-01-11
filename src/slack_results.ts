import { WebAPICallResult } from "@slack/web-api";

export interface ChatPostMessageResult extends WebAPICallResult {
  ts: string;
}

export interface ConversationsCreateResult extends WebAPICallResult {
  channel: {
    id: string;
  };
}

export interface ConversationsHistoryResult extends WebAPICallResult {
  messages: Array<{
    ts: string;
    type: string;
    subtype: string;
    user: string;
  }>;
  has_more: boolean;
}

export interface ConversationsInfoResult extends WebAPICallResult {
  channel: {
    is_archived: boolean;
    latest: {
      ts: string;
    };
    topic: {
      value: string;
      last_set: number;
    };
  };
}

export interface ConversationsListResult extends WebAPICallResult {
  channels: Array<{
    id: string;
    name: string;
  }>;
}

export interface ConversationsMembersResult extends WebAPICallResult {
  members: Array<string>;
}

export interface UserResult {
  id: string;
  name: string;
  deleted: boolean;
  profile: {
    real_name_normalized: string;
    display_name_normalized: string;
    email: string;
    image_1024?: string;
    image_192?: string;
    image_24?: string;
    image_32?: string;
    image_48?: string;
    image_512?: string;
    image_72?: string;
  };
  is_bot: boolean;
}

export interface UsersListResult extends WebAPICallResult {
  members: [UserResult];
}
