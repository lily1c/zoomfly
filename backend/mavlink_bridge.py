import threading
import time
import glob
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from config.settings import SERIAL_PORT, SERIAL_BAUD

try:
    from pymavlink import mavutil
    MAVLINK_OK = True
except ImportError:
    MAVLINK_OK = False
    print("[MAV] pymavlink not installed — running in demo mode")


def find_flight_controller():
    """
    Auto-detect which serial port the flight controller is on.
    Tries ports in this order:
      1. /dev/ttyACM0, ACM1, ACM2  (USB CDC — most common for Cube)
      2. /dev/serial0, ttyAMA0      (UART GPIO — TELEM2)
      3. /dev/ttyUSB0, USB1         (USB-serial adapter)
      4. Whatever SERIAL_PORT is set to in settings.py
    Returns the first port that exists, or None.
    """
    candidates = (
        sorted(glob.glob("/dev/ttyACM*")) +   # USB direct (Cube Orange)
        ["/dev/serial0", "/dev/ttyAMA0"] +    # UART TELEM2
        sorted(glob.glob("/dev/ttyUSB*")) +   # USB-serial adapters
        [SERIAL_PORT]                          # settings.py fallback
    )
    seen = set()
    for port in candidates:
        if port not in seen and os.path.exists(port):
            seen.add(port)
            return port
    return None


class MAVBridge:
    def __init__(self, socketio=None):
        self.socketio   = socketio
        self.mav        = None
        self.connected  = False
        self.port_used  = None
        self.state = {
            "armed":           False,
            "mode":            "STABILIZE",
            "battery_voltage": 0.0,
            "battery_pct":     0,
            "altitude":        0.0,
            "lat":             0.0,
            "lon":             0.0,
            "roll":            0.0,
            "pitch":           0.0,
            "yaw":             0.0,
            "groundspeed":     0.0,
            "satellites":      0,
            "gps_fix":         0,
        }
        self._lock = threading.Lock()

    def connect(self):
        if not MAVLINK_OK:
            print("[MAV] Demo mode — pymavlink not installed")
            return False

        port = find_flight_controller()
        if not port:
            print("[MAV] No serial port found — Cube not detected")
            self.connected = False
            return False

        # Try each available ACM/serial port until one gives a heartbeat
        candidates = sorted(glob.glob("/dev/ttyACM*")) or [port]
        if port not in candidates:
            candidates.insert(0, port)

        for p in candidates:
            if not os.path.exists(p):
                continue
            try:
                print(f"[MAV] Trying {p} @ {SERIAL_BAUD}...")
                conn = mavutil.mavlink_connection(p, baud=SERIAL_BAUD)
                conn.wait_heartbeat(timeout=5)
                # Got a heartbeat — this is the right port
                self.mav = conn
                self.port_used = p
                self.connected = True
                print(f"[MAV] Connected on {p} — system {self.mav.target_system}")
                threading.Thread(target=self._telemetry_loop, daemon=True).start()
                threading.Thread(target=self._reconnect_watchdog, daemon=True).start()
                return True
            except Exception as e:
                print(f"[MAV] {p} — no heartbeat ({e})")
                try:
                    conn.close()
                except Exception:
                    pass

        print("[MAV] No flight controller responded on any port")
        self.connected = False
        return False

    def _reconnect_watchdog(self):
        """If connection drops, keep retrying every 10 seconds."""
        while True:
            time.sleep(10)
            if not self.connected:
                print("[MAV] Reconnecting...")
                self.connect()

    def _telemetry_loop(self):
        msg_map = {
            "HEARTBEAT":           self._handle_heartbeat,
            "SYS_STATUS":          self._handle_sys_status,
            "GLOBAL_POSITION_INT": self._handle_position,
            "ATTITUDE":            self._handle_attitude,
            "VFR_HUD":             self._handle_vfr,
            "GPS_RAW_INT":         self._handle_gps,
        }
        while self.connected:
            try:
                msg = self.mav.recv_match(blocking=True, timeout=2)
                if msg is None:
                    continue
                t = msg.get_type()
                if t in msg_map:
                    msg_map[t](msg)
                    if self.socketio:
                        self.socketio.emit("telemetry", self.get_state())
            except Exception as e:
                print(f"[MAV] Telemetry error: {e}")
                self.connected = False
                break

    def _handle_heartbeat(self, msg):
        with self._lock:
            self.state["armed"] = bool(
                msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
            self.state["mode"] = mavutil.mode_string_v10(msg)

    def _handle_sys_status(self, msg):
        with self._lock:
            self.state["battery_voltage"] = round(msg.voltage_battery / 1000.0, 2)
            if msg.battery_remaining >= 0:
                self.state["battery_pct"] = msg.battery_remaining

    def _handle_position(self, msg):
        with self._lock:
            self.state["lat"]      = msg.lat / 1e7
            self.state["lon"]      = msg.lon / 1e7
            self.state["altitude"] = round(msg.relative_alt / 1000.0, 1)

    def _handle_attitude(self, msg):
        import math
        with self._lock:
            self.state["roll"]  = round(math.degrees(msg.roll), 1)
            self.state["pitch"] = round(math.degrees(msg.pitch), 1)
            self.state["yaw"]   = round(math.degrees(msg.yaw), 1)

    def _handle_vfr(self, msg):
        with self._lock:
            self.state["groundspeed"] = round(msg.groundspeed, 1)

    def _handle_gps(self, msg):
        with self._lock:
            self.state["satellites"] = msg.satellites_visible
            self.state["gps_fix"]    = msg.fix_type

    def arm(self):
        if not self.connected:
            return False, "Flight controller not connected"
        try:
            self.mav.arducopter_arm()
            return True, f"Armed via {self.port_used}"
        except Exception as e:
            return False, str(e)

    def disarm(self):
        if not self.connected:
            return False, "Flight controller not connected"
        try:
            self.mav.arducopter_disarm()
            return True, "Disarmed"
        except Exception as e:
            return False, str(e)

    def set_mode(self, mode):
        if not self.connected:
            return False, "Flight controller not connected"
        try:
            mode_id = self.mav.mode_mapping()[mode]
            self.mav.set_mode(mode_id)
            return True, f"Mode → {mode}"
        except Exception as e:
            return False, str(e)

    def motor_test(self, motor, throttle_pct=10, duration=3):
        if not self.connected:
            return False, "Flight controller not connected"
        try:
            self.mav.mav.command_long_send(
                self.mav.target_system,
                self.mav.target_component,
                mavutil.mavlink.MAV_CMD_DO_MOTOR_TEST,
                0,
                motor, 0, throttle_pct, duration, 0, 0, 0
            )
            return True, f"Motor {motor} test sent @ {throttle_pct}%"
        except Exception as e:
            return False, str(e)

    def get_state(self):
        with self._lock:
            s = dict(self.state)
            s["port"] = self.port_used
            return s
