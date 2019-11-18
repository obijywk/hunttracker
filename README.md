This is a puzzle hunt status tracking Slack bot.

## Environment variables

Everything is configured using environment variables, and they need to be set for anything to work.

- **PORT**: The server HTTP port. The default is 3000.
- **SLACK_SIGNING_SECRET**: This is the "Signing Secret" you can get from the
  "Basic Information" page in the "Your Apps" section of https://api.slack.com/.
- **SLACK_BOT_TOKEN**: This is the "Bot User OAUth Access Token" you can get from the
  "OAuth & Permissions" page in the "Your Apps" section of https://api.slack.com/.
- **SLACK_USER_TOKEN**: This is the "OAuth Access Token" you can get from the
  "OAuth & Permissions" page in the "Your Apps" section of https://api.slack.com/.
  So far, I have been somewhat cavalier about whether to use the bot token or the user
  token in various calls, we can clean this up later.
- **GOOGLE_SERVICE_ACCOUNT_EMAIL**: This is the e-mail address of a Google Cloud Platform
  service account used to access the Google Drive API for managing spreadsheets. You can create
  a service account for a GCP project
  [here](https://console.cloud.google.com/iam-admin/serviceaccounts). The Google Drive folder
  storing the spreadsheets should be shared with this account.
- **GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY**: This is the private_key associated with the Google
  Cloud Platform service account. It should be downloaded when you create the service account.
- **PGHOST**: The PostgreSQL database hostname.
- **PGPORT**: The PostgreSQL database port. The default is 5432.
- **PGUSER**: The PostgreSQL database username.
- **PGPASSWORD**: The PostgreSQL database password for the given user.
- **PGDATABASE**: The name of the PostgreSQL database to use.
- **SLACK_URL_PREFIX**: The beginning of your Slack instance URL e.g.
  "https://app.slack.com/client/T0E2CSZ8F/". This is used for building deep links into Slack.
- **SLACK_ACTIVITY_LOG_CHANNEL_NAME**: A Slack channel name (without the leading #) where
  puzzle creations etc. will be announced.
- **SLACK_IGNORED_USER_IDS**: A comma-separated list of Slack user IDs to be ignored for the
  purposes of tracking channel membership. Useful for ignoring the "bot" user (who cannot be
  detected automatically, because they're not _really_ a bot, because they need to be able to
  create channels).
- **HUNT_PREFIX**: A string that will be prepended to all generated puzzle channel names.
- **PUZZLE_SHEET_TEMPLATE_URL**: A link to a Google Sheet that will be copied to create
  per-puzzle spreadsheets. It should be in a folder editable by the Google Cloud Platform
  service account, and this folder is where the spreadsheets will be created as well.
- **MINIMUM_IDLE_MINUTES**: The number of minutes of inactivity on a solve for it to be
  considered idle.
- **REFRESH_POLLING_MINUTES**: The frequency with which to internally poll for changes that
  aren't detected using events (e.g. spreadsheet edits). Alternatively, you can set up an
  external process to periodically GET /refresh.

## Required Slack configuration

The following scopes to be added to the Slack app on the "OAuth & Permissions" page in the "Your Apps"
section of https://api.slack.com/.

- bot
- channels:read
- channels:write
- channels:history
- chat:write:bot
- chat:write:user
- pins:write
- users:read

The following workspace events need to be added on the "Event Subscriptions" page in the "Your Apps"
section of https://api.slack.com/.

- app_home_opened
- message.channels
- user_change

## Setup and run locally

Make sure the environment variables above are set before starting the server.

To receive incoming Slack events while testing locally, you'll need to use something like
[ngrok](https://api.slack.com/tutorials/tunneling-with-ngrok).

```
$ npm install
$ npm run build
$ npm run start
```

The first time you run it, you'll need to initialize the database by going to http://localhost:3000/
and clicking the button to reset the database. The database will be erased each time this button
is clicked.

## HTTP pages

- The index page currently has some buttons to help test various things
- Visiting **/solves** will (poorly) list puzzle solves that have been created