import { google } from "googleapis";
import moment = require("moment");
import * as users from "./users";
import { v4 as uuidv4 } from "uuid";

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  scopes: [
    "https://www.googleapis.com/auth/calendar",
  ],
});

const calendar = google.calendar({version: "v3", auth: auth});

export interface Event {
  eventId: string;
  googleMeetUrl: string;
}

function getCalendarId() {
  const calendarId = process.env.GOOGLE_MEET_CALENDAR_ID;
  return calendarId.length > 0 ? calendarId : "primary";
}

export async function createEvent(name: string): Promise<Event> {
  try {
    const event = await calendar.events.insert({
      calendarId: getCalendarId(),
      conferenceDataVersion: 1,
      requestBody: {
        summary: name,
        start: {
          dateTime: moment().subtract(10, "m").format("YYYY-MM-DDTHH:mm:ss"),
          timeZone: "UTC",
        },
        end: {
          dateTime: moment().add(1, "M").format("YYYY-MM-DDTHH:mm:ss"),
          timeZone: "UTC",
        },
        reminders: {
          useDefault: false,
          overrides: [],
        },
        conferenceData: {
          createRequest: {
            requestId: uuidv4(),
          },
        },
      },
    });
    if (event.data.conferenceData.entryPoints.length === 0) {
      throw "Failed to create Google calendar event with conference entry point";
    }
    return {
      eventId: event.data.id,
      googleMeetUrl: event.data.conferenceData.entryPoints[0].uri,
    };
  } catch (e) {
    console.error("calendar.events.insert failed", e);
    if (e.response && e.response.errors) {
      for (const error of e.response.errors) {
        console.log(error);
      }
    }
    throw e;
  }
}

export async function updateEventUsers(eventId: string, users: Array<users.User>): Promise<void> {
  const attendees = users.map(user => ({ email: user.email }));
  try {
    await calendar.events.patch({
      calendarId: getCalendarId(),
      eventId,
      requestBody: {
        attendees,
      },
    });
  } catch (e) {
    console.error("calendar.events.patch failed", e);
    throw e;
  }
}