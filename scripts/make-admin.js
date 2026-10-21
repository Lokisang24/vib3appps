'use strict';
// Usage: npm run make-admin -- <username>        (add --remove to take the role away)
// Works on the database directly, so it also works if you are locked out of the site.
require('dotenv').config();
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const name = process.argv[2];
const remove = process.argv.includes('--remove');
if (!name || name.startsWith('--')) { console.error('Usage: npm run make-admin -- <username> [--remove]'); process.exit(1); }
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'novastream.db'));
const user = db.prepare('SELECT id, username, role FROM users WHERE username = ? COLLATE NOCASE').get(name);
if (!user) { console.error(`No account called "${name}". Sign up on the site first, then run this again.`); process.exit(1); }
db.prepare('UPDATE users SET role = ? WHERE id = ?').run(remove ? 'user' : 'admin', user.id);
console.log(`${user.username} is now ${remove ? 'a normal user' : 'an admin'}. They may need to log in again.`);
