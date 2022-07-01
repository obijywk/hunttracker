import { Request, Response } from "express";
import expressHbs = require("express-hbs");
import * as path from "path";
import * as fs from "fs";
import * as url from "url";

import { app, receiver } from "./app";
import * as db from "./db";
import * as home from "./home";
import * as puzzles from "./puzzles";
import { getPuzzleStatusEmoji, PuzzleStatusEmoji } from "./puzzle_status_emoji";
import * as refreshPolling from "./refresh_polling";
import { makeSlackChannelUrlPrefix } from "./slack_util";
import * as tags from "./tags";
import * as taskQueue from "./task_queue";
import * as users from "./users";

expressHbs.registerPartial(
  "menuheader",
  fs.readFileSync("views/menuheader.hbs", "utf-8"));

function puzzleStatusEmoji(puzzle: puzzles.Puzzle): PuzzleStatusEmoji {
  return getPuzzleStatusEmoji(puzzle);
}
expressHbs.registerHelper("puzzleStatusEmoji", puzzleStatusEmoji);

function commaSeparatedSolvers(puzzle: puzzles.Puzzle, limit: number): string {
  let s = puzzle.users.map(
    u => "<span class='solver-name'>" + u.name + "</span>",
  ).slice(0, limit).join(", ");
  if (puzzle.users.length > limit) {
    s += ", &mldr;";
  }
  return s;
}
expressHbs.registerHelper("commaSeparatedSolvers", commaSeparatedSolvers);

function checkAuth(req: Request, res: Response) {
  if (req.isAuthenticated()) {
    return true;
  }
  req.session.postLoginUrl = path.join(new url.URL(process.env.WEB_SERVER_URL).pathname, req.url);
  res.redirect("login");
  return false;
}

async function checkAdmin(req: Request) {
  const user = req.user as any;
  return await users.isAdmin(user.id);
}

receiver.app.get("/login", async (req, res) => {
  return res.render("login", {
    slackClientId: process.env.SLACK_CLIENT_ID,
    enableDarkMode: req.session.enableDarkMode,
  });
});

receiver.app.get("/logout", async (req, res) => {
  req.logout((err) => {
    if (err) {
      console.warn(err);
    }
  });
  req.session.postLoginUrl = null;
  return res.redirect("login");
});

async function indexRenderOptions(req: Request) {
  return {
    appName: process.env.APP_NAME,
    user: req.user,
    helpUrl: process.env.HELP_URL,
    isAdmin: await checkAdmin(req),
    useSlackWebLinks: req.session.useSlackWebLinks,
    enableDarkMode: req.session.enableDarkMode,
  };
}

receiver.app.get("/", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  return res.render("index", await indexRenderOptions(req));
});

receiver.app.post("/", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  req.session.useSlackWebLinks = req.body.useSlackWebLinks !== undefined;
  req.session.enableDarkMode = req.body.enableDarkMode !== undefined;
  return res.render("index", await indexRenderOptions(req));
});

receiver.app.get("/puzzles", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  return res.render("puzzles", {
    appName: process.env.APP_NAME,
    enableDarkMode: req.session.enableDarkMode,
    slackUrlPrefix: makeSlackChannelUrlPrefix(req.session.useSlackWebLinks),
    minimumIdleMinutes: process.env.MINIMUM_IDLE_MINUTES,
    initialSearch: req.query.search || "",
    initialTags: req.query.tags || "",
    initialExpandedPuzzleIds: req.query.expanded || "",
    initialSolvedFilter: req.query.solved || "",
  });
});

receiver.app.get("/puzzles/data", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).end();
  }
  res.contentType("application/json");
  const allPuzzles = await puzzles.list();
  const data = allPuzzles.map(p => Object.assign(
    {}, p, {
      idleDurationMilliseconds: puzzles.getIdleDuration(p).asMilliseconds(),
      puzzleStatusEmoji: getPuzzleStatusEmoji(p),
      breakout: puzzles.getBreakout(p),
    }));
  res.end(JSON.stringify({
    data,
  }));
});

