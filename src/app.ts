import * as bodyParser from "body-parser";
import * as express from "express";
import expressHbs = require("express-hbs");
import expressSession from "express-session";
import moment = require("moment");
import passport from "passport";
import { Strategy as SlackStrategy } from "passport-slack-oauth2";
import { App, ExpressReceiver } from "@slack/bolt";
import { ErrorCode, WebAPIPlatformError } from "@slack/web-api";

import { sessionStore } from "./db";

declare module "express-session" {
  interface Session {
    postLoginUrl?: string;
    useSlackWebLinks?: boolean;
    enableDarkMode?: boolean;
  }
}

export const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: "/slack/events",
});

receiver.app.use(bodyParser.urlencoded({ extended: true }));

receiver.app.use(expressSession({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: moment.duration(14, "days").asMilliseconds(),
  },
}));

passport.use(new SlackStrategy({
  team: process.env.SLACK_TEAM_ID,
  clientID: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  skipUserProfile: false,
}, (accessToken: any, refreshToken: any, profile: any, done: any) => {
  done(null, profile);
}));
passport.serializeUser((user: any, cb) => {
  cb(null, JSON.stringify(user));
});
passport.deserializeUser((id: string, cb) => {
  cb(null, JSON.parse(id));
});
receiver.app.use(passport.initialize());
receiver.app.use(passport.session());
receiver.app.get("/auth/slack", passport.authenticate("Slack"));
receiver.app.get(
  "/auth/slack/callback",
  passport.authenticate("Slack", { failureRedirect: "/login" }),
  (req, res) => {
    if (req.session.postLoginUrl) {
      const redirectUrl = req.session.postLoginUrl;
      req.session.postLoginUrl = null;
      return res.redirect(redirectUrl);
    }
    return res.redirect("/");
  });

export const hbs = expressHbs.express4({});
receiver.app.set("view engine", "hbs");
receiver.app.engine("hbs", hbs);

receiver.app.set("views", "views");

receiver.app.use("/static", express.static("public"));

export const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  ignoreSelf: false,
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