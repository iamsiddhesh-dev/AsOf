import { config } from "../config.js";
import { openDatabase } from "./index.js";
import { migrate } from "./migrate.js";

const db = openDatabase(config.databasePath);

try {
  const applied = migrate(db);
  if (applied.length === 0) {
    console.log("database is up to date");
  } else {
    console.log(`applied migrations: ${applied.join(", ")}`);
  }
  console.log(`database: ${config.databasePath}`);
} finally {
  db.close();
}
