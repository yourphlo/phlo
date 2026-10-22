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

## Patient texts (Quo, about 20 minutes plus the wait for approval)

PHLO texts through [Quo](https://www.quo.com) (formerly OpenPhone).

1. Make a Quo account with a local number that can text. API texts cost $0.01 per segment and come out of
   prepaid credits: in Quo, **Settings > Billing**, add credits (and turn on auto-recharge so texts don't
   stop when they run out).
2. **Register for business texting.** US carriers block texts from unregistered numbers. In Quo's
   settings, find **US carrier registration** (A2P 10DLC) and register the business. Approval
   usually takes a few days. Until it is approved, Quo refuses the texts and each stop shows why.
3. Make an API key: in Quo's settings, **API > Generate API key** (Owner or Admin only).
4. In the Apps Script project: **Project Settings > Script properties > Add**:
   `QUO_API_KEY` (the key) and `QUO_FROM` (your Quo number, like `+16265550000`, or its Quo id starting
   with PN). They stay in the script, never in GitHub.
5. Deploy the new version (below) and allow the new permissions it asks for (sending email and running on a timer).
6. On the PHLO page: **Dispatch > Texting settings**. Copy the **Address for patients' replies**. In Quo:
   **Settings > Webhooks > Create webhook**, paste the address, pick the event **message.received** and
   your PHLO number, and save. Fill in each pharmacy's mobile and/or email and sign-in PIN and **Save**
   (saving also starts the 5-minute timer that sends the texts).
7. Try it: put your own mobile on a stop, send routes, and click **Text now** on that stop under Deliveries.
   Then text "4" back from your phone and check that the stop shows your reply.

Moving from Twilio: the old `TWILIO_*` script properties are no longer used; you can delete them. Turn off
the "A message comes in" webhook on the Twilio number (or release the number) once Quo works.

Each reply from a patient is handled once, even if Quo sends it again (Quo resends when it is not sure the
script got it).

**HIPAA:** texts say only that a pharmacy delivery is on the way (no names or medications). Quo signs a
BAA only on the Business and Scale plans, and its BAA leaves out "third-party integrations or connected
services", so ask Quo whether texts sent through the API are covered. A free gmail.com account has no BAA
with Google. Check with your compliance person before using it with patients.

## Updating

After changing `Server.gs` or `Texts.gs`: **Deploy > Manage deployments** > edit (pencil) > **Version: New
version** > **Deploy**. The URL stays the same.

## Changing who can send routes

`ADMINS` at the top of `Server.gs` lists the Google accounts allowed to send routes and see every
driver's deliveries.
