# BrightDesk Student Portal

## Requirements

- Node.js 20 or newer
- MySQL 8.0 or newer, running locally or on a trusted network

## Configure MySQL

Create a database and an application user with access only to that database. For example, run the following in a MySQL administrative session, replacing the sample password with a strong private value:

```sql
CREATE DATABASE brightdesk_portal CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'brightdesk_app'@'127.0.0.1' IDENTIFIED BY 'replace-with-a-private-password';
GRANT SELECT, INSERT, UPDATE, CREATE ON brightdesk_portal.* TO 'brightdesk_app'@'127.0.0.1';
```

Copy `.env.example` to `.env` and set `DB_USER`, `DB_PASSWORD`, and `DB_NAME`. Keep `.env` private; it is excluded from Git. `DB_HOST` and `DB_PORT` default to `127.0.0.1` and `3306`.

## Run locally

Install the Node.js dependencies and start the portal:

```powershell
npm install
npm start
```

Open <http://127.0.0.1:3000> and choose Student or Teacher login. Student usernames are their roll numbers; teachers use a username. New accounts can be created from the matching login page. To use another port, set the `PORT` environment variable before starting the server.

The server creates its required portal tables on startup. If `.portal-data\users.json` exists, its valid accounts and portal data are imported into MySQL without replacing existing database accounts. Keep the legacy file private until you have verified the migration and backed up your database. Sessions expire after seven days and are cleared when the server restarts.

## Student and teacher accounts

Set `BOOTSTRAP_TEACHER_USERNAME` and `BOOTSTRAP_TEACHER_PASSWORD` in `.env` to create an initial teacher login. Keep `.env` private and never commit real passwords. Teacher self-registration is also enabled from the Teacher login page. Students use their roll number as their login ID and can choose a password when creating an account. Passwords are stored as salted scrypt hashes.

## Portal pages

The portal UI includes Home, Students, Attendance, Assignments, Teachers, Events, and My Account. Teachers manage attendance and assignments; students can view their attendance and submit assignment files before the deadline. Teachers can assign events to selected students and see who viewed or completed them.

For a public deployment, use HTTPS and set `NODE_ENV=production` so session cookies are marked secure. Use a dedicated, least-privilege database user and keep database credentials out of source control.
