[README-4.md](https://github.com/user-attachments/files/31085322/README-4.md)
# ZoomFly

Backend and web dashboard for an autonomous drone mail-delivery system built for the Mount Vernon Nazarene University campus. ZoomFly runs on a Raspberry Pi and bridges a browser dashboard to a Cube Orange flight controller over MAVLink, streaming live telemetry, sending flight commands, and managing delivery tickets.

## What it does

- **Live telemetry** — streams GPS, battery, altitude, attitude, flight mode, and GPS-fix status to the browser in real time over Socket.IO.
- **Flight control** — REST endpoints to arm/disarm the drone, set flight modes, and run individual motor tests.
- **Delivery tickets** — create delivery jobs (recipient, addresses, payload), with route and flight-time estimates.
- **Camera feed** — serves an MJPEG live feed from the onboard camera.
- **Preflight checks** — fingerprints connected USB hardware via `lsusb` and aggregates a health report before flight.
- **Notifications** — sends delivery-status emails to recipients via the Resend API.

## Architecture

ZoomFly is a four-layer system with data flowing in both directions:

```
Browser dashboard  <—REST + Socket.IO—>  Flask server  <—method calls—>  MAVLink bridge  <—serial/MAVLink—>  Cube Orange flight controller
   (frontend)                              (app.py)                       (mavlink_bridge.py)
```

| Layer | File | Responsibility |
|-------|------|----------------|
| Frontend | `frontend/index.html` | Dashboard UI: telemetry, delivery form, camera, controls |
| Web server | `backend/app.py` | Flask + Socket.IO hub; REST endpoints; telemetry push |
| Hardware bridge | `backend/mavlink_bridge.py` | Serial/MAVLink connection, port auto-detection, telemetry thread, reconnect watchdog |
| Support | `backend/preflight.py`, `backend/camera.py`, `config/settings.py` | Health checks, camera feed, configuration |

The web layer never touches MAVLink directly — it calls clean methods (`arm()`, `disarm()`, `set_mode()`, `get_state()`) on the bridge. This separation of concerns means the web framework or the flight controller could be swapped without rewriting the other side.

### The MAVLink bridge

The most involved component. It:

- **auto-detects the serial port** by probing candidate ports in priority order (`/dev/ttyACM*`, UART GPIO, USB-serial adapters, config fallback) and waiting for a MAVLink heartbeat — a port existing isn't enough; the heartbeat proves the flight controller is actually there and alive;
- runs a **background telemetry thread** that reads MAVLink messages and dispatches each type through a handler map;
- keeps **thread-safe shared state** guarded by a lock, so the dashboard always reads a consistent snapshot;
- runs a **reconnect watchdog** that re-establishes the link if the connection drops.

## Tech stack

Python · Flask · Flask-SocketIO · pymavlink · OpenCV (camera) · Google Maps JavaScript API (routing) · Resend (email)

## Setup

```bash
# 1. Clone and enter the repo
git clone https://github.com/lily1c/zoomfly.git
cd zoomfly

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure environment
cp .env.example .env
# then edit .env with your own values (see below)

# 4. Run
python run.py
```

The server boots in **demo mode** if the flight-controller hardware or `pymavlink` isn't present, so it can be developed and tested without the drone attached.

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|----------|---------|
| `SERIAL_PORT` | Fallback serial port for the flight controller |
| `SERIAL_BAUD` | Serial baud rate |
| `RESEND_API_KEY` | Resend API key for delivery emails (server-side) |
| `GOOGLE_MAPS_API_KEY` | Google Maps JavaScript API key for routing |

**Google Maps key:** the Maps key runs in the browser and is therefore public by nature. Protect it by restricting it in Google Cloud Console to your domain (HTTP referrers) rather than trying to hide it. The live map will not render until a valid, referrer-restricted key is supplied.

## Notes

This project was built for a real campus delivery use case and interfaces with physical drone hardware. Never arm the drone or run motor tests with propellers attached during bench testing.

## License

MIT — see [LICENSE](LICENSE).
