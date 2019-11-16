import * as bodyParser from "body-parser";
import * as express from "express";
import { App, ExpressReceiver } from "@slack/bolt";

export const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: "/slack/events"
});

receiver.app.use(bodyParser.urlencoded({extended: false}));

receiver.app.set("view engine", "hbs");
receiver.app.set("views", "views");

receiver.app.use("/static", express.static("public"));

export const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});