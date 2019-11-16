import * as db from "./db";
import { PoolClient } from "pg";

export interface Puzzle {
  id: number;
  name: string;
  url: string;
  solved: boolean;
  answer?: string;
}

export async function create(name: string, url: string): Promise<number> {
  const result = await db.query(
    "INSERT INTO puzzles (name, url) VALUES ($1, $2) RETURNING id",
    [name, url]);
  return result.rows[0].id;
}

export async function setAnswer(id: number, answer: string) {
  await db.query(
    "UPDATE puzzles SET answer = $2 WHERE id = $1",
    [id, answer]
  );
}

export async function setSolved(id: number, solved: boolean) {
  await db.query(
    "UPDATE puzzles SET solved = $2 WHERE id = $1",
    [id, solved]
  );
}

export async function list(): Promise<Array<Puzzle>> {
  const result = await db.query(
    "SELECT id, name, url, solved, answer FROM puzzles");
  return result.rows;
}

export async function get(id: number, client?: PoolClient): Promise<Puzzle> {
  const result = await db.query(
    "SELECT id, name, url, solved, answer FROM puzzles WHERE id = $1", [id], client);
  if (result.rowCount !== 1) {
    throw `Unexpected puzzle get result ${result}`;
  }
  return result.rows[0];
}