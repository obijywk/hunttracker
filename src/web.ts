import { receiver } from "./app";
import * as db from "./db";
import * as home from "./home";
import * as puzzles from "./puzzles";
import * as refreshPolling from "./refresh_polling";
import * as taskQueue from "./task_queue";
import * as users from "./users";

receiver.app.get("/", async (req, res) => {
  return res.render("index");
});

receiver.app.get("/puzzles", async (req, res) => {
  const puzzlesPromise = puzzles.list();
  return res.render("puzzles", {
    puzzles: await puzzlesPromise,
    slackUrlPrefix: process.env.SLACK_URL_PREFIX,
  });
});

receiver.app.get("/tag", async (req, res) => {
  const tagName = req.query.tag;
  if (!tagName) {
    return res.redirect("/");
  }
  const puzzlesPromise = puzzles.list({ withTag: tagName });
  return res.render("tag", {
    tag: tagName,
    puzzles: await puzzlesPromise,
    slackUrlPrefix: process.env.SLACK_URL_PREFIX,
  });
});

receiver.app.get("/refresh", async (req, res) => {
  await refreshPolling.refresh();
  return res.status(200).send("ok");
});

receiver.app.post("/resetdatabase", async (req, res) => {
  await db.applySchema();
  await users.refreshAll();
  return res.redirect("/");
});

receiver.app.post("/refreshusers", async (req, res) => {
  await users.refreshAll();
  return res.redirect("/");
});

receiver.app.post("/refreshallpuzzles", async (req, res) => {
  await puzzles.refreshAll();
  return res.redirect("/");
});

receiver.app.post("/publishhome", async (req, res) => {
  await home.publish(req.body.userId);
  return res.redirect("/");
});

receiver.app.get("/taskqueue", async (req, res) => {
  const tasks = await taskQueue.list();
  const displayTasks = tasks.map(t => Object.assign({}, t, {payload: JSON.stringify(t.payload)}));
  return res.render("taskqueue", {
    tasks: displayTasks,
  });
});

receiver.app.post("/taskqueue/process", async (req, res) => {
  await taskQueue.processTaskQueue();
  return res.redirect("/taskqueue");
});

receiver.app.post("/taskqueue/delete", async (req, res) => {
  await taskQueue.deleteTask(req.body.id);
  return res.redirect("/taskqueue");
});