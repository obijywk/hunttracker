import moment = require("moment");
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
import { deleteAllPeople } from "./google_people";
import { ActivityType, getUserActivity, listLatestActivity } from "./activity";

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

function timeAgo(timestamp: moment.Moment | undefined): string {
  if (timestamp !== undefined) {
    const idleDuration = moment.duration(moment().utc().diff(timestamp));
    return Math.floor(idleDuration.asHours()) + "h"
      + String(idleDuration.minutes()).padStart(2, "0") + "m ago";
  }
  return "";
}
expressHbs.registerHelper("timeAgo", timeAgo);

function renderActivityType(activityType: ActivityType | undefined): string {
  switch (activityType) {
    case ActivityType.EditSheet:
      return "Working in spreadsheet";
    case ActivityType.MessageChannel:
      return "Slack chat";
    case ActivityType.JoinChannel:
      return "Join Slack channel";
    case ActivityType.RecordAnswer:
      return "Record confirmed answer";
    default:
      return "";
  }
}
expressHbs.registerHelper("renderActivityType", renderActivityType);

function checkAuth(req: Request, res: Response) {
  if (process.env.DISABLE_WEB_AUTH !== undefined) {
    return true;
  }
  if (req.isAuthenticated()) {
    return true;
  }
  req.session.postLoginUrl = path.join(new url.URL(process.env.WEB_SERVER_URL).pathname, req.url);
  res.redirect("login");
  return false;
}

async function checkAdmin(req: Request) {
  if (process.env.DISABLE_WEB_AUTH !== undefined) {
    return true;
  }
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
    initialSolvedFilter: req.query.solved || "unsolved",
  });
});

receiver.app.get("/puzzles/data", async (req, res) => {
  if (!req.isAuthenticated() && process.env.DISABLE_WEB_AUTH === undefined) {
    return res.status(401).end();
  }
  res.contentType("application/json");
  const allPuzzles = await puzzles.list();
  const data = allPuzzles.map(p => Object.assign(
    {}, p, {
      idleDurationMilliseconds: puzzles.getIdleDuration(p).asMilliseconds(),
      puzzleStatusEmoji: getPuzzleStatusEmoji(p),
      location: puzzles.getLocation(p),
    }));
  const getTagOrder = (t: tags.Tag) => {
    if (t.name.startsWith("in/")) {
      return -3;
    } else if (t.name.startsWith("priority/")) {
      return -2;
    } else if (t.name.startsWith("meta/")) {
      return -1;
    } else {
      return 0;
    }
  };
  for (const p of data) {
    p.tags.sort((a: tags.Tag, b: tags.Tag) => {
      const aOrder = getTagOrder(a);
      const bOrder = getTagOrder(b);
      if (aOrder < bOrder) {
        return -1;
      } else if (bOrder < aOrder) {
        return 1;
      } else {
        return a.name < b.name ? -1 : 1;
      }
    });
  }
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
  const sortMetas = (a: any, b: any) => {
    if (a.complete && !b.complete) {
      return 1;
    } else if (b.complete && !a.complete) {
      return -1;
    }
    if (a.orderKey && b.orderKey) {
      return a.orderKey < b.orderKey ? -1 : 1;
    }
    return a.name < b.name ? -1 : 1;
  };
  for (const meta of metas) {
    if (meta.tags.filter((t: tags.Tag) => t.name.startsWith(inPrefix)).length === 0) {
      let order = 0;
      let stack = [meta];
      while (stack.length !== 0) {
        const parent = stack.shift();
        parent.orderKey = `${meta.tagSuffix} ${String(order++).padStart(4, "0")}`;
        const childMetas = parent.puzzles.filter((p: any) => p.tagSuffix);
        childMetas.sort(sortMetas);
        stack = childMetas.concat(stack);
      }
    }
  }
  metas.sort(sortMetas);
  return res.render("metas", {
    appName: process.env.APP_NAME,
    enableDarkMode: req.session.enableDarkMode,
    metas,
    slackUrlPrefix: makeSlackChannelUrlPrefix(req.session.useSlackWebLinks),
  });
});

receiver.app.get("/solvers", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }

  const latestActivityPromise = listLatestActivity();
  const allPuzzlesPromise = puzzles.list();
  const allUsersPromise = users.list();

  const allUsers: Array<any> = await allUsersPromise;
  const allPuzzles = await allPuzzlesPromise;
  const latestActivity = await latestActivityPromise;

  const userIdToLatestActivity = new Map(latestActivity.map(a => [a.userId, a]));
  const puzzleIdToPuzzle = new Map(allPuzzles.map(p => [p.id, p]));

  for (const user of allUsers) {
    user.latestActivity = userIdToLatestActivity.get(user.id);
    if (user.latestActivity !== undefined) {
      user.latestActivityPuzzle = puzzleIdToPuzzle.get(user.latestActivity.puzzleId);
    }
  }
  allUsers.sort((a: any, b: any) => {
    if (a.latestActivity === undefined) {
      return 1;
    }
    if (b.latestActivity === undefined) {
      return -1;
    }
    if (a.latestActivity.timestamp < b.latestActivity.timestamp) {
      return 1;
    }
    return -1;
  });

  return res.render("solvers", {
    appName: process.env.APP_NAME,
    enableDarkMode: req.session.enableDarkMode,
    users: allUsers,
    slackUrlPrefix: makeSlackChannelUrlPrefix(req.session.useSlackWebLinks),
  });
});

receiver.app.get("/solvers/:userId", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }

  const userId = req.params.userId;
  const userPromise = users.get(userId);
  const activitiesPromise = getUserActivity(userId);
  const allPuzzlesPromise = puzzles.list();

  const user = await userPromise;
  const activities: Array<any> = await activitiesPromise;
  const allPuzzles = await allPuzzlesPromise;
  const puzzleIdToPuzzle = new Map(allPuzzles.map(p => [p.id, p]));

  if (user === null) {
    res.sendStatus(404);
    return;
  }

  for (const activity of activities) {
    activity.puzzleName = puzzleIdToPuzzle.get(activity.puzzleId).name;
  }

  return res.render("solver", {
    appName: process.env.APP_NAME,
    enableDarkMode: req.session.enableDarkMode,
    user,
    activities,
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

receiver.app.post("/admin/deletecontacts", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("../puzzles");
    return;
  }
  await deleteAllPeople();
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
    text: p.answer ? p.name + " (" + p.answer + ")" : p.name,
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

receiver.app.get("/locations", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }

  const allPuzzles = await puzzles.list({excludeComplete: true});

  const locations: any = [];
  for (const puzzle of allPuzzles) {
    const location = puzzles.getLocation(puzzle);
    if (location === null) {
      continue;
    }
    locations.push({
      location,
      puzzle,
    });
  }
  locations.sort((a: any, b: any) => (a.location.toLowerCase() < b.location.toLowerCase()) ? -1 : 1);

  res.render("locations", {
    appName: process.env.APP_NAME,
    enableDarkMode: req.session.enableDarkMode,
    slackUrlPrefix: makeSlackChannelUrlPrefix(req.session.useSlackWebLinks),
    locations: locations,
  });
});

receiver.app.post("/locations/remove", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }

  const id = req.body.puzzleId as string;
  const client = await db.connect();
  try {
    const puzzle = await puzzles.get(id, client);
    await puzzles.clearLocation(puzzle);
    await puzzles.refreshPuzzle(id, client);
  } finally {
    client.release();
  }

  return res.redirect("../locations");
});