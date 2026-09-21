# The Genesis — Quantum University Innovation Council

A dark-mode, electric-blue + emerald web app for the council hub, featuring a full
**Check-In / Check-Out management system** for students, faculty, startup founders and guests.

## Run it

Any static file server works. From this folder:

```bash
python3 -m http.server 8080 --bind 0.0.0.0
# then open http://localhost:8080
```

No build step. Tailwind CSS + fonts load via CDN; everything else is local.

## Pages

| Page | File | What it does |
|---|---|---|
| Home | `index.html` | Council overview, **live hub occupancy**, today stats, hourly sparkline, quick nav |
| Check-In Portal | `checkin.html` | Unique-ID check-in/out (Roll No / Employee ID / Startup ID / Guest ID), returning-visitor autofill, duplicate blocking, success pass |
| Kiosk Mode | `kiosk.html` | Full-screen entrance display; **rotating QR** (2-min token) for touchless mobile check-in, live clock + occupancy, recent check-in feed |
| Admin Dashboard | `admin.html` | Passcode gate · real-time active visitor table · purpose donut · peak-hour chart · role mix · filters (date/purpose/role/status/search) · **CSV export** · override tools |

**Admin passcode:** `QUIC-ADMIN` (change the `ADMIN_PW` constant in `admin.html`).

## Core mechanics

- **Unique ID system** — every log entry carries the visitor UID *and* a generated
  `LOG-<date>-<code>` entry ID. Duplicate *active* sessions per UID are rejected.
  Guests with no ID get an auto-minted `GST-XXXXXXXX` ID.
- **7:00 PM IST auto check-out** — `Genesis.sweep()` in `js/genesis.js` runs on every
  page load, every 30 s while any page is open, and before every check-in. Any session
  still open at 19:00 IST on its check-in day is closed with **`auto_checkout = true`**
  and checkout stamped 19:00 IST. IST is handled with a fixed +05:30 offset, so it's
  correct regardless of device timezone. The kiosk at the entrance normally runs 24/7,
  so nightly closing happens even if nobody clicks anything.
- **Kiosk QR security** — the QR encodes `checkin.html?k=<2-min-slot>.<fnv1a-hash>`;
  the portal verifies the hash + freshness window (±1 slot) before showing the
  "kiosk link verified" badge and tagging the entry `src: "kiosk"`.
- **Persistence** — LocalStorage (`genesis.logs.v1`, `genesis.registry.v1`).
  Live updates fan out across open tabs via `BroadcastChannel` + `storage` events.
- **CSV export** — respects the current dashboard filters; includes the
  `Auto Check-Out` TRUE/FALSE column. BOM-prefixed for Excel.

## Data model (per log entry)

```json
{
  "id": "LOG-20260921-X7K2Q", "uid": "QU-CS-23-1042", "name": "Aarav Sharma",
  "role": "Student", "purpose": "Research Lab",
  "checkIn": 1727..., "checkOut": null, "autoCheckout": false,
  "forced": false, "src": "kiosk", "date": "2026-09-21"
}
```

## Reset / demo data

Admin → *Data management* → **Generate demo dataset** (a week of visits incl. live
occupants) or **Erase all data**. You can also clear `localStorage` keys
`genesis.logs.v1` / `genesis.registry.v1` manually.

## Going multi-device with Supabase

The UI only ever talks to the `window.Genesis` API. Swap the two storage helpers in
`js/genesis.js` (`read`/`write` over `genesis.logs.v1`) for Supabase calls
(`from('visit_logs').select()` / `.upsert()`), replace `BroadcastChannel` with
`supabase.channel('visit_logs').on('postgres_changes', …)`, and move the 7 PM sweep to
a scheduled Edge Function or `pg_cron` job:

```sql
update visit_logs
set check_out = date_trunc('day', now() at time zone 'Asia/Kolkata')
              + interval '19 hours',
    auto_checkout = true
where check_out is null
  and (now() at time zone 'Asia/Kolkata')::time >= time '19:00';
```

## Kiosk deployment tips

- Serve the site on your hub network, open `kiosk.html`, hit **Fullscreen**
  (or launch Chrome with `--kiosk <url>` on the entrance tablet).
- The QR targets the *current origin*, so phones must reach the same host/port —
  use a LAN IP or deployed URL reachable from visitor devices.
