import * as moment from "moment";
import { Request, Response } from "express";
import expressHbs = require("express-hbs");
import * as path from "path";
import * as fs from "fs";
import * as url from "url";
import * as pinsListResponseApi from "@slack/web-api/dist/response/PinsListResponse";

import { app, receiver } from "./app";
import * as db from "./db";
import * as google_people from "./google_people";
import * as home from "./home";
import * as huntSiteScraper from "./hunt_site_scraper";
import * as puzzles from "./puzzles";
import { getPuzzleStatusEmoji, PuzzleStatusEmoji } from "./puzzle_status_emoji";
import * as refreshPolling from "./refresh_polling";
import { makeSlackChannelUrlPrefix, makeSlackHuddleUrlPrefix } from "./slack_util";
import * as tags from "./tags";
import * as taskQueue from "./task_queue";
import * as users from "./users";
import { ActivityType, getPuzzleActivity, getUserActivity, listLatestActivity } from "./activity";

expressHbs.registerPartial(
  "favicon",
  fs.readFileSync("views/favicon.hbs", "utf-8"));

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

function cappedUsers(users: Array<users.User>, limit: number): Array<any> {
  const limitedUsers: any = users.slice(0, limit);
  if (users.length > limit) {
    limitedUsers.push({ additionalUserCount: users.length - limit });
  }
  return limitedUsers;
}
expressHbs.registerHelper("cappedUsers", cappedUsers);

function timeAgo(timestamp: moment.Moment | undefined): string {
  if (timestamp !== undefined) {
    const idleDuration = moment.duration(moment.utc().diff(timestamp));
    return Math.floor(idleDuration.asHours()) + "h"
      + String(idleDuration.minutes()).padStart(2, "0") + "m ago";
  }
  return "";
}
expressHbs.registerHelper("timeAgo", timeAgo);

function renderActivityType(activityType: ActivityType | undefined): string {
  switch (activityType) {
    case ActivityType.JoinChannel:
      return "Join Slack channel";
    case ActivityType.MessageChannel:
      return "Slack chat";
    case ActivityType.JoinHuddle:
      return "Join huddle";
    case ActivityType.EditSheet:
      return "Working in spreadsheet";
    case ActivityType.RecordAnswer:
      return "Record confirmed answer";
    default:
      return "";
  }
}
expressHbs.registerHelper("renderActivityType", renderActivityType);

function staticUrl(filename: string) {
  if (process.env.GAE_VERSION) {
    return "/static/" + filename + "?" + process.env.GAE_VERSION;
  }
  return "/static/" + filename;
}
expressHbs.registerHelper("staticUrl", staticUrl);

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
  if (!user) {
    return false;
  }
  return await users.isAdmin(user.id);
}

async function commonRenderOptions(req: Request) {
  return {
    appName: process.env.APP_NAME,
    appIconUrl: process.env.APP_ICON_FILENAME ? staticUrl("customicons/" + process.env.APP_ICON_FILENAME) : undefined,
    user: req.user,
    helpUrl: process.env.HELP_URL,
    isAdmin: await checkAdmin(req),
    useSlackWebLinks: req.session.useSlackWebLinks,
    enableDarkMode: req.session.enableDarkMode,
    hideAnswers: req.session.hideAnswers,
    slackUrlPrefix: makeSlackChannelUrlPrefix(req.session.useSlackWebLinks),
    slackHuddleUrlPrefix: makeSlackHuddleUrlPrefix(),
  };
}

