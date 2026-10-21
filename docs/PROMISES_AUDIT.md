# NovaStream: what the app promised and what it actually did

This audit lists every place where the app, its README or its screens said something that was not true, or only half true. Each item says what happened before this update, how it works now, and which automated test proves it. Tests are in `tests/promises.js` (177 checks), `tests/e2e.py` and `tests/responsive.py`.

Before changing anything, 18 of these were confirmed by running the old app against a probe script. The rest were confirmed by reading the code.

## A. Safety and moderation

| # | The promise | What really happened | Now |
|---|---|---|---|
| 1 | "Reported. Thank you." | Reports were saved to a table that nobody could read. Chat reports were visible only to the channel owner. Post reports were visible to nobody. | Admin report queue with filters. Urgent reports (self-harm, under-age) come first. Admins can dismiss, warn, delete the content, suspend or ban. |
| 2 | A report means something | Every report said "chat report" or "feed report". Nobody chose a reason. | A report dialog with 9 reasons, an optional note, and an emergency-services hint for self-harm reports. |
| 3 | You can report problems | You could not report a profile, a Circle, a comment or a stream. | All six kinds can be reported. Duplicates within 24 hours are merged. |
| 4 | Reporting helps | The person who reported never heard back. | They get a notification when the report is handled. Handling one report closes duplicates about the same thing. |
| 5 | "Under-18 accounts get extra safety defaults" | The flag existed and did nothing. | No profile links, not listed in people search (exact username still works), bio, interests and channel text hidden from logged-out visitors, quiet hours 22:00-07:00 by default. Age is checked at every login, so protections end on the 18th birthday. |
| 6 | "Chat word filter" | The list shipped empty, so nothing was masked. | A starter list of common profanity, plus a list admins manage live. Streamers add their own words per channel. |
| 7 | The filter protects chat | It matched inside words, so blocking "ass" would have masked "class". | Whole-word, case-insensitive matching. |
| 8 | "Block" | A blocked person could still comment, react, repost, follow, and send you notifications. It only hid their chat lines on your screen. | Blocked people cannot comment, react, repost or follow, and cannot notify you. |
| 9 | Circle moderators | Owners and moderators could not remove or ban a disruptive member. | Remove, or remove and ban. Moderators cannot remove other moderators or the owner. |
| 10 | Staff are trustworthy | Anyone could register as "admin", "support" or "novastream_team". | Staff-like usernames are reserved. |
| 11 | "Verified creators" (original brief) | Nothing existed. | Admins can give a tick. The Community Guidelines say what it does and does not mean. |

## B. Accounts

| # | The promise | What really happened | Now |
|---|---|---|---|
| 12 | Account control | No way to change your password. | Account settings: change password (needs the current one). |
| 13 | "Account deletion" (original brief) | No way to leave. | Delete your account. Posts, comments, follows and notifications are removed. Circles you own pass to a member. |
| 14 | "Data export" (original brief) | None. | Download everything NovaStream holds about you as a file. The export never contains the password hash. |
| 15 | "Session management" (original brief) | Logins lasted 30 days and could not be revoked. | Changing your password, "log out of all devices", or an admin action ends every session immediately. |
| 16 | Forgotten passwords | No recovery at all. | Admin-issued one-time recovery code (24 hours, single use). See limits below. |
| 17 | Rules can be enforced | No suspend or ban. | Suspend for 1 hour to a year, or ban. Live connections are cut, streams end, and the person sees the reason at login. |
| 18 | "Handling appeals" (original brief) | None. | A suspended or banned person can appeal from the login page. Admins approve or reject with a reply. |
| 19 | "Tracking repeated violations" (original brief) | None. | Every warning, suspension, removal and appeal is kept on the account's history. |
| 20 | Clear rules | No Community Guidelines, Terms or Privacy Policy. Sign-up asked for no agreement. | Three editable pages, linked in the footer, with a required checkbox at sign-up. They are plain-language templates, see limits. |
| 21 | Roles | Everyone was equal, so nobody could run the site. | An admin role, set with `ADMIN_USERNAMES` or `npm run make-admin`. Admins cannot suspend, ban or delete each other or themselves. |

