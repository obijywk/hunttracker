This is a puzzle hunt status tracking Slack bot.

## Environment variables

Everything is configured using environment variables, and they need to be set for anything to work.

- **PORT**: The server HTTP port. The default is 3000.
- **WEB_SERVER_URL**: The publicly accessible URL for this server, with trailing slash.
  Used to build links.
- **HELP_URL**: A link to help instructions for how to use this.
- **SESSION_SECRET**: A secret string used to sign the session cookie to prevent tampering.
- **SLACK_CLIENT_ID**: This is the "Client ID" you can get from the "Basic Information"
  page in the "Your Apps" section of https://api.slack.com/.
- **SLACK_CLIENT_SECRET**: This is the "Client Secret" you can get from the "Basic Information"
  page in the "Your Apps" section of https://api.slack.com/.
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
- **SLACK_ADMIN_CHANNEL_ID**: A Slack channel ID (not name!). Only members of this channel will
  be able to register puzzles. Leave this unset to allow any user to register puzzles. The app
  user must be a member of this channel for this to work.
- **SLACK_IGNORED_USER_IDS**: A comma-separated list of Slack user IDs to be ignored for the
  purposes of tracking channel membership. Useful for ignoring the "bot" user (who cannot be
  detected automatically, because they're not _really_ a bot, because they need to be able to
  create channels).
- **HUNT_PREFIX**: A string that will be prepended to all generated puzzle channel names.
- **PUZZLE_SHEET_TEMPLATE_URL**: A link to a Google Sheet that will be copied to create
  per-puzzle spreadsheets. It should be in a folder editable by the Google Cloud Platform
  service account, and this folder is where the spreadsheets will be created as well.
- **AUTO_ARCHIVE**: If set, then puzzle channels will be automatically archived as they become
  solved.
- **MINIMUM_IDLE_MINUTES**: The number of minutes of inactivity on a puzzle for it to be
  considered idle.
- **MINIMUM_TOPIC_IDLE_MINUTES**: The number of minutes for which a topic may be unmodified
  before it is considered stale.
- **REFRESH_POLLING_MINUTES**: The frequency with which to internally poll for changes that
  aren't detected using events (e.g. spreadsheet edits). Alternatively, you can set up an
  external process to periodically GET /refresh, and leave this unset.
- **AWS_SNS_TOPIC_REGION**: The AWS region containing the SNS topic for task queue notifications,
  or unset to not use SNS.
- **AWS_NOTIFY_TASK_QUEUE_SNS_TOPIC_ARN**: The AWS SNS topic for task queue notifications, or
  unset to not use SNS.
- **LOG_DATABASE_CLIENT_USAGE**: If set, logs debugging information about database client creation
  and reuse.
- **LOG_MESSAGE_EVENTS**: If set, logs debugging information about incoming Slack requests and
  event messages. Currently only implemented for the AWS handler.

## Required Slack configuration

The following scopes to be added to the Slack app on the "OAuth & Permissions" page in the "Your Apps"
section of https://api.slack.com/. Your web server URL plus "/auth/slack/callback" must be added as a
"Redirect URL" on the "OAuth & Permissions" page.

- bot
- channels:read
- channels:write
- channels:history
- chat:write:bot
- chat:write:user
- groups:history
- groups:read
- pins:write
- users:read

The following workspace events need to be added on the "Event Subscriptions" page in the "Your Apps"
section of https://api.slack.com/. The "Request URL" on the "Event Subscriptions" page should be set to
your web server URL plus "/slack/events".

- app_home_opened
- member_joined_channel
- member_left_channel
- message.channels
- message.groups
- user_change

The "Request URL" on the "Interactive Components" page should be set to your web server URL plus
"/slack/events".

## Setup and run locally

Make sure the environment variables above are set before starting the server.

To receive incoming Slack events while testing locally, you'll need to use something like
[ngrok](https://api.slack.com/tutorials/tunneling-with-ngrok).

```
$ npm install
$ npm run build
$ npm run start
```

The first time you run it, you'll need to initialize the database by going to http://localhost:3000/admin/initdatabase. The database will be erased each time this button
is clicked.

## HTTP pages

- **/** doesn't contain much. It has a sign out link.
- **/puzzles** is a dashboard of all puzzles.
- **/tagger** is a tool for adding and removing tags on multiple puzzles at once.
- **/admin** has controls to trigger some administrative functions.
- **/taskqueue** can be used to manage the queue of asynchronous background tasks.