import * as cheerio from "cheerio";
import * as db from "./db";
import { PoolClient } from "pg";

export interface HuntSiteScraperSettings {
  enableScraping: boolean;
  requestHeaders: { [key: string]: string };
  puzzleListUrl: string;
  puzzleLinkSelector: string;
  puzzleNameSelector: string;
  puzzleLinkDenyRegex: string;
  puzzleNameDenyRegex: string;
  puzzleContentSelector: string;
}

export async function loadSettings(client?: PoolClient): Promise<HuntSiteScraperSettings | null> {
  const result = await db.query(
    "SELECT * FROM hunt_site_scraper_settings LIMIT 1", [], client);
  if (result.rowCount !== 1) {
    return null;
  }
  const row = result.rows[0];
  return {
    enableScraping: row.enable_scraping,
    requestHeaders: row.request_headers,
    puzzleListUrl: row.puzzle_list_url,
    puzzleLinkSelector: row.puzzle_link_selector,
    puzzleNameSelector: row.puzzle_name_selector,
    puzzleLinkDenyRegex: row.puzzle_link_deny_regex,
    puzzleNameDenyRegex: row.puzzle_name_deny_regex,
    puzzleContentSelector: row.puzzle_content_selector,
  };
}

export async function saveSettings(settings: HuntSiteScraperSettings): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM hunt_site_scraper_settings WHERE TRUE");
    await client.query(`
      INSERT INTO hunt_site_scraper_settings(
        enable_scraping,
        request_headers,
        puzzle_list_url,
        puzzle_link_selector,
        puzzle_name_selector,
        puzzle_link_deny_regex,
        puzzle_name_deny_regex,
        puzzle_content_selector
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        settings.enableScraping,
        settings.requestHeaders,
        settings.puzzleListUrl,
        settings.puzzleLinkSelector,
        settings.puzzleNameSelector,
        settings.puzzleLinkDenyRegex,
        settings.puzzleNameDenyRegex,
        settings.puzzleContentSelector,
      ]);
    await client.query("COMMIT");
  } catch (e) {
    console.error("Failed to save hunt site scraper settings", e);
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function buildUserAgentString(): string {
  return (
    process.env.APP_NAME.replace(" ", "") +
    "/1.0 (https://github.com/obijywk/hunttracker)"
  );
}

export interface DebugOutput {
  enableScraping?: boolean;
  matchedPuzzleLinks?: Array<string>;
  matchedPuzzleNames?: Array<string>;
  responseText?: string;
}

export interface ScrapeOptions {
  client?: PoolClient;
  settings?: HuntSiteScraperSettings;
  debugOutput?: DebugOutput;
}

export interface PuzzleLink {
  name: string;
  url: string;
}

export async function scrapePuzzleList(options?: ScrapeOptions): Promise<Array<PuzzleLink>> {
  const settings = options.settings ? options.settings : await loadSettings(options.client);
  if (options.debugOutput) {
    options.debugOutput.enableScraping = settings?.enableScraping;
  }
  if (settings === null || !settings.enableScraping) {
    return [];
  }

  const puzzleListUrl = new URL(settings.puzzleListUrl);
  const baseUrl = puzzleListUrl.protocol + "//" + puzzleListUrl.host;
  const fetchOptions = {
    headers: {
      "User-Agent": buildUserAgentString(),
      ...settings.requestHeaders,
    },
  };
  const request = new Request(settings.puzzleListUrl, fetchOptions);
  const response = await fetch(request);
  if (!response.ok) {
    throw `Failed to fetch puzzle list: ${response.statusText}`;
  }

  const responseText = await response.text();
  if (options.debugOutput) {
    options.debugOutput.responseText = responseText;
  }
  const dom = cheerio.load(responseText);

  const puzzleLinkElems = dom("body").find(settings.puzzleLinkSelector).toArray();
  if (options.debugOutput?.matchedPuzzleLinks) {
    options.debugOutput.matchedPuzzleLinks.push(
      ...puzzleLinkElems.map(e => dom("<div></div>").append(dom(e).clone()).html()));
  }

  const puzzleNameElems = dom("body").find(settings.puzzleNameSelector).toArray();
  if (options.debugOutput?.matchedPuzzleNames) {
    options.debugOutput.matchedPuzzleNames.push(
      ...puzzleNameElems.map(e => dom("<div></div>").append(dom(e).clone()).html()));
  }

  if (puzzleLinkElems.length !== puzzleNameElems.length) {
    return [];
  }

  const puzzleLinkList: Array<PuzzleLink> = [];
  for (let i = 0; i < puzzleLinkElems.length; i++) {
    const linkElem = puzzleLinkElems[i];
    const nameElem = puzzleNameElems[i];

    const href = dom(linkElem).attr("href");
    if (!href ||
        (settings.puzzleLinkDenyRegex && href.match(settings.puzzleLinkDenyRegex))) {
      continue;
    }

    const name = dom(nameElem).text().trim().replaceAll("\n", " ").replaceAll(/\s\s+/g, " ");
    if (!name ||
        (settings.puzzleNameDenyRegex && name.match(settings.puzzleNameDenyRegex))) {
      continue;
    }

    puzzleLinkList.push({
      name,
      url: new URL(href, baseUrl).toString(),
    });
  }

  return puzzleLinkList;
}