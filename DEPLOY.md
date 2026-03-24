# Lead Intercept — Deployment Guide
## Getting this live at yourdomain.com in ~15 minutes

---

### What you need before starting
- Your domain registrar login (GoDaddy, Namecheap, Google Domains, etc.)
- A free GitHub account — github.com (takes 2 minutes to create if you don't have one)
- Your Anthropic API key — get one at console.anthropic.com if you don't have it yet

---

## STEP 1 — Upload the code to GitHub (5 min)

GitHub is just a place to store your code. Railway will pull from it automatically.

1. Go to github.com and sign in
2. Click the "+" icon top right → "New repository"
3. Name it: lead-intercept
4. Set it to Private
5. Click "Create repository"
6. On the next screen, click "uploading an existing file"
7. Drag and drop ALL THREE files from this folder:
   - server.js
   - package.json
   - public/index.html  ← make sure to put this in a folder called "public"
8. Click "Commit changes"

To create the public folder on GitHub:
- When uploading index.html, type the filename as:  public/index.html
- GitHub will automatically create the folder

---

## STEP 2 — Deploy on Railway (5 min)

Railway is a free hosting platform. Your API key stays here, never in the code.

1. Go to railway.app
2. Click "Start a New Project"
3. Choose "Deploy from GitHub repo"
4. Connect your GitHub account when prompted
5. Select your "lead-intercept" repository
6. Railway will detect it's a Node app and deploy automatically

**Add your API key (critical):**
7. In your Railway project, click your service → "Variables" tab
8. Click "New Variable"
9. Name:  ANTHROPIC_API_KEY
10. Value: your Anthropic API key (starts with sk-ant-...)
11. Click Add — Railway will redeploy automatically

**Get your Railway URL:**
12. Click "Settings" → "Networking" → "Generate Domain"
13. You'll get something like:  lead-intercept-production.up.railway.app
14. Test it — open that URL in your browser, the app should load

---

## STEP 3 — Point your domain at Railway (5 min)

This makes yourdomain.com show the app instead of the Railway URL.

**In Railway:**
1. Settings → Networking → "Custom Domain"
2. Type your domain:  yourdomain.com
3. Railway will show you a CNAME value to copy — looks like:
   lead-intercept-production.up.railway.app

**In your domain registrar (GoDaddy / Namecheap / etc.):**
4. Log in → find DNS Settings for your domain
5. Look for an existing "A record" or "CNAME" for @ (root domain)
6. Delete or edit it, and add a new CNAME record:
   - Type:  CNAME
   - Name:  @  (or leave blank — means root domain)
   - Value: [paste the Railway value from step 3]
   - TTL:   3600 (or default)
7. Save

**Wait 5–30 minutes** for DNS to propagate. Then visit yourdomain.com — the app will load.

---

## STEP 4 — Lock it down (optional but recommended)

Right now anyone who finds your URL can use the app. To password protect it:

In Railway → Variables, add:
- Name:   APP_PASSWORD
- Value:  [pick a password]

Then let me know and I'll add a simple login screen to the app.

---

## Ongoing costs

| Item | Cost |
|------|------|
| Railway hosting | Free up to $5/month usage (plenty for this) |
| Anthropic API | ~$0.01–0.05 per full lead conversation |
| Your domain | Whatever you already pay |

For 100 leads/month: roughly $1–5 in API costs total.

---

## Troubleshooting

**App loads but simulator gives an error:**
- Check Railway → your service → "Logs" tab for the exact error
- Most likely: ANTHROPIC_API_KEY variable wasn't saved correctly

**Domain not working after 30 min:**
- Double-check the CNAME record — the Name field should be @ not www
- Some registrars don't allow CNAME on root domain — if so, use an "ALIAS" or "ANAME" record instead (same value)

**Railway says build failed:**
- Make sure package.json and server.js are in the ROOT of the repo, not inside a subfolder
- public/index.html should be one level down inside a folder called "public"

---

Questions? The file structure should look exactly like this in GitHub:

lead-intercept/
├── server.js
├── package.json
└── public/
    └── index.html
