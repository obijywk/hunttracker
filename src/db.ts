import connectPgSimple from "connect-pg-simple";
import expressSession from "express-session";
import { readFile } from "fs";
import * as moment from "moment";
import { Client, Pool, PoolClient, QueryResult } from "pg";
import { promisify } from "util";

const maxIdleClients = 10;
const maxClientAge = moment.duration(10, "minutes");

interface TrackedClient {
  client: Client;
  lastActive: moment.Moment;
}

const idleClients: Array<TrackedClient> = [];

const logDatabaseClientUsage = process.env.LOG_DATABASE_CLIENT_USAGE !== undefined;

async function getClient() {
  const now = moment.utc();
  while (idleClients.length > 0) {
    const trackedClient = idleClients.shift();
    const age = now.diff(trackedClient.lastActive);
    if (age > maxClientAge.asMilliseconds()) {
      trackedClient.client.end().catch(e => console.error("Failed to end stale client", e));
    } else {
      if (logDatabaseClientUsage) {
        console.info("Reusing DB client with age (ms)", age);
      }
      return trackedClient.client;
    }
  }
  if (logDatabaseClientUsage) {
    console.info("Creating new DB client");
  }
  const client = new Client();
  client.on("error", e => console.error("Client error", e));
  await client.connect();
  return client;
}

function cacheClient(client: Client) {
  idleClients.push({
    client,
    lastActive: moment.utc(),
  });
  while (idleClients.length > maxIdleClients) {
    const trackedClient = idleClients.shift();
    trackedClient.client.end().catch(e => console.error("Failed to end oldest client", e));
  }
}

export async function connect(): Promise<Client & PoolClient> {
  const client: any = await getClient();
  client.release = () => cacheClient(client);
  const poolClient: Client & PoolClient = client;
  return poolClient;
}

export async function query(text: string, params: Array<any> = [], poolClient?: PoolClient) {
  if (poolClient) {
    return poolClient.query(text, params);
  }
  const client = await getClient();
  const result = await client.query(text, params);
  cacheClient(client);
  return result;
}

export const sessionStore = new (connectPgSimple(expressSession))({
  pool: {
    query: (text: string, params: Array<any>, cb?: (err: string, res?: QueryResult<any>) => void) => {
      if (cb) {
        query(text, params)
        .then(res => cb(null, res))
        .catch(err => cb(err));
      } else {
        return query(text, params);
      }
    },
  } as Pool,
  tableName: "sessions",
  ttl: moment.duration(7, "days").asSeconds(),
  pruneSessionInterval: false,
});

export async function applySchema() {
  console.log("Applying schema");

  let schema;
  try {
    schema = (await promisify(readFile)("schema.sql")).toString();
  } catch (e) {
    console.error("Failed to load schema", e);
    throw e;
  }

  const client = await connect();
  try {
    await client.query("BEGIN");
    await client.query(schema);
    await client.query("COMMIT");
  } catch (e) {
    console.error("Failed to apply schema", e);
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  console.log("Applied schema");
}

export async function applySchemaIfDatabaseNotInitialized() {
  const result = await query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_name = 'sessions'
    )
  `);
  if (result.rowCount === 0 || !result.rows[0].exists) {
    await applySchema();
    return true;
  }
  return false;
}
