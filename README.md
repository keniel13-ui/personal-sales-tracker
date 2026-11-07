# Sales Tracker

A small installable web app for logging retail sales and tracking M1 / M2 / M3 credits per
commission cycle (the 22nd through the 21st). Everything stays on your own phone; there is no
account, no server, and no tracking.

## Use it on iPhone
1. Open the app link in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open it from the home screen. It works offline after the first load.
4. First time: tap **Load plan file** and pick the plan file you were given (kept on your phone only),
   then **Set goals**: your M1/M2/M3 goals, credits you already have this cycle, and optionally your
   TIC and PTO accelerator from your statement for an estimated commission.

## What it does
- Tap products, set quantities, and see `M1 +x | M2 +x | M3 +x` before saving. One **Save Sale**.
- A new cycle starts at zero on the 22nd. Old cycles stay in **Archive**.
- Edit or delete a sale (with Undo). Edits keep a history.
- **Save backup / Restore** from the ⚙︎ menu. Back up regularly: deleting the app or clearing
  Safari data erases what's stored on the phone.

## What it does not do
- The estimated commission is only as good as the plan file and the credits you log. Your official
  statement is the real number.
- This repository contains no products, credit values or pay rules. Those live in a private plan file
  that is never committed here.
- Don't enter customer names, account numbers, phones, or addresses. The reference field is for
  your own short note only.

## Development
`npm test` runs the credit, cycle, starting-credit and restore checks (Node 20+, no dependencies).
Serve the folder with any static server, for example `python3 -m http.server`.
When you deploy changes, bump `VERSION` in `sw.js` so installed phones pick them up.
