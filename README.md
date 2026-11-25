# BrightDesk Student Portal

## Run locally

Install Node.js 18 or newer, then run these commands from this folder:

```powershell
npm start
```

Open <http://127.0.0.1:3000>. Create an account on the sign-in screen; passwords must be at least 10 characters. To use another port, set the `PORT` environment variable before starting the server.

Accounts and each account's portal data are stored in `.portal-data\users.json`. On the first account registration in a browser, any existing browser-saved timetable, attendance, routine, and student names are imported into that account. Keep the data file private and include it in your backup plan. Sessions expire after seven days and are cleared when the server restarts.

For a public deployment, use HTTPS and set `NODE_ENV=production` so session cookies are marked secure. The JSON file store is intended for a small local/student project, not a multi-process production deployment.
