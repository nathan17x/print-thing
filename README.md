# Print

A self-hosted print portal in one Docker container. Users drop files, pick a printer, and print, with no login. They see live, detailed job status. Admins manage printers behind a password.

## Run it

```bash
docker compose up -d --build
```

Open http://localhost:3000. Go to **Admin** (password from `ADMIN_PASSWORD` in `compose.yml`, so change it first) and add your printers by IP address.

| Env var | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | *(none)* | Required for the admin page. If it's not set, admin login is disabled. |
| `SESSION_SECRET` | derived from password | Key for signing admin session cookies. Changing it signs everyone out. |
| `RETENTION_HOURS` | `72` | How long uploads and finished job history are kept. |
| `MAX_UPLOAD_MB` | `200` | Per-file upload limit. |
| `COOKIE_SECURE` | `false` | Set `true` when serving over HTTPS. |

All state is stored in the `/data` volume: the SQLite database, uploads, and the CUPS config and spool. Queued jobs survive container rebuilds.

## How printing works

**Protocol: IPP (Internet Printing Protocol) / IPP Everywhere.** Every HP printer from the last ~10 years supports it. It's the richest standard printer protocol: it reports printer state and reasons (jam, door open, out of paper), toner/ink levels, tray contents, alerts, firmware, and per-job page counts. No HP drivers are needed.

```
browser ──upload──▶ Next.js ──convert (if needed)──▶ CUPS (in container) ──IPP──▶ printer
                       │                                 ▲
                       └──── polls job state ────────────┘
                       └──── polls printer directly over IPP (status, supplies, trays, device-side jobs)
```

- **CUPS** runs inside the container. Each printer gets a driverless `-m everywhere` queue. CUPS handles format conversion, spooling, and retrying while a printer is offline.
- **File conversion:** Word, Excel, PowerPoint, ODF, RTF, CSV and HTML go through LibreOffice. WebP, HEIC, AVIF and BMP go through ImageMagick, and SVG through librsvg. PDF, PostScript, JPEG, PNG, GIF, TIFF and text go straight to CUPS.
- **Status** comes from two places:
  1. CUPS job attributes: state, reasons, printer messages, pages processed, timings.
  2. The printer itself: `Get-Printer-Attributes` and `Get-Jobs`.

  The app records every change as a timeline event for each job.

## Adding HP printers

In Admin → **Add printer**, enter the printer's IP or hostname and click **Detect**. The app tries the common IPP paths (`/ipp/print` is HP's) and shows the model, color and duplex support. If a printer isn't found:

- Check that IPP is enabled in the printer's web page (EWS → Network → Advanced → IPP).
- The container must be able to reach the printer. Docker's default bridge network can reach LAN IPs. Auto-discovery via mDNS/Bonjour is not used, so enter the IP.
- For `ipps://`, self-signed printer certificates are accepted.

Other admin actions: refresh status, re-detect capabilities (after a firmware update), resume a stopped queue, rebuild the CUPS queue, enable/disable, set default, delete.

## Development

```bash
npm install
ADMIN_PASSWORD=dev npm run dev
```

The UI works locally, but printing needs CUPS (`lpadmin`, `cupsd`), LibreOffice and poppler, so use the container for end-to-end testing. To test without real hardware, CUPS ships a simulated IPP Everywhere printer, `ippeveprinter` (package `cups-ipp-utils`, needs `avahi-daemon` running).
