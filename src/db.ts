import connectPgSimple from "connect-pg-simple";
import expressSession from "express-session";
import { readFile } from "fs";
import moment = require("moment");
import { Pool, PoolClient } from "pg";
import { promisify } from "util";

const pool = new Pool({
  idleTimeoutMillis: 300000,
});

pool.on("connect", client => {
  client.on("error", err => {
    console.error("Client error", err);
  });
});

pool.on("error", (err, client) => {
  console.error("Unexpected error on idle client", err);
});

export const sessionStore = new (connectPgSimple(expressSession))({
  pool,
  tableName: "sessions",
  ttl: moment.duration(7, "days").asSeconds(),
  pruneSessionInterval: false,
});

export function connect() {
  return pool.connect();
}

export function query(text: string, params: Array<any> = [], client?: PoolClient) {
  if (client) {
    return client.query(text, params);
  }
  return pool.query(text, params);
}

export async function applySchema() {
  console.log("Applying schema");

  let schema;
  try {
    schema = (await promisify(readFile)("schema.sql")).toString();
  } catch (e) {
    console.error("Failed to load schema", e);
    throw e;
  }

  const client = await pool.connect();
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
  const result = await pool.query(`
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
