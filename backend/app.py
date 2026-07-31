import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))




from flask import Flask, jsonify, request, Response, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit

from config.settings import FLASK_HOST, FLASK_PORT
from backend.mavlink_bridge import MAVBridge
from backend.camera import Camera

import resend
from config.settings import RESEND_API_KEY, FROM_EMAIL
resend.api_key = RESEND_API_KEY
# preflight is optional — if it fails to import just skip it
try:
    from backend.preflight import get_health, run_device_test
    PREFLIGHT_OK = True
except Exception:
    PREFLIGHT_OK = False

app = Flask(__name__, static_folder='../frontend', static_url_path='')
CORS(app, origins='*')
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

mav = MAVBridge(socketio=socketio)
cam = Camera()

@app.route('/')
def index():
    return send_from_directory('../frontend', 'index.html')

@app.route('/api/status')
def status():
    from config.settings import (ORIGIN_NAME, ORIGIN_LAT, ORIGIN_LON,
                                  DEST_NAME, DEST_LAT, DEST_LON,
                                  ROUTE_DISTANCE_MI, CRUISE_SPEED_MPH)
    return jsonify({
        "connected":   mav.connected,
        "telemetry":   mav.get_state(),
        "origin":      {"name": ORIGIN_NAME, "lat": ORIGIN_LAT, "lon": ORIGIN_LON},
        "destination": {"name": DEST_NAME,   "lat": DEST_LAT,   "lon": DEST_LON},
        "route_miles": ROUTE_DISTANCE_MI,
        "cruise_mph":  CRUISE_SPEED_MPH,
    })

@app.route('/api/health')
def health():
    if not PREFLIGHT_OK:
        return jsonify({"ready": False, "devices": [], "checks": [], "telemetry": mav.get_state()})
    return jsonify(get_health(mav))

@app.route('/api/device/test', methods=['POST'])
def device_test():
    if not PREFLIGHT_OK:
        return jsonify({"ok": False, "message": "Preflight module unavailable"})
    device_id = (request.json or {}).get('id', '')
    result = run_device_test(device_id, mav)
    return jsonify(result), (200 if result['ok'] else 400)

@app.route('/api/arm', methods=['POST'])
def arm():
    ok, msg = mav.arm()
    return jsonify({"ok": ok, "msg": msg}), (200 if ok else 400)

@app.route('/api/disarm', methods=['POST'])
def disarm():
    ok, msg = mav.disarm()
    return jsonify({"ok": ok, "msg": msg}), (200 if ok else 400)

@app.route('/api/mode', methods=['POST'])
def set_mode():
    mode = (request.json or {}).get('mode', 'STABILIZE')
    ok, msg = mav.set_mode(mode)
    return jsonify({"ok": ok, "msg": msg}), (200 if ok else 400)

@app.route('/api/motortest', methods=['POST'])
def motortest():
    data     = request.json or {}
    motor    = int(data.get('motor', 1))
    pct      = int(data.get('pct', 10))
    duration = int(data.get('duration', 3))
    ok, msg  = mav.motor_test(motor, pct, duration)
    return jsonify({"ok": ok, "msg": msg}), (200 if ok else 400)

@app.route('/api/throttle', methods=['POST'])
def throttle():
    return jsonify({"ok": True, "msg": "Use QGC for throttle control"})

@app.route('/video')
def video():
    resp = Response(
        cam.stream_generator(),
        mimetype='multipart/x-mixed-replace; boundary=frame'
    )
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    resp.headers['X-Accel-Buffering'] = 'no'
    return resp

@socketio.on('connect')
def on_connect():
    emit('telemetry', mav.get_state())

# ── Allow running directly: python3 -m backend.app ───────────────
if __name__ == '__main__':
    print("[ZoomFly] Starting...")
    mav.connect()
    cam.start()
    print(f"[ZoomFly] Open → http://localhost:{FLASK_PORT}")
    socketio.run(app, host=FLASK_HOST, port=FLASK_PORT, debug=False)


@app.route('/api/notify', methods=['POST'])
def notify():
    try:
        data    = request.json
        email   = data.get('email')
        name    = data.get('name')
        ticket  = data.get('ticket_id')
        status  = data.get('status', 'dispatched')
        origin  = data.get('origin', 'MVNU Main Campus')
        dest    = data.get('destination', 'HW Hub')
        elapsed = data.get('elapsed', '')

        if not email:
            return jsonify({'ok': False, 'msg': 'No email provided'})

        if status == 'dispatched':
            subject = f'Your mail is on the way — ZoomFly {ticket}'
            html = f'''
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
              <div style="background:#0C2340;padding:20px;border-radius:8px;text-align:center;margin-bottom:24px">
                <h1 style="color:#fff;margin:0;font-size:22px">zoom<span style="color:#1D9E75">fly</span></h1>
                <p style="color:#7a99bb;margin:6px 0 0;font-size:13px">MVNU Drone Delivery</p>
              </div>
              <h2 style="color:#0C2340">Your mail is on the way</h2>
              <p style="color:#444;line-height:1.6">Hi {name},</p>
              <p style="color:#444;line-height:1.6">Your mail is being delivered via ZoomFly autonomous drone.</p>
              <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:20px 0">
                <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                  <span style="color:#888;font-size:13px">Tracking ID</span>
                  <span style="color:#0C2340;font-weight:600">{ticket}</span>
                </div>
                <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                  <span style="color:#888;font-size:13px">From</span>
                  <span style="color:#444;font-size:13px">{origin}</span>
                </div>
                <div style="display:flex;justify-content:space-between">
                  <span style="color:#888;font-size:13px">To</span>
                  <span style="color:#444;font-size:13px">{dest}</span>
                </div>
              </div>
              <p style="color:#444;line-height:1.6">You will receive another email when your delivery arrives.</p>
              <p style="color:#888;font-size:12px;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
                MVNU ZoomFly · Mount Vernon Nazarene University
              </p>
            </div>'''
        else:
            subject = f'Your mail has arrived — ZoomFly {ticket}'
            html = f'''
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
              <div style="background:#0C2340;padding:20px;border-radius:8px;text-align:center;margin-bottom:24px">
                <h1 style="color:#fff;margin:0;font-size:22px">zoom<span style="color:#1D9E75">fly</span></h1>
                <p style="color:#7a99bb;margin:6px 0 0;font-size:13px">MVNU Drone Delivery</p>
              </div>
              <div style="text-align:center;margin:20px 0">
                <div style="width:56px;height:56px;background:#E1F5EE;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin:0 auto">
                  <span style="color:#1D9E75;font-size:28px">✓</span>
                </div>
              </div>
              <h2 style="color:#0C2340;text-align:center">Your mail has arrived</h2>
              <p style="color:#444;line-height:1.6;text-align:center">Hi {name}, your delivery <strong>{ticket}</strong> is complete.</p>
              <div style="background:#E1F5EE;border-radius:8px;padding:16px;margin:20px 0;text-align:center">
                <span style="color:#0F6E56;font-weight:600">{elapsed}</span>
              </div>
              <p style="color:#888;font-size:12px;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
                MVNU ZoomFly · Mount Vernon Nazarene University
              </p>
            </div>'''

        resend.Emails.send({
            'from':    FROM_EMAIL,
            'to':      [email],
            'subject': subject,
            'html':    html,
        })

        return jsonify({'ok': True, 'msg': f'Email sent to {email}'})

    except Exception as e:
        return jsonify({'ok': False, 'msg': str(e)})