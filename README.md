# Reelbot

A chatbot that turns your photos, video clips and voice notes into short videos. Photos and videos can come from your **phone's camera roll** (or files on a computer). You can record voice notes in the app or pick audio files. Photos can also come from **Google Photos** (optional).

1. You choose photos. On a phone, "From this device" opens the camera roll. Google Photos uses Google's own picker.
2. You tell Reelbot what you want ("a 30-second vertical reel of my trip, upbeat, with captions").
3. Claude looks at the photos and writes a storyboard: order, timing, Ken Burns motion, captions and title cards.
4. Your browser renders the storyboard to an MP4 (or WebM, depending on the browser) that you can preview, add a soundtrack to, and download.

Ask for changes in chat ("slower", "drop the third photo", "make it square") and Reelbot re-renders.

## Media and music

- **Photos** get slow pan and zoom ("Ken Burns") motion. **Video clips** play a part Claude chooses (`clip_start_s` + `duration_s`), with or without their own sound. **Voice notes** play from a chosen scene. Claude can't hear them, so it places them by length and asks you what they're about when that matters.
- To understand a clip, Claude sees a strip of three frames (start, middle and end), plus the clip's length and capture date (read from the MP4/MOV header).
- **Music:** three bundled tracks in `public/music/` (AAC, so they play on iPhone too), listed in `MUSIC_TRACKS` in `src/lib/plan.ts`. One is picked at random for each visit. Under the video you can preview them, switch, or turn music off. The music gets quieter under voice notes and clip sound, and fades out at the end.
- Everything is mixed in the browser with Web Audio and recorded together with the canvas, so the downloaded file has the sound in it. If the browser blocks sound (autoplay rules), the app says so and offers **Re-render**.

## How it works

| Piece | Where |
|---|---|
| Chat + tool loop (Claude Opus 5.5, streaming) | `src/app/api/chat/route.ts`, tools in `src/lib/tools.ts` |
| Camera-roll photos: EXIF capture date, previews for Claude (all in the browser) | `src/lib/device.ts` |
| Google OAuth, tokens in an encrypted httpOnly cookie (no database) | `src/lib/session.ts`, `src/app/api/auth/*` |
| Google Photos Picker API (sessions, picked items, photo download) | `src/lib/google.ts`, `src/app/api/photos/*` |
| Storyboard schema shared by server and browser | `src/lib/plan.ts` |
| Video renderer (canvas + MediaRecorder, optional audio) | `src/lib/render.ts`, `src/components/VideoPanel.tsx` |
| Chat UI | `src/components/Reelbot.tsx` |

Claude's tools are `ask_for_media`, `list_selected_media`, `view_media` (small previews, so Claude can see what is in each photo or clip), `create_video` (the storyboard) and `share_video`. Each tool input is checked with Zod before it runs.

**Camera-roll media stays on the phone unless you share a video.** The browser keeps the original files. When Claude asks to see media, the server hands the `view_media` call back to the browser. The browser makes ~384 px JPEG previews (a frame strip for videos) and sends them in the next request. Only metadata (size, length, capture date, file name) and those previews reach the server.

