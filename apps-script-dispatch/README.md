# PHLO dispatch server

A small Google Apps Script web app that the PHLO page talks to for the driver app. It runs as the
yourphlo Google account and keeps everything in a **PHLO Dispatch** folder in that account's Drive:

- `routes-YYYY-MM-DD.json`: the routes sent for a day,
- `updates-YYYY-MM-DD.json`: what drivers recorded at each stop,
- `files-YYYY-MM-DD/`: delivery photos and signatures.

Driver logins (app username + scrambled PIN) are copied here from the Drivers tab automatically.

## One-time setup (about 5 minutes)

1. Signed in as **yourphlo@gmail.com**, open https://script.google.com and click **New project**.
   Name it "PHLO dispatch".
2. Replace the contents of `Code.gs` with `Server.gs` from this folder.
3. **Project Settings** (gear) > tick **Show "appsscript.json" manifest file in editor**. Open
   `appsscript.json` and replace it with the one in this folder.
4. **Deploy > New deployment** > type **Web app**:
   - Execute as: **Me (yourphlo@gmail.com)**
   - Who has access: **Anyone** (drivers don't have Google accounts on the app; the script checks
     their PIN, and only the yourphlo Google account can send routes or see everyone's deliveries)
5. Click **Deploy**, allow the permissions it asks for (Drive, to keep the files; connecting to
   Google, to check the office's Google sign-in), and copy the **Web app URL** (ends in `/exec`).
6. Put the URL in `web/config.js` as `dispatchUrl: '...'` and push.

Then open the page, sign in with Google, give each driver an **App PIN** on the Drivers tab, and the
Driver sign-in box appears on the start page.

## Updating

After changing `Server.gs`: **Deploy > Manage deployments** > edit (pencil) > **Version: New
version** > **Deploy**. The URL stays the same.

## Changing who can send routes

`ADMINS` at the top of `Server.gs` lists the Google accounts allowed to send routes and see every
driver's deliveries.
