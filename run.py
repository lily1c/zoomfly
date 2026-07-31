import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from backend.app import app, socketio, mav, cam
from config.settings import FLASK_HOST, FLASK_PORT

if __name__ == '__main__':
    print("[ZoomFly] Starting...")
    mav.connect()
    cam.start()
    print(f"[ZoomFly] Open → http://localhost:{FLASK_PORT}")
    socketio.run(app, host=FLASK_HOST, port=FLASK_PORT, debug=False)