**Why the Google picker?** Since March 2025, Google only lets third-party apps read photos the user explicitly picks, through the [Google Photos Picker API](https://developers.google.com/photos/picker). The older Library API can no longer read a user's whole library. So Reelbot can't search all of your photos. It works with the ones you hand it.

**Why render in the browser?** Encoding video on the server needs ffmpeg and long-running compute, which doesn't suit serverless hosting. The browser draws each frame on a canvas and records it in real time, so a 30-second video takes about 30 seconds to render. Keep the tab in the foreground while it renders.

## Setup

The only thing you must have is a **Claude API key** (create one at <https://platform.claude.com>). With just that, the app works with camera-roll photos. Google Photos is optional: leave `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` empty and its button is hidden.

1. **Claude API key** → `ANTHROPIC_API_KEY`.
2. **(Optional) Google Cloud project** for Google Photos.
   - Enable the **Google Photos Picker API**.
   - Configure the OAuth consent screen and add the scope `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`. While the app is in "Testing", add yourself as a test user.
   - Create an **OAuth client ID** of type *Web application*. Add these authorized redirect URIs:
     - `http://localhost:3000/api/auth/google/callback`
     - `https://<your-domain>/api/auth/google/callback`
3. **Environment.** Copy `.env.example` to `.env.local` and fill it in (`openssl rand -base64 32` gives you a `SESSION_SECRET`).
4. Run it:

```bash
npm install
npm run dev   # http://localhost:3000
```

## Deploy to Vercel

1. Push this repo to GitHub and import it in Vercel.
2. Leave **Root Directory** as is (the app is at the top of the repo). Vercel detects Next.js automatically.
3. Add the environment variables from `.env.example`. Camera-roll only: `ANTHROPIC_API_KEY` is enough. For Google Photos, also set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, and `APP_URL` (your production URL, for example `https://reelbot.vercel.app`).
4. If you use Google Photos, add `https://<that-domain>/api/auth/google/callback` to the OAuth client's redirect URIs. To let people other than your test users sign in, publish the OAuth consent screen in Google Cloud. Google may ask for verification for this scope.

The chat route sets `maxDuration = 300`. On Vercel plans with a lower function limit, the platform caps it.

## Share by text message

Under a finished video, **Share by text message** (or just tell the chatbot "send it to Mom, +1 555 123 4567") texts the person a link to the video. When they reply to that text, their reply is added to the video as a quote card. Claude places it next to the moment they're talking about, or at the end if it's about the whole video. Everyone with the link sees the updated video. The page plays the video live and refreshes itself every few seconds, and anyone can save it as an MP4.

How it works:
- Sharing uploads the video's media to Vercel Blob. Photos are resized to 1920 px and go through the app. Video clips and voice notes upload straight from the browser to Blob using a short-lived client token (`/api/shares/upload-token`, passcode-checked), up to 200 MB each. The share page downloads them before playing. The storyboard, the recipients and the reactions are stored in Upstash Redis. Links look like `/s/<random id>`, and phone numbers are never shown on the page.
- Twilio sends the text. Replies come in at `/api/sms/inbound`, which checks Twilio's signature. STOP/HELP keywords are left to Twilio, and a reply is matched to the latest video texted to that number.
- Sending needs the `SHARE_PASSCODE`, and there's a cap of 50 texts per day, so a public deployment can't be used to spam people.

Setup:
1. **Vercel storage.** In your Vercel project: **Storage → Create → Blob**, then **Storage → Create → Upstash (Redis)**. Connect both to the project; this adds their environment variables for you.
2. **Twilio.** Create an account at twilio.com and buy a phone number that can send SMS. Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` (in +1… format) to Vercel.
3. In the Twilio console, open **Phone Numbers → your number → Messaging**. Under "A message comes in", choose **Webhook**, `https://<your-domain>/api/sms/inbound`, **HTTP POST**.
4. Add `SHARE_PASSCODE` (any secret phrase) and `APP_URL` (`https://<your-domain>`, exactly as in the webhook URL), then redeploy.

US texting rules: carriers block texts from unregistered numbers. Before texting US numbers, register for **A2P 10DLC** in the Twilio console (or use a toll-free number and complete toll-free verification). Approval can take a few days. A Twilio trial account can only text numbers you've verified, and adds a "Sent from your Twilio trial account" prefix. That's fine for trying it out.

## Notes and limits

- A picker session and its photo URLs expire after roughly an hour. If rendering fails with a 403, pick the photos again.
- Up to 100 photos per pick, and up to 36 previews shown to Claude per conversation. Previews keep the request under Vercel's 4.5 MB body limit, because the browser resends the conversation on every message.
- Videos in the selection are skipped. Only photos are used.
- iPhone photos (HEIC) work on iPhone, where Safari converts them when you pick. Desktop Chrome can't open HEIC files, so those are skipped with a notice.
- On phones, keep the screen on and the browser in front while the video renders.
- Claude refusals are handled with the server-side fallback (`fallbacks: "default"`).
