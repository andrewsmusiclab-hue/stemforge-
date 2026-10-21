# ⚠️ AGENT STANDING RULES — READ BEFORE EVERY ACTION

## 🚫 RULE #1 — NEVER DEPLOY TO LIVE WITHOUT EXPLICIT PERMISSION

**DO NOT** run `wrangler pages deploy` or any command that pushes to the live site
(`stemforge.studio` / project `stemforge`) UNLESS the user says one of these exact phrases in that message:

- "deploy to live"
- "push to production"
- "deploy to stemforge.studio"
- "go live"

**Saying "build it", "fix it", "test it", "let me see it" does NOT count as permission to deploy live.**

When in doubt → build only, start a local preview, share the preview URL. Ask first.

## ✅ Default behaviour for ALL code changes

1. Edit files
2. `npm run build`
3. Start local preview with PM2 / wrangler pages dev
4. Share the **preview URL only**
5. Wait for user to say "deploy to live" before touching the live site

## 📋 Project quick-reference

- **Live site**: `stemforge.studio`
- **Wrangler project name**: `stemforge`
- **Deploy command (ONLY when authorised)**: `npx wrangler pages deploy dist --project-name stemforge`
- **D1 database**: `andrew-pryce-db` (binding `DB`, id `ffd0c782-4ccc-42c2-9f35-4c577105516b`)
- **Admin email**: `andrewsmusiclab@gmail.com`
- **Active JS file**: `public/static/app.v2.70.js`
- **Git remote**: `https://github.com/andrewsmusiclab-hue/stemforge-.git` (token injected at push time — do not hardcode here)
- **STRICT**: Never mention "MusicAPI" in any user-facing text

## 🔒 This file must be read at the start of every session.
