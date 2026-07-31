import os
from dotenv import load_dotenv
load_dotenv()

SERIAL_PORT = "/dev/ttyACM0"
SERIAL_BAUD = 115200

TELEM2_PORT = "/dev/serial0"
TELEM2_BAUD = 921600

CAMERA_INDEX = 0
CAMERA_WIDTH  = 1280
CAMERA_HEIGHT = 720
CAMERA_FPS    = 30

FLASK_HOST = "0.0.0.0"
FLASK_PORT = 5000

ORIGIN_NAME = "MVNU Main Campus"
ORIGIN_LAT  = 40.3932
ORIGIN_LON  = -82.4802

DEST_NAME = "Downtown Mount Vernon"
DEST_LAT  = 40.3975
DEST_LON  = -82.4855

FLIGHT_ALTITUDE_FT = 120
CRUISE_SPEED_MPH   = 18
ROUTE_DISTANCE_MI  = 3.4

GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
FROM_EMAIL     = os.environ.get("FROM_EMAIL", "onboarding@resend.dev")