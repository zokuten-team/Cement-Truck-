# My Trucks Dashboard

A shared vehicle-register dashboard built from **Vehicle Register Q2 26-27.xlsx**. It keeps the spreadsheet-style daily register on desktop and provides a separate, touch-friendly phone interface.

## What is included

- Dates down the left and driver/vehicle columns across the top
- Sticky daily **Total Qty** and **MTs** columns (`20 Qty = 1 MT` by default)
- Settlement status: yellow = pending, green = cleared, red = excess
- Imported July and August 2026 register data, rates, and payments
- Add, edit, or remove drivers and vehicles
- Change driver names, vehicle numbers, rates, daily quantities, payments, and the Qty-to-MT conversion
- Edit or delete payment records with retained audit history
- Download the complete selected month as a formatted Excel workbook
- Live WebSocket refresh for all connected users
- Per-cell version checks to prevent one operator silently overwriting another
- SQLite WAL storage suitable for a small team (about five simultaneous operators)
- Separate responsive phone UI for rapid daily entry

## Run on Windows

1. Install [Node.js 20 LTS or newer](https://nodejs.org/).
2. Extract or clone this repository.
3. Double-click `start-windows.cmd`.
4. Open <http://localhost:3000> on this computer. Other devices on the same network can use `http://YOUR-COMPUTER-IP:3000` while the app is running.

## Run on macOS

1. Install [Node.js 20 LTS or newer](https://nodejs.org/).
2. Extract or clone this repository.
3. In Terminal, run:

   ```bash
   chmod +x start-macos.sh
   ./start-macos.sh
   ```

4. Open <http://localhost:3000>.

## Manual development commands

```bash
npm install
npm run dev
```

Production-style local run:

```bash
npm ci
npm start
```

Run the automated checks:

```bash
npm test
```

## GitHub and hosting

The repository includes a GitHub Actions workflow that installs dependencies and runs the tests on every push and pull request.

GitHub stores and tests the project, but **GitHub Pages cannot run this Node.js backend**. For shared internet access, deploy the repository to any Node/Docker host (for example a small VM, Render, Railway, Fly.io, or a company server). Keep a persistent disk mounted for `data/my-trucks.db`.

Docker:

```bash
docker compose up --build
```

Then open <http://localhost:3000>.

## Configuration and backup

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port |
| `DATABASE_PATH` | `data/my-trucks.db` | SQLite database location |
| `GITHUB_TOKEN` | *None* | Set to auto-sync the SQLite database back to your GitHub repository every 5 minutes (for ephemeral hosting) |

The app creates the database and imports the supplied workbook seed on first run. Stop the server before copying `data/my-trucks.db` for a simple backup. The generated database files are ignored by Git so operational data is not accidentally committed. Driver, vehicle, and payment deletions are soft deletions: they disappear from the live dashboard, while their historical database records remain available for audit or recovery.

## Editing dashboard records

- Click `•••` on a driver/vehicle column or settlement card to change its name, vehicle number, or rate.
- The same panel can delete one vehicle or delete the selected driver and every vehicle assigned to that driver.
- Click **Payments** to add, edit, or delete payment records for the selected month.
- Click **Settings** to change how many quantity units equal one MT.
- Click **Excel** to download four sheets for the selected month: Setup, Monthly Register, Settlement, and Payments.
- Click any register cell to change that vehicle's quantity for the selected date.

## Status calculation

For each vehicle and selected month:

```text
Payable = Total Quantity x Vehicle Rate
Balance = Payable - Payments
```

- Balance greater than zero: **Pending** (yellow)
- Balance equal to zero: **Cleared** (green)
- Balance less than zero: **Excess** (red)
