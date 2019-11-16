import { readFile } from "fs";
import { Pool, PoolClient } from "pg";
import { promisify } from "util";

const pool = new Pool();

pool.on("error", (err, client) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
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
}