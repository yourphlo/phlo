# PHLO dispatch server

A small Google Apps Script web app that the PHLO page talks to for the driver app. It runs as the
yourphlo Google account and keeps everything in a **PHLO Dispatch** folder in that account's Drive:

- `routes-YYYY-MM-DD.json`: the routes sent for a day,
- `updates-YYYY-MM-DD.json`: what drivers recorded at each stop,
- `files-YYYY-MM-DD/`: delivery photos and signatures,
- `texts-YYYY-MM-DD.json`: patients' mobile numbers, texts sent and received, approvals, messages to drivers,
- `patients.json`: each patient's mobile number and language, to fill them in next time.

Driver logins (app username + scrambled PIN) are copied here from the Drivers tab automatically.

## One-time setup (about 5 minutes)

1. Signed in as **yourphlo@gmail.com**, open https://script.google.com and click **New project**.
   Name it "PHLO dispatch".
2. Replace the contents of `Code.gs` with `Server.gs` from this folder. Add a second script file
   (**+ > Script**) named `Texts` and paste in `Texts.gs` from this folder.
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

## Patient texts (Twilio, about 20 minutes plus the wait for approval)

1. Make an account at https://www.twilio.com and buy a local phone number that can text (about $1.15 a
   month; texts are about a cent each, more for long or non-English texts).
2. **Register for business texting.** US carriers block texts from unregistered numbers. In Twilio:
   **Messaging > Regulatory compliance > A2P 10DLC**: register the business (brand) and a campaign
   ("Delivery notifications"). Approval usually takes a few days. (A toll-free number with toll-free
   verification works too.)
3. In the Apps Script project: **Project Settings > Script properties > Add**:
   `TWILIO_SID` (Account SID, starts with AC), `TWILIO_TOKEN` (Auth token) and `TWILIO_FROM` (the number,
   like `+16265550000`, or a Messaging Service SID starting with MG). They stay in the script, never in GitHub.
4. Deploy the new version (below) and allow the new permissions it asks for (sending email and running on a timer).
5. On the PHLO page: **Dispatch > Texting settings**. Copy the **Address for patients' replies** and paste
   it in Twilio: **Phone Numbers > your number > Messaging configuration > A message comes in: Webhook,
   HTTP POST**. Fill in each pharmacy's mobile and/or email and sign-in PIN and **Save** (saving also starts
   the 5-minute timer that sends the texts).
6. Try it: put your own mobile on a stop, send routes, and click **Text now** on that stop under Deliveries.

**HIPAA:** texts say only that a pharmacy delivery is on the way (no names or medications). Twilio signs a
BAA only on some plans, and a free gmail.com account has no BAA with Google. Check with your compliance
person before using it with patients.

## Updating

After changing `Server.gs` or `Texts.gs`: **Deploy > Manage deployments** > edit (pencil) > **Version: New
version** > **Deploy**. The URL stays the same.

## Changing who can send routes

`ADMINS` at the top of `Server.gs` lists the Google accounts allowed to send routes and see every
driver's deliveries.
