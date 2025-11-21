import { google, people_v1 } from "googleapis";
import { GaxiosResponse } from "googleapis-common";

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  scopes: [
    "https://www.googleapis.com/auth/contacts",
  ],
});

const people = google.people({ version: "v1", auth: auth });

export interface GooglePerson {
  resourceName?: string;
  name: string;
  email: string;
}

export async function getPeopleByResourceNames(resourceNames: Array<string>): Promise<Array<GooglePerson>> {
  if (resourceNames.length === 0) {
    return [];
  }
  const response = await people.people.getBatchGet({
    resourceNames,
    personFields: "emailAddresses,names",
  });
  const results: Array<GooglePerson> = [];
  if (response.data.responses) {
    for (const r of response.data.responses) {
      if (!r.person.emailAddresses || r.person.emailAddresses.length === 0) {
        continue;
      }
      results.push({
        resourceName: r.person.resourceName,
        name: r.person.names && r.person.names.length > 0 ? r.person.names[0].displayName : undefined,
        email: r.person.emailAddresses[0].value,
      });
    }
  }
  return results;
}

export async function getAllPeople(): Promise<Array<GooglePerson>> {
  const results: Array<GooglePerson> = [];
  let pageToken = undefined;
  do {
    const response: GaxiosResponse<people_v1.Schema$ListConnectionsResponse> = await people.people.connections.list({
      resourceName: "people/me",
      personFields: "emailAddresses,names",
      pageSize: 1000,
      pageToken,
    });
    if (response.data.connections) {
      for (const connection of response.data.connections) {
        if (!connection.names || connection.names.length === 0 ||
          !connection.emailAddresses || connection.emailAddresses.length === 0) {
          continue;
        }
        results.push({
          resourceName: connection.resourceName,
          name: connection.names[0].displayName,
          email: connection.emailAddresses[0].value,
        });
      }
    }
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  return results;
}

export async function createPeople(googlePersons: Array<GooglePerson>): Promise<void> {
  if (googlePersons.length === 0) {
    return;
  }
  if (googlePersons.length > 200) {
    throw ">200 people in createPeople request, time to implement partitioning for this call";
  }
  const contacts: Array<people_v1.Schema$ContactToCreate> = [];
  const emailToGooglePerson: { [key: string]: GooglePerson } = {};
  for (const googlePerson of googlePersons) {
    if (!googlePerson.email || googlePerson.email.length === 0) {
      continue;
    }
    emailToGooglePerson[googlePerson.email] = googlePerson;
    contacts.push({
      contactPerson: {
        names: [
          {
            unstructuredName: googlePerson.name,
          },
        ],
        emailAddresses: [
          {
            value: googlePerson.email,
          },
        ],
      },
    });
  }
  const response = await people.people.batchCreateContacts({
    requestBody: {
      contacts,
      readMask: "emailAddresses,names",
    },
  });
  if (response.data.createdPeople) {
    for (const createdPerson of response.data.createdPeople) {
      if (!createdPerson.person.emailAddresses || createdPerson.person.emailAddresses.length === 0) {
        continue;
      }
      const email = createdPerson.person.emailAddresses[0].value;
      const googlePerson = emailToGooglePerson[email];
      if (googlePerson) {
        googlePerson.resourceName = createdPerson.person.resourceName;
      }
    }
  }
}

export async function deleteAllPeople(): Promise<void> {
  const response: GaxiosResponse<people_v1.Schema$ListConnectionsResponse> = await people.people.connections.list({
    resourceName: "people/me",
    personFields: "emailAddresses,names",
    pageSize: 1000,
  });
  const resourceNames = [];
  for (const connection of response.data.connections) {
    resourceNames.push(connection.resourceName);
  }
  await people.people.batchDeleteContacts({
    requestBody: {
      resourceNames,
    },
  });
}