## C. Running the site

| # | The promise | What really happened | Now |
|---|---|---|---|
| 22 | A site you can manage | No admin area. | Admin area: Overview, Reports, Users, Appeals, Live streams, Content, Word filter, Site settings, Legal pages, Backups, Audit log. |
| 23 | "Monitoring" (original brief) | Only `/healthz` saying "ok". | Overview shows people, new sign-ups, live streams, open reports, uptime, memory, database size, recent server errors, and warnings about risky settings. |
| 24 | Settings | Every change meant editing `.env` and restarting. | Registration, maintenance mode, announcement banner, room size, anti-bot account age and post cooldown change live. |
| 25 | Stream rules | Admins could not stop a stream. | End any live stream with a reason. The streamer is told. |
| 26 | Content rules | Admins could not remove posts, comments or Circles. | Search and delete from the Content tab or straight from a report. |
| 27 | "Database backups" (original brief) | README said "back up the volume yourself". | A backup every 24 hours (newest 7 kept), a "Back up now" button, and downloads. Restoring is a documented manual step on purpose. |
| 28 | Accountability | No record of who did what. | Audit log of every admin action. |
| 29 | Talking to everyone | No way to announce anything. | Announcement banner with three styles, and a read-only maintenance mode that still lets people log in and browse. |
| 30 | Word list | Only editable in `.env`. | Managed in the admin page. |

## D. Hollow promises inside the product

| # | The promise | What really happened | Now |
|---|---|---|---|
| 31 | "Event reminders" (a notification setting) | Members were told once when an event was created. Nothing came before it started. | People who RSVP, and the organiser, get a reminder when an event is under an hour away. Sent once. |
| 32 | "Reactions from brand-new accounts are ignored" | The anti-bot age defaulted to 0, so it ignored nobody. | The wording now states the real rule, only mentions it when it is on, and the admin Overview warns when it is off. Turn it on in Site settings (60 minutes recommended). |
| 33 | "Clear error notifications" (original brief) | Rate limits and server errors showed "Something went wrong". | Readable messages everywhere. |
| 34 | Signing out | A revoked or suspended session produced confusing failures. | The app signs out cleanly and says why. |

## E. Promised in the original brief, still not built, and what each needs

None of these are claimed anywhere on the site.

| What | Why not | What it needs |
|---|---|---|
| Donations, memberships, gifts, payouts | Real money | A payment provider, a registered business, fee and refund policies, tax and legal review (especially with teen users) |
| Replays, clips, quality selection, adaptive streaming, big audiences | Video is peer-to-peer | A media server such as LiveKit |
| Multistreaming to other platforms | Depends on their rules | Each platform's API and approval |
| Email verification and emailed password reset | No email service | An email provider. Until then, recovery uses admin-issued codes |
| Push notifications when the site is closed | Browser-only alerts today | A push service and the Android app |
| Images and short videos in posts | Needs upload scanning | Storage and moderation tooling |
| Circle polls, watch parties, language and location preferences, friend connections, scheduled broadcasts | Not built | Future work |
| Verified-identity process | The tick exists, the checking does not | A real process for confirming who someone is |

## Limits of what is delivered

1. **Admins have no two-factor login yet.** Give admin accounts long, unique passwords.
2. **`ADMIN_USERNAMES` promotes whoever registers that name.** Register your admin account first, straight after setting it, or use `npm run make-admin`.
3. **Recovery codes depend on an admin checking it is really the person.** That is a human step.
4. **The legal pages are templates, not legal advice.** Have a lawyer review them for your country, add a contact email, and check child-privacy rules (COPPA, GDPR) before opening to teens.
5. **Moderation needs people.** The queue and tools exist. Someone has to read the queue.
6. **Not tested on a real Android phone.** The web app is tested at phone sizes. The Capacitor build needs Android Studio on your side.
