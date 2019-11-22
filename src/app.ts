import * as bodyParser from "body-parser";
import * as express from "express";
import { App, ExpressReceiver } from "@slack/bolt";
import { ErrorCode, WebAPIPlatformError } from "@slack/web-api";

export const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: "/slack/events",
});

receiver.app.use(bodyParser.urlencoded({extended: false}));

receiver.app.set("view engine", "hbs");
receiver.app.set("views", "views");

receiver.app.use("/static", express.static("public"));

export const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

app.error(e => {
  if (e.code === ErrorCode.PlatformError) {
    const platformError = e as WebAPIPlatformError;
    if (platformError.data && platformError.data.response_metadata) {
      console.error(platformError.data.response_metadata.messages);
    }
  }
  throw e;
});