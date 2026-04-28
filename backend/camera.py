import threading
import time
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from config.settings import CAMERA_INDEX, CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS

try:
    import cv2
    CV2_OK = True
except ImportError:
    CV2_OK = False
    print("[CAM] opencv not installed — camera disabled")

class Camera:
    def __init__(self):
        self.cap = None
        self.frame = None
        self.running = False
        self._lock = threading.Lock()

    def start(self):
        if not CV2_OK:
            print("[CAM] Demo mode — no camera")
            return False
        try:
            self.cap = cv2.VideoCapture(CAMERA_INDEX)
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH,  CAMERA_WIDTH)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)
            self.cap.set(cv2.CAP_PROP_FPS, CAMERA_FPS)
            if not self.cap.isOpened():
                print("[CAM] Camera not found at index", CAMERA_INDEX)
                return False
            self.running = True
            threading.Thread(target=self._capture_loop, daemon=True).start()
            print(f"[CAM] Camera started ({CAMERA_WIDTH}x{CAMERA_HEIGHT} @ {CAMERA_FPS}fps)")
            return True
        except Exception as e:
            print(f"[CAM] Error: {e}")
            return False

    def _capture_loop(self):
        while self.running:
            ret, frame = self.cap.read()
            if ret:
                with self._lock:
                    self.frame = frame
            else:
                time.sleep(0.05)

    def get_jpeg(self, quality=75):
        if not CV2_OK:
            return None
        with self._lock:
            if self.frame is None:
                return None
            ret, buf = cv2.imencode('.jpg', self.frame,
                                    [cv2.IMWRITE_JPEG_QUALITY, quality])
            return buf.tobytes() if ret else None

    def stream_generator(self):
        """MJPEG stream — browser connects once and receives continuous frames."""
        while True:
            jpeg = self.get_jpeg()
            if jpeg:
                yield (
                    b'--frame\r\n'
                    b'Content-Type: image/jpeg\r\n\r\n'
                    + jpeg +
                    b'\r\n'
                )
            else:
                # When camera is offline, send a small 1px placeholder
                # so the browser img.onload fires instead of onerror
                yield b'--frame\r\nContent-Type: image/jpeg\r\n\r\n\r\n'
            time.sleep(1.0 / max(CAMERA_FPS, 1))

    def stop(self):
        self.running = False
        if self.cap:
            self.cap.release()
