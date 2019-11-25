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
  return res.render("puzzles", {
    slackUrlPrefix: process.env.SLACK_URL_PREFIX,
    initialSearch: req.query.search || "",
  });
});

receiver.app.get("/puzzles/data", async (req, res) => {
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