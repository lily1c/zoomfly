"""
preflight.py — Device detection and pre-flight health checks.
Runs on the Raspberry Pi and reports what's connected.
"""

import subprocess, os, glob, time, threading

try:
    from pymavlink import mavutil
    MAVLINK_OK = True
except ImportError:
    MAVLINK_OK = False

try:
    import serial.tools.list_ports
    SERIAL_OK = True
except ImportError:
    SERIAL_OK = False

try:
    import cv2
    CV2_OK = True
except ImportError:
    CV2_OK = False


# ── Device fingerprints ──────────────────────────────────────────
# Maps USB vendor:product or path patterns to friendly names
DEVICE_PROFILES = {
    # Orange Cube / Cube Plus
    "2dae:1016": {"name": "Flight Controller", "detail": "Cube Orange+ · ArduCopter"},
    "2dae:1011": {"name": "Flight Controller", "detail": "Cube Black · ArduCopter"},
    "26ac:0011": {"name": "Flight Controller", "detail": "Pixhawk 4 · PX4"},
    "0483:5740": {"name": "Flight Controller", "detail": "STM32 USB · MAVLink"},
    # Quectel LTE
    "2c7c:0125": {"name": "4G LTE Modem",      "detail": "Quectel EC25-A · cellular"},
    "2c7c:0121": {"name": "4G LTE Modem",      "detail": "Quectel EC21 · cellular"},
    # Common USB cameras
    "046d:085c": {"name": "Camera",             "detail": "Logitech C922 · USB"},
    "046d:0825": {"name": "Camera",             "detail": "Logitech C270 · USB"},
    "0c45:6366": {"name": "Camera",             "detail": "USB Camera · UVC"},
}

GPS_FIX_LABELS = {0:"No fix", 1:"No fix", 2:"2D fix", 3:"3D fix", 4:"DGPS", 5:"RTK float", 6:"RTK fixed"}


def _run(cmd):
    try:
        return subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=4).decode().strip()
    except Exception:
        return ""

def _lsusb():
    """Parse lsusb output into list of {vendor_id, product_id, description}"""
    out = _run(["lsusb"])
    devices = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 6:
            vid_pid = parts[5]
            desc = " ".join(parts[6:]) if len(parts) > 6 else ""
            vid, pid = vid_pid.split(":") if ":" in vid_pid else ("", "")
            devices.append({"vid": vid.lower(), "pid": pid.lower(),
                             "vid_pid": vid_pid.lower(), "desc": desc})
    return devices

def _serial_ports():
    """List available ttyACM and ttyUSB ports."""
    ports = []
    for pattern in ["/dev/ttyACM*", "/dev/ttyUSB*", "/dev/serial0"]:
        ports += glob.glob(pattern)
    return sorted(ports)


def scan_devices():
    """
    Scan all connected hardware and return a list of device dicts:
      { id, name, detail, status, port, notes, testable }
    """
    results = []
    usb_devices = _lsusb()
    serial_ports = _serial_ports()

    # ── 1. Flight Controller ─────────────────────────────────────
    fc_found = False
    fc_port  = None

    # Check USB
    for dev in usb_devices:
        profile = DEVICE_PROFILES.get(dev["vid_pid"])
        if profile and "Flight Controller" in profile["name"]:
            fc_found = True
            break

    # Check serial ports for ACM (CDC serial = flight controller USB)
    acm_ports = [p for p in serial_ports if "ACM" in p]
    if acm_ports:
        fc_found = True
        fc_port  = acm_ports[0]

    results.append({
        "id":       "fc",
        "name":     "Flight Controller",
        "detail":   "Cube Orange+ · /dev/ttyACM0 · 115200 baud",
        "status":   "connected" if fc_found else "disconnected",
        "port":     fc_port or ("/dev/ttyACM0" if fc_found else "—"),
        "notes":    "MAVLink via USB" if fc_found else "Not detected — check USB cable",
        "testable": True,
    })

    # ── 2. Camera ────────────────────────────────────────────────
    cam_found = False
    cam_detail = "Pi CSI camera · /dev/video0"

    if CV2_OK:
        cap = cv2.VideoCapture(0)
        if cap.isOpened():
            cam_found = True
            cap.release()
    else:
        # Fallback: check if /dev/video0 exists
        cam_found = os.path.exists("/dev/video0")

    # Also check USB cameras
    for dev in usb_devices:
        profile = DEVICE_PROFILES.get(dev["vid_pid"])
        if profile and "Camera" in profile["name"]:
            cam_found  = True
            cam_detail = profile["detail"] + " · USB"
            break

    results.append({
        "id":       "camera",
        "name":     "Camera",
        "detail":   cam_detail,
        "status":   "connected" if cam_found else "disconnected",
        "port":     "/dev/video0" if cam_found else "—",
        "notes":    "Live feed ready" if cam_found else "No camera found — check CSI ribbon or USB",
        "testable": True,
    })

    # ── 3. LTE Modem ────────────────────────────────────────────
    lte_found = False
    lte_detail = "Quectel EC25-A · USB adapter"
    lte_port   = "—"

    for dev in usb_devices:
        profile = DEVICE_PROFILES.get(dev["vid_pid"])
        if profile and "LTE" in profile["name"]:
            lte_found  = True
            lte_detail = profile["detail"]
            break

    usb_ports = [p for p in serial_ports if "USB" in p]
    if usb_ports:
        lte_found = True
        lte_port  = usb_ports[0]

    # Check if modem has network
    lte_network = False
    if lte_found:
        ping = _run(["ping", "-c", "1", "-W", "2", "8.8.8.8"])
        lte_network = "1 received" in ping or "1 packets received" in ping

    results.append({
        "id":       "lte",
        "name":     "4G LTE Modem",
        "detail":   lte_detail + (" · " + lte_port if lte_port != "—" else ""),
        "status":   "connected" if lte_found else "disconnected",
        "port":     lte_port,
        "notes":    ("Network active ✓" if lte_network else "Modem detected — no SIM or network yet") if lte_found else "EC25 not detected — check USB adapter",
        "testable": lte_found,
    })

    # ── 4. GPS (via MAVLink if FC connected) ────────────────────
    results.append({
        "id":       "gps",
        "name":     "GPS",
        "detail":   "External GPS module · JST-GH 4-pin → Cube GPS port",
        "status":   "unknown",    # updated live from telemetry
        "port":     "GPS1 port",
        "notes":    "Status updates from flight controller telemetry",
        "testable": False,
    })

    # ── 5. RC Radio ─────────────────────────────────────────────
    rcin = glob.glob("/dev/ttyAMA*") + glob.glob("/dev/ttyS*")
    results.append({
        "id":       "rc",
        "name":     "RC Radio",
        "detail":   "RadioMaster · 900 MHz · RCIN port on Cube",
        "status":   "unknown",
        "port":     "Cube RCIN",
        "notes":    "Verified via RC input channels in MAVLink",
        "testable": False,
    })

    return results


def run_device_test(device_id, mav_bridge=None):
    """
    Run a quick test for the given device_id.
    Returns { ok: bool, message: str }
    """
    if device_id == "fc":
        if mav_bridge and mav_bridge.connected:
            state = mav_bridge.get_state()
            return {"ok": True, "message":
                f"Heartbeat OK · Mode: {state['mode']} · Armed: {state['armed']}"}
        # Try a fresh MAVLink connection
        if not MAVLINK_OK:
            return {"ok": False, "message": "pymavlink not installed"}
        try:
            from config.settings import SERIAL_PORT, SERIAL_BAUD
            conn = mavutil.mavlink_connection(SERIAL_PORT, baud=SERIAL_BAUD)
            conn.wait_heartbeat(timeout=5)
            conn.close()
            return {"ok": True, "message": "Heartbeat received — flight controller responding"}
        except Exception as e:
            return {"ok": False, "message": f"No heartbeat: {e}"}

    elif device_id == "camera":
        if not CV2_OK:
            return {"ok": False, "message": "opencv not installed — run: pip3 install opencv-python-headless"}
        try:
            cap = cv2.VideoCapture(0)
            if not cap.isOpened():
                return {"ok": False, "message": "Camera index 0 not available"}
            ret, _ = cap.read()
            cap.release()
            return {"ok": ret, "message": "Frame captured OK" if ret else "Camera opened but no frame"}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    elif device_id == "lte":
        ping = _run(["ping", "-c", "2", "-W", "2", "8.8.8.8"])
        if "2 received" in ping or "2 packets received" in ping:
            return {"ok": True,  "message": "Internet reachable via cellular ✓"}
        elif "1 received" in ping or "1 packets received" in ping:
            return {"ok": True,  "message": "Partial connectivity — 1/2 packets"}
        else:
            usb = glob.glob("/dev/ttyUSB*")
            if usb:
                return {"ok": False, "message": f"Modem detected ({usb[0]}) but no internet — SIM or APN issue"}
            return {"ok": False, "message": "No modem and no internet — check EC25 USB connection"}

    return {"ok": False, "message": f"No test defined for {device_id}"}


def get_health(mav_bridge=None):
    """
    Return a full health snapshot combining device scan + live MAVLink state.
    """
    devices = scan_devices()
    telem   = mav_bridge.get_state() if mav_bridge else {}

    # Annotate GPS with live data
    gps_fix = telem.get("gps_fix", 0)
    gps_sats = telem.get("satellites", 0)
    gps_ok   = gps_fix >= 3
    for d in devices:
        if d["id"] == "gps":
            d["status"] = "connected" if gps_ok else ("warning" if gps_fix > 0 else "disconnected")
            d["notes"]  = f"{GPS_FIX_LABELS.get(gps_fix,'—')} · {gps_sats} satellites"

    # Overall readiness
    fc_ok  = any(d["id"]=="fc"     and d["status"]=="connected" for d in devices)
    cam_ok = any(d["id"]=="camera" and d["status"]=="connected" for d in devices)
    lte_ok = any(d["id"]=="lte"    and d["status"]=="connected" for d in devices)

    batt_pct  = telem.get("battery_pct",  0)
    batt_v    = telem.get("battery_voltage", 0.0)
    batt_ok   = batt_pct > 20 or batt_v > 20.0

    checks = [
        {"label": "Flight controller",  "ok": fc_ok},
        {"label": "GPS 3D fix",         "ok": gps_ok},
        {"label": "Battery",            "ok": batt_ok},
        {"label": "Camera",             "ok": cam_ok},
        {"label": "LTE comms",          "ok": lte_ok},
    ]
    ready = all(c["ok"] for c in checks)

    return {
        "ready":   ready,
        "devices": devices,
        "checks":  checks,
        "telemetry": {
            "armed":      telem.get("armed", False),
            "mode":       telem.get("mode", "—"),
            "battery_pct":     batt_pct,
            "battery_voltage": batt_v,
            "gps_fix":    gps_fix,
            "satellites": gps_sats,
            "altitude":   telem.get("altitude", 0),
            "roll":       telem.get("roll", 0),
            "pitch":      telem.get("pitch", 0),
        }
    }