receiver.app.get("/login", async (req, res) => {
  return res.render("login", {
    ...await commonRenderOptions(req),
    slackClientId: process.env.SLACK_CLIENT_ID,
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

receiver.app.get("/", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  return res.render("index", await commonRenderOptions(req));
});

receiver.app.post("/", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  req.session.useSlackWebLinks = req.body.useSlackWebLinks !== undefined;
  req.session.enableDarkMode = req.body.enableDarkMode !== undefined;
  req.session.hideAnswers = req.body.hideAnswers !== undefined;
  return res.render("index", await commonRenderOptions(req));
});

receiver.app.get("/puzzles", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  return res.render("puzzles", {
    ...await commonRenderOptions(req),
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

receiver.app.get("/metas", async (req, res) => {
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
    ...await commonRenderOptions(req),
    metas,
  });
});

receiver.app.get("/activity", async (req, res) => {
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
  const activeUsers = allUsers.filter(user => user.latestActivity);
  activeUsers.sort((a: any, b: any) => {
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

  return res.render("activity", {
    ...await commonRenderOptions(req),
    users: activeUsers,
  });
});

receiver.app.get("/useractivity/:userId", async (req, res) => {
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
    activity.puzzle = puzzleIdToPuzzle.get(activity.puzzleId);
  }

  return res.render("useractivity", {
    ...await commonRenderOptions(req),
    user,
    activities,
  });
});

receiver.app.get("/puzzleactivity/:puzzleId", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }

  const puzzleId = req.params.puzzleId;
  const puzzlePromise = puzzles.get(puzzleId);
  const activitiesPromise = getPuzzleActivity(puzzleId);
  const allUsersPromise = users.list();

  const puzzle = await puzzlePromise;
  const activities: Array<any> = await activitiesPromise;
  const allUsers = await allUsersPromise;
  const userIdToUser = new Map(allUsers.map(u => [u.id, u]));

  if (puzzle === null) {
    res.sendStatus(404);
    return;
  }

  for (const activity of activities) {
    activity.userName = userIdToUser.get(activity.userId).name;
  }

  return res.render("puzzleactivity", {
    ...await commonRenderOptions(req),
    puzzle,
    activities,
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
    ...await commonRenderOptions(req),
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
  await google_people.deleteAllPeople();
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

receiver.app.get("/admin/listpeople", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("../puzzles");
    return;
  }

  const peoplePromise = google_people.getAllPeople();
  const usersPromise = users.list();
  const allPeople = await peoplePromise;
  const allUsers = await usersPromise;

  const emailToPersonAndUser = new Map<string, any>();
  for (const person of allPeople) {
    if (!person.email) {
      continue;
    }
    if (!emailToPersonAndUser.has(person.email)) {
      emailToPersonAndUser.set(person.email, {});
    }
    emailToPersonAndUser.get(person.email).person = person;
  }
  for (const user of allUsers) {
    if (user.email) {
      if (!emailToPersonAndUser.has(user.email)) {
        emailToPersonAndUser.set(user.email, {});
      }
      emailToPersonAndUser.get(user.email).user = user;
    }
    if (user.googleEmail) {
      if (!emailToPersonAndUser.has(user.googleEmail)) {
        emailToPersonAndUser.set(user.googleEmail, {});
      }
      emailToPersonAndUser.get(user.googleEmail).user = user;
    }
  }

  const peopleAndUsers = Array.from(emailToPersonAndUser.values());
  peopleAndUsers.sort((a: any, b: any) => {
    let aName = "", bName = "";
    if (a.user && a.user.name) {
      aName = a.user.name.toLowerCase();
    } else if (a.person && a.person.name) {
      aName = a.person.name.toLowerCase();
    }
    if (b.user && b.user.name) {
      bName = b.user.name.toLowerCase();
    } else if (a.person && a.person.name) {
      bName = b.person.name.toLowerCase();
    }
    if (aName < bName) {
      return -1;
    } else {
      return 1;
    }
  });

  return res.render("listpeople", {
    ...await commonRenderOptions(req),
    peopleAndUsers,
  });
});

receiver.app.get("/admin/huntsitescraper", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("puzzles");
    return;
  }
  let settings = await huntSiteScraper.loadSettings();
  if (!settings) {
    settings = huntSiteScraper.defaultSettings();
  }
  return res.render("huntsitescraper", {
    ...await commonRenderOptions(req),
    ...settings,
    requestHeaders: JSON.stringify(settings.requestHeaders, null, 2),
  });
});

receiver.app.post("/admin/huntsitescraper", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }
  if (!await checkAdmin(req)) {
    res.redirect("puzzles");
    return;
  }

  let settings: huntSiteScraper.HuntSiteScraperSettings;
  try {
    settings = {
      enableScraping: req.body.enableScraping !== undefined,
      requestHeaders: req.body.requestHeaders ? JSON.parse(req.body.requestHeaders) : {},
      jwtUrl: req.body.jwtUrl,
      puzzleListUrl: req.body.puzzleListUrl,
      puzzleLinkSelector: req.body.puzzleLinkSelector,
      puzzleNameSelector: req.body.puzzleNameSelector,
      puzzleLinkJSONPathQuery: req.body.puzzleLinkJSONPathQuery,
      puzzleNameJSONPathQuery: req.body.puzzleNameJSONPathQuery,
      puzzleLinkRootUrl: req.body.puzzleLinkRootUrl,
      puzzleLinkDenyRegex: req.body.puzzleLinkDenyRegex,
      puzzleNameDenyRegex: req.body.puzzleNameDenyRegex,
      puzzleContentSelector: req.body.puzzleContentSelector,
    };
  } catch (e) {
    res.status(400).send({
      status: 400,
      message: e.toString(),
    });
    return;
  }

  if (req.body.test_puzzle_list !== undefined) {
    const debugOutput: huntSiteScraper.DebugOutput = {
      matchedPuzzleLinks: [],
      matchedPuzzleNames: [],
    };
    try {
      const puzzleList = await huntSiteScraper.scrapePuzzleList({
        settings,
        debugOutput,
      });
      res.contentType("application/json");
      res.end(JSON.stringify({ puzzleList, debugOutput }, null, 2));
    } catch (e) {
      res.contentType("application/json");
      res.end(JSON.stringify(e, null, 2));
    }
    return;
  }

  if (req.body.test_puzzle_content !== undefined) {
    try {
      const puzzleContent = await huntSiteScraper.scrapePuzzleContent(
        req.body.puzzleContentScrapeTestUrl,
        {
          settings,
        },
      );
      res.contentType("application/json");
      res.end(JSON.stringify({ puzzleContent }, null, 2));
    } catch (e) {
      res.contentType("application/json");
      res.end(JSON.stringify(e, null, 2));
    }
    return;
  }

  if (req.body.save !== undefined) {
    await huntSiteScraper.saveSettings(settings);
    res.redirect("/admin/huntsitescraper");
    return;
  }
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
    ...await commonRenderOptions(req),
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
    text: p.answer && !req.session.hideAnswers ? p.name + " (" + p.answer + ")" : p.name,
    selected: selectedPuzzles.has(p.id),
  }));

  res.render("tagger", {
    ...await commonRenderOptions(req),
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

  const allPuzzles = await puzzles.list({ excludeComplete: true });

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
    ...await commonRenderOptions(req),
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

function replaceLinksForDashboard(s: string, userMap: Map<string, users.User>): string {
  for (const m of s.matchAll(/\<(@?)([^>]+)\>/g)) {
    if (m[1] == "@") {
      const user = userMap.get(m[2]);
      if (user) {
        s = s.replace(`<@${user.id}>`, `@${user.name}`);
      }
    } else if (m[2].length > 50) {
      s = s.replace(`<${m[2]}>`, "<long link>");
    }
  }
  return s;
}

receiver.app.get("/dashboard", async (req, res) => {
  if (!checkAuth(req, res)) {
    return;
  }

  const allPuzzlesPromise = puzzles.list();
  const allUsersPromise = users.list();
  const latestActivityPromise = listLatestActivity();

  let noticesInfoPromise = null;
  let noticesPinsListPromise = null;
  if (process.env.SLACK_DASHBOARD_NOTICES_CHANNEL_ID) {
    noticesInfoPromise = app.client.conversations.info({
      token: process.env.SLACK_USER_TOKEN,
      channel: process.env.SLACK_DASHBOARD_NOTICES_CHANNEL_ID,
    });
    noticesPinsListPromise = app.client.pins.list({
      token: process.env.SLACK_USER_TOKEN,
      channel: process.env.SLACK_DASHBOARD_NOTICES_CHANNEL_ID,
    });
  }

  const allPuzzles = await allPuzzlesPromise;
  const userIdToUser = new Map((await allUsersPromise).map(u => [u.id, u]));
  const latestActivity = await latestActivityPromise;
  const noticesInfo = await noticesInfoPromise;
  const noticesPinsList = await noticesPinsListPromise;

  let activeUserCount = 0;
  const now = moment.utc();
  for (const activity of latestActivity) {
    if (moment.duration(now.diff(activity.timestamp)).asHours() < 1) {
      activeUserCount++;
    }
  }

  let solvedPuzzleCount = 0;
  let totalPuzzleCount = 0;
  let solvedMetaCount = 0;
  let totalMetaCount = 0;
  const eventChannelTopics = [];
  const metaPrefix = "meta/";
  const eventTagName = "event";
  for (const puzzle of allPuzzles) {
    const noCount = puzzle.tags.filter(t => t.name === "no-count").length > 0;
    if (!noCount) {
      totalPuzzleCount++;
      if (puzzle.complete) {
        solvedPuzzleCount++;
      }
    }
    for (const tag of puzzle.tags) {
      if (tag.name.startsWith(metaPrefix)) {
        if (!noCount) {
          totalMetaCount++;
          if (puzzle.complete) {
            solvedMetaCount++;
          }
        }
        break;
      }
      if (tag.name.startsWith(eventTagName) && !puzzle.complete && puzzle.channelTopic) {
        eventChannelTopics.push(replaceLinksForDashboard(puzzle.channelTopic, userIdToUser));
      }
    }
  }
  eventChannelTopics.sort();

  const notices = [];
  if (noticesInfo && noticesInfo.channel.topic) {
    for (const line of noticesInfo.channel.topic.value.split("\n")) {
      notices.push(replaceLinksForDashboard(line, userIdToUser));
    }
  }
  if (noticesPinsList) {
    noticesPinsList.items.sort((a: pinsListResponseApi.Item, b: pinsListResponseApi.Item) => {
      if (a.created < b.created) {
        return 1;
      }
      return -1;
    });
    for (const item of noticesPinsList.items) {
      if (item.type === "message") {
        notices.push(replaceLinksForDashboard((item as any).message.text, userIdToUser));
      }
    }
  }

  const unsolvedPuzzles = allPuzzles.filter(puzzle => !puzzle.complete);
  const pinTagName = "pin";
  unsolvedPuzzles.sort((a: puzzles.Puzzle, b: puzzles.Puzzle) => {
    const aPinned = a.tags.filter(t => t.name === pinTagName).length > 0;
    const bPinned = b.tags.filter(t => t.name === pinTagName).length > 0;
    if (aPinned && !bPinned) {
      return -1;
    }
    if (bPinned && !aPinned) {
      return 1;
    }
    const aIdleDuration = puzzles.getIdleDuration(a);
    const bIdleDuration = puzzles.getIdleDuration(b);
    if (aIdleDuration < bIdleDuration) {
      return -1;
    }
    return 1;
  });

  const recentActivity = latestActivity.map(a => {
      const user = userIdToUser.get(a.userId);
      const puzzle = allPuzzles.find(p => p.id === a.puzzleId);
      let activityText = "";
      switch (a.activityType) {
        case ActivityType.JoinChannel:
          activityText = "joined";
          break;
        case ActivityType.MessageChannel:
          activityText = "messaged";
          break;
        case ActivityType.EditSheet:
          activityText = "worked on";
          break;
        case ActivityType.RecordAnswer:
          activityText = "solved";
          break;
        case ActivityType.JoinHuddle:
          activityText = "huddlejoined";
          break;
      }
      return {
        user,
        puzzle,
        activityText,
        timestamp: a.timestamp,
      };
    }).sort((a, b) => b.timestamp.valueOf() - a.timestamp.valueOf());

  res.render("dashboard", {
    ...await commonRenderOptions(req),
    refresh: req.query.refresh,
    nextS: req.query.s === "events" ? "activity" : "events",
    showEvents: eventChannelTopics.length > 0 && req.query.s === "events",
    activeUserCount,
    solvedPuzzleCount,
    totalPuzzleCount,
    solvedMetaCount,
    totalMetaCount,
    eventChannelTopics,
    notices,
    unsolvedPuzzles,
    recentActivity,
  });
});