import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema.ts";

const sqlite = new Database("./db/sqlite.db");
export const db = drizzle(sqlite, { schema });
