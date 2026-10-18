# Cloudflare setup

One-time setup, all on Cloudflare's free plans. About 15 minutes. You only need a browser.

## 1. Create the database

1. Sign up or log in at <https://dash.cloudflare.com>.
2. Go to **Storage & Databases → D1 SQL Database → Create**.
3. Name it `piggybank` and create it. The app creates its tables on first use.

## 2. Create the Pages project

1. Go to **Workers & Pages → Create** and choose **Pages → Connect to Git**. The create screen opens on Workers by default;
   Pages is behind the "Looking to deploy Pages? Get started" link at the bottom. Don't import the repo as a Worker:
   this project is built for Pages, and a Worker build fails (it shows up as a red "Workers Builds" check on GitHub).
2. Authorise GitHub and pick **mario462/piggybank**.
3. Build settings:
   - Production branch: `main`
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `public`
4. Optional: under **Environment variables** add `SKIP_DEPENDENCY_INSTALL` = `1` (the site needs no build, so this skips installing test tools).
5. **Save and Deploy**. Note the address it gives you, e.g. `https://piggybank-xyz.pages.dev`.

## 3. Connect the database

1. Open the Pages project → **Settings → Bindings → Add → D1 database**.
2. Variable name: `DB`. Database: `piggybank`. Save.

## 4. Lock it to you with Cloudflare Access

1. In the dashboard sidebar open **Zero Trust**. The first time, pick a team name and the **Free** plan
   (it may ask for a card; the Free plan costs $0). Your team domain will be `<team-name>.cloudflareaccess.com`.
2. Go to **Access → Applications → Add an application → Self-hosted**.
3. Application name: `Piggy`. Session duration: **1 month** (so the phone rarely asks you to sign in).
4. Application domain: add it as a **Public hostname** (not a private IP/hostname) with your Pages address,
   e.g. `piggybank-xyz.pages.dev`. Add a second public hostname `*.piggybank-xyz.pages.dev` so preview deployments are locked too.
5. Login method: **One-time PIN** (works best inside the home-screen app).
6. Add a policy: name `Me`, action **Allow**, include **Emails** → your email address.
7. Leave every **Browser Isolation** option off (in the experience or advanced settings: "Isolate application" and any
   "access through Clientless Web Isolation / isolation launcher URL" toggle). They only work for private destinations, and with
   one on the save fails with `use_clientless_isolation_app_launcher_url can only be enabled for apps with private destinations`.
   Showing the app in the App Launcher is fine either way.
8. Save the application, open it again and copy the **Application Audience (AUD) Tag**.

## 5. Tell the app about Access

Pages project → **Settings → Variables and Secrets** → add these for **Production** (and Preview):

| Name | Value |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `<team-name>.cloudflareaccess.com` |
| `ACCESS_AUD` | the AUD tag from step 4.8 |
| `ALLOWED_EMAILS` | your email address |

Then **Deployments → latest → Retry deployment** so the new settings apply.

Until these are set, the API refuses every request ("Server not set up"), so nothing is ever exposed by accident.

## 6. Install on the iPhone

1. Open your Pages address in **Safari** and sign in with the emailed code.
2. **Share → Add to Home Screen**. Open Piggy from the home screen from now on.

## How the security works

- Access sits in front of the whole site: nobody reaches the page or the API without signing in as an allowed email.
- The API also verifies the Access token on every request (signature, app audience, team, expiry, email) and fails closed if Access is not configured.
- Writes need a custom header, which blocks cross-site request forgery.
- Strict security headers (CSP, no framing, no referrer) are set in `public/_headers`.
- No secrets live in the repository; all settings are in Cloudflare.
