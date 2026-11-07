/** `npm run inspect -- <db>`: print the honest receptionist's inbox, llm_calls, bookings and outbound. */
import { inspectDb } from '../src/honest/inspect.js';

const path = process.argv[2];
if (!path) {
  console.error('Usage: npm run inspect -- <path to the SQLite file>');
  process.exit(1);
}
console.log(inspectDb(path));
