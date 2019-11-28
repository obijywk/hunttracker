import { Request, Response } from "express";

import { receiver } from "./app";
import * as db from "./db";
import * as home from "./home";
import * as puzzles from "./puzzles";
import * as refreshPolling from "./refresh_polling";
import * as taskQueue from "./task_queue";
import * as users from "./users";

function checkAuth(req: Request, res: Response) {
  if (req.isAuthenticated()) {
    return true;
  }
  req.session.postLoginUrl = req.url;
  res.redirect("/login");
  return false;
}

receiver.app.get("/login", async (req, res) => {
  return res.render("login", {
    slackClientId: process.env.SLACK_CLIENT_ID,
  });
});

receiver.app.get("/logout", async (req, res) => {
  req.logout();
  req.session.postLoginUrl = null;
  return res.redirect("/login");
});

receiver.app.get("/", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  return res.render("index", {
    user: req.user,
  });
});

receiver.app.get("/puzzles", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  return res.render("puzzles", {
    slackUrlPrefix: process.env.SLACK_URL_PREFIX,
    initialSearch: req.query.search || "",
    initialTags: req.query.tags || "",
  });
});

receiver.app.get("/puzzles/data", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).end();
  }
  res.contentType("application/json");
  const allPuzzles = await puzzles.list();
  const data = allPuzzles.map(p => Object.assign(
    {}, p, {idleDurationMilliseconds: puzzles.getIdleDuration(p).asMilliseconds()}));
  res.end(JSON.stringify({
    data,
  }));
});

receiver.app.get("/refresh", async (req, res) => {
  await refreshPolling.refresh();
  return res.status(200).send("ok");
});

receiver.app.post("/resetdatabase", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  await db.applySchema();
  await users.refreshAll();
  return res.redirect("/");
});

receiver.app.post("/refreshusers", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  await users.refreshAll();
  return res.redirect("/");
});

receiver.app.post("/refreshallpuzzles", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  await puzzles.refreshAll();
  return res.redirect("/");
});

receiver.app.post("/publishhome", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  await home.publish(req.body.userId);
  return res.redirect("/");
});

receiver.app.get("/taskqueue", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  const tasks = await taskQueue.list();
  const displayTasks = tasks.map(t => Object.assign({}, t, {payload: JSON.stringify(t.payload)}));
  return res.render("taskqueue", {
    tasks: displayTasks,
  });
});

receiver.app.post("/taskqueue/process", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  await taskQueue.processTaskQueue();
  return res.redirect("/taskqueue");
});

receiver.app.post("/taskqueue/delete", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  await taskQueue.deleteTask(req.body.id);
  return res.redirect("/taskqueue");
});