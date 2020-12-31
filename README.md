This is a puzzle hunt status tracking Slack app. Its user interface is implemented within Slack as much as possible, with a few external web views for features that are awkward or impossible to present within Slack itself. If your puzzle hunting team is really into Slack, this might be a good solution for you! If not, check out some of the other solutions tagged with [#puzzle-hunt](https://github.com/topics/puzzle-hunt) on Github.

## Features

The app's [Home tab](https://api.slack.com/surfaces/tabs) is its main entry point. It contains a few buttons to access app functionality, as well as information about puzzles that are currently unsolved.

A "puzzle" may be used to represent a normal puzzle, a metapuzzle, an event, or any other solvable thing you want to track. This app maintains a Slack channel per puzzle. For each unsolved puzzle, the Home tab lists the puzzle channel's topic (useful as a quick summary of the puzzle content and current status of the solve), which team members are working on it, and any tags associated with the puzzle. It provides _Join channel_ buttons to make it easy to start working on a puzzle from this view, but it's also OK for a user to join a puzzle's channel via normal Slack features.

The _Register puzzle_ button on the Home tab is used to create a Slack channel, Google Sheet, and (if configured) a Google Meet for a puzzle. It presents a dialog for entering information about the puzzle including its name, a URL for the puzzle content, tags to associate with the puzzle, and an initial topic. All fields are optional other than a unique puzzle name, and tags and a topic can be set and changed later. The puzzle registration feature may be optionally configured only for "admin" users who are members of a private admin channel.

This app pins and maintains a _status message_ at the top of each puzzle channel. This message contains links to the puzzle content and the Google Sheet for the puzzle, as well as tracking for how long the puzzle's been "idle" (no activity in its channel or spreadsheet, or no manual indication that its still being worked on), its tags and functionality to edit them, and functionality for recording the puzzle as solved and providing its answer. The _status message_ is continuously updated by the app.

There are many more features that have not yet been thoroughly documented here:
 * the puzzles dashboard
 * details about how tagging works, and the metas dashboard
 * the tagger page
 * archiving channels of solved puzzles
 * the activity log channel
 * the admin channel
 * Google Meet integration

## Serving requirements

To set up this app, you'll need:
 * A Slack workspace
 * Your own new Slack app to configure and install in your workspace
 * A PostgreSQL database
 * A Javascript serving solution (I've successfully set this up with AWS Lambda and with Google App Engine)
 * A Google Cloud Platform service account for accessing the Google Drive and Calendar (for Google Meet creation) APIs

## Environment variables

Everything is configured using environment variables, and they need to be set for anything to work.

- **PORT**: The server HTTP port. The default is 3000.
- **APP_NAME**: The user-visible name of this deployment of this application.
- **WEB_SERVER_URL**: The publicly accessible URL for this server, with trailing slash.
  Used to build links.
- **HELP_URL**: A link to help instructions for how to use this.
- **SESSION_SECRET**: A secret string used to sign the session cookie to prevent tampering.
- **SLACK_TEAM_ID**: This is your Slack workspace Team ID (prefixed with T) which can be found in
  the Slack app URL.
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
  service account used to access the Google Drive API for managing spreadsheets and the Google
  Calendar API for creating Google Meets. You can create a service account for a GCP project
  [here](https://console.cloud.google.com/iam-admin/serviceaccounts). The Google Drive folder
  storing the spreadsheets should be shared with this account.
- **GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY**: This is the private_key associated with the Google
  Cloud Platform service account. It should be downloaded when you create the service account.
- **PGHOST**: The PostgreSQL database hostname.
- **PGPORT**: The PostgreSQL database port. The default is 5432.
- **PGUSER**: The PostgreSQL database username.
- **PGPASSWORD**: The PostgreSQL database password for the given user.
- **PGDATABASE**: The name of the PostgreSQL database to use.
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
- **PUZZLE_DRAWING_TEMPLATE_URL**: If set, a link to a Google Drawing that will be copied
  to create per-puzzle drawings. It should be in a folder editable by the Google Cloud
  Platform service account, and this folder is where the drawings will be created as well.
- **ENABLE_GOOGLE_MEET**: If set, creates a calendar event with a Google Meet entry point
  for each puzzle.
- **GOOGLE_MEET_CALENDAR_ID**: The Google Calendar ID of the calendar where per-puzzle events
  should be created. The Google service account must have permissions to make changes to
  this calendar.
- **AUTO_ARCHIVE**: If set, then puzzle channels will be automatically archived as they become
  solved.
- **ALLOW_RESET_DATABASE**: If set, then the admin page will have an option to reset the database.
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
- users:read.email

The following workspace events need to be added on the "Event Subscriptions" page in the "Your Apps"
section of https://api.slack.com/. The "Request URL" on the "Event Subscriptions" page should be set to
your web server URL plus "/slack/events".

- app_home_opened
- channel_archive
- channel_unarchive
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