receiver.app.get("/metas", async(req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  const allPuzzles = await puzzles.list();
  const metaPrefix = "meta/";
  const inPrefix = "in/";
  const tagSuffixes: Set<string> = new Set();
  const tagSuffixToMeta: { [key: string]: any } = {};
  const tagSuffixToPuzzles: { [key: string]: any } = {};
  for (const puzzle of allPuzzles) {
    const puzzleData: any = puzzle;
    for (const tag of puzzle.tags) {
      if (tag.name.startsWith(metaPrefix)) {
        const tagSuffix = tag.name.substr(metaPrefix.length);
        tagSuffixes.add(tagSuffix);
        puzzleData.tagSuffix = tagSuffix;
        tagSuffixToMeta[tagSuffix] = puzzleData;
      } else if (tag.name.startsWith(inPrefix)) {
        const tagSuffix = tag.name.substr(inPrefix.length);
        tagSuffixes.add(tagSuffix);
        if (tagSuffix in tagSuffixToPuzzles) {
          tagSuffixToPuzzles[tagSuffix].push(puzzleData);
        } else {
          tagSuffixToPuzzles[tagSuffix] = [puzzleData];
        }
      }
    }
  }
  const metas: Array<any> = [];
  for (const tagSuffix of tagSuffixes) {
    let meta = tagSuffixToMeta[tagSuffix];
    if (meta === undefined) {
      meta = {
        name: tagSuffix,
        tagSuffix,
        complete: false,
        tags: [],
      };
    }
    meta.puzzles = tagSuffixToPuzzles[tagSuffix];
    if (meta.puzzles === undefined) {
      meta.puzzles = [];
    }
    meta.puzzles.sort((a: any, b: any) => a.name < b.name ? -1 : 1);
    meta.numPuzzles = meta.puzzles.length;
    meta.numIncompletePuzzles = meta.puzzles
      .map((p: any) => p.complete ? 0 : 1)
      .reduce((a: number, b: number) => a + b, 0);
    meta.numCompletePuzzles = meta.puzzles
      .map((p: any) => p.complete ? 1 : 0)
      .reduce((a: number, b: number) => a + b, 0);
    metas.push(meta);
  }
  metas.sort((a: any, b: any) => {
    if (a.complete && !b.complete) {
      return 1;
    } else if (b.complete && !a.complete) {
      return -1;
    }
    return a.name < b.name ? -1 : 1;
  });
  return res.render("metas", {
    appName: process.env.APP_NAME,
    enableDarkMode: req.session.enableDarkMode,
    metas,
    slackUrlPrefix: makeSlackChannelUrlPrefix(req.session.useSlackWebLinks),
  });
});

receiver.app.get("/refresh", async (req, res) => {
  await refreshPolling.refresh();
  return res.status(200).send("ok");
});

receiver.app.get("/admin", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("puzzles");
    return;
  }
  return res.render("admin", {
    appName: process.env.APP_NAME,
    enableDarkMode: req.session.enableDarkMode,
    allowResetDatabase: process.env.ALLOW_RESET_DATABASE !== undefined,
  });
});

receiver.app.get("/admin/initdatabase", async (req, res) => {
  // Intentionally allow this one to run without auth, as auth won't work if
  // the database is not initialized. When the database is initialized, this
  // route is a no-op, so it's relatively safe to expose. We can figure out
  // a more secure way to do this later.
  if (await db.applySchemaIfDatabaseNotInitialized()) {
    await users.refreshAll();
  }
  return res.redirect("../admin");
});

receiver.app.post("/admin/resetdatabase", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("../puzzles");
    return;
  }
  if (!process.env.ALLOW_RESET_DATABASE) {
    res.redirect("../admin");
    return;
  }
  await db.applySchema();
  await users.refreshAll();
  return res.redirect("../admin");
});

receiver.app.post("/admin/refreshusers", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("../puzzles");
    return;
  }
  await users.refreshAll();
  return res.redirect("../admin");
});

receiver.app.post("/admin/refreshallpuzzles", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("../puzzles");
    return;
  }
  await puzzles.refreshAll();
  return res.redirect("../admin");
});

receiver.app.post("/admin/publishhome", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("../puzzles");
    return;
  }
  await home.publish(req.body.userId);
  return res.redirect("../admin");
});

receiver.app.get("/taskqueue", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("puzzles");
    return;
  }
  const tasks = await taskQueue.list();
  const displayTasks = tasks.map(t => Object.assign({}, t, {
    payload: JSON.stringify(t.payload),
    error: t.error ? JSON.stringify(t.error) : null,
  }));
  return res.render("taskqueue", {
    appName: process.env.APP_NAME,
    enableDarkMode: req.session.enableDarkMode,
    tasks: displayTasks,
  });
});

receiver.app.post("/taskqueue/process", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("../puzzles");
    return;
  }
  await taskQueue.processTaskQueue();
  return res.redirect("../taskqueue");
});

receiver.app.post("/taskqueue/startlistening", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("../puzzles");
    return;
  }
  await taskQueue.startListening();
  return res.redirect("../taskqueue");
});

receiver.app.post("/taskqueue/clearerror", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("../puzzles");
    return;
  }
  await taskQueue.clearTaskError(req.body.id);
  return res.redirect("../taskqueue");
});

receiver.app.post("/taskqueue/delete", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("../puzzles");
    return;
  }
  await taskQueue.deleteTask(req.body.id);
  return res.redirect("../taskqueue");
});

receiver.app.get("/tagger", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }

  const puzzlesPromise = puzzles.list();
  const tagsPromise = tags.list();

  const allTags = await tagsPromise;
  const tagOptions = allTags.map(t => ({
    id: t.id,
    text: t.name,
  }));

  const allPuzzles = await puzzlesPromise;
  const selectedPuzzles = new Set((req.query as any).p || []);
  const puzzleOptions = allPuzzles.map(p => ({
    id: p.id,
    text: p.name,
    selected: selectedPuzzles.has(p.id),
  }));

  res.render("tagger", {
    appName: process.env.APP_NAME,
    enableDarkMode: req.session.enableDarkMode,
    puzzleOptions: JSON.stringify(puzzleOptions),
    tagOptions: JSON.stringify(tagOptions),
  });
});

receiver.app.post("/tagger/update", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }

  const puzzleIds = (req.body.puzzles || []) as Array<string>;

  const addedTags = (req.body.addedTags || []) as Array<string>;
  const addedTagIds: Array<number> = [];
  const addedTagNames: Array<string> = [];
  for (const addedTag of addedTags) {
    if (addedTag.indexOf("new_") === 0) {
      addedTagNames.push(addedTag.substring(4));
    } else {
      addedTagIds.push(Number(addedTag));
    }
  }

  const removedTagIds = (req.body.removedTags || []).map((s: string) => Number(s)) as Array<number>;

  await tags.addAndRemoveTags(puzzleIds, addedTagIds, addedTagNames, removedTagIds);

  return res.redirect("../tagger");
});

receiver.app.get("/breakouts", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }

  const allPuzzles = await puzzles.list({excludeComplete: true});

  const breakouts: any = [];
  for (const puzzle of allPuzzles) {
    const breakout = puzzles.getBreakout(puzzle);
    if (breakout === null) {
      continue;
    }
    breakouts.push({
      breakout,
      puzzle,
    });
  }
  breakouts.sort((a: any, b: any) => (a.breakout < b.breakout) ? -1 : 1);

  res.render("breakouts", {
    appName: process.env.APP_NAME,
    enableDarkMode: req.session.enableDarkMode,
    slackUrlPrefix: makeSlackChannelUrlPrefix(req.session.useSlackWebLinks),
    breakouts: breakouts,
  });
});

receiver.app.post("/breakouts/remove", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }

  const id = req.body.puzzleId as string;
  const client = await db.connect();
  try {
    await puzzles.clearBreakout(id, client);
  } finally {
    client.release();
  }

  return res.redirect("../breakouts");
});
