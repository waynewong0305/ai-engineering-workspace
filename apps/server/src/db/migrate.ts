import { createDatabase } from "./database.js";

const { sqlite } = createDatabase();
sqlite.close();
console.info("Database migrations applied.");

