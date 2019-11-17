import { receiver } from "./app";
import * as db from "./db";
import * as home from "./home";
import * as puzzles from "./puzzles";
import * as refreshPolling from "./refresh_polling";
import * as solves from "./solves";
import * as users from "./users";

receiver.app.get("/", async (req, res) => {
  return res.render("index");
});

receiver.app.get("/solves", async (req, res) => {
  const solvesPromise = solves.list();
  return res.render("solves", {
    solves: await solvesPromise,
    slackUrlPrefix: process.env.SLACK_URL_PREFIX
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

receiver.app.post("/createdemosolves", async (req, res) => {
  const puzzleId1 = await puzzles.create(
    "First You Visit Burkina Faso",
    "http://web.mit.edu/puzzle/www/2019/puzzle/first_you_visit_burkina_faso.html");
  await solves.create(puzzleId1);

  const puzzleId2 = await puzzles.create(
    "Funkin'",
    "http://web.mit.edu/puzzle/www/2019/puzzle/funkin.html");
  await solves.create(puzzleId2);

  return res.redirect("/");
});

receiver.app.post("/refreshallsolves", async (req, res) => {
  await solves.refreshAll();
  return res.redirect("/");
});

receiver.app.post("/publishhome", async (req, res) => {
  await home.publish(req.body.userId);
  return res.redirect("/");
});