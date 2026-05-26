// Bangle.js Motion Sender
// This app reads accelerometer data and sends it via BLE to the laptop

var recording = false;

// Set up BLE service for motion data
NRF.setServices({
  "12340001-1234-1234-1234-123456789abc": {
    "12340002-1234-1234-1234-123456789abc": {
      value: new ArrayBuffer(8),
      notify: true,
      readable: true,
      description: "Motion XY"
    }
  }
});

// Set advertising name so the web app can find us
NRF.setAdvertising({}, { name: "BangleMotion" });

// Smoothing filter - prevents jitter
var smoothX = 0;
var smoothY = 0;
var alpha = 0.3; // smoothing factor (0 = very smooth, 1 = raw)

function onAccel(data) {
  if (!recording) return;

  // Apply low-pass filter for smooth movement
  smoothX = alpha * data.x + (1 - alpha) * smoothX;
  smoothY = alpha * data.y + (1 - alpha) * smoothY;

  // Ignore tiny movements (dead zone)
  var x = Math.abs(smoothX) < 0.05 ? 0 : smoothX;
  var y = Math.abs(smoothY) < 0.05 ? 0 : smoothY;

  // Scale to -100..100 range
  var sendX = Math.round(Math.max(-100, Math.min(100, x * 100)));
  var sendY = Math.round(Math.max(-100, Math.min(100, y * 100)));

  // Pack into buffer and notify
  var buf = new ArrayBuffer(4);
  var view = new DataView(buf);
  view.setInt16(0, sendX);
  view.setInt16(2, sendY);

  NRF.updateServices({
    "12340001-1234-1234-1234-123456789abc": {
      "12340002-1234-1234-1234-123456789abc": {
        value: buf,
        notify: true
      }
    }
  });
}

// Toggle recording with button press
function toggleRecording() {
  recording = !recording;
  if (recording) {
    smoothX = 0;
    smoothY = 0;
    g.clear();
    g.setFont("6x8", 2);
    g.setColor(0, 1, 0);
    g.drawString("RECORDING", 20, 50);
    g.drawString("Tilt to draw", 10, 80);
    Bangle.buzz(200);
  } else {
    g.clear();
    g.setFont("6x8", 2);
    g.setColor(1, 0, 0);
    g.drawString("PAUSED", 40, 50);
    g.drawString("Press BTN", 20, 80);
    Bangle.buzz(100);
  }
}

// Start accelerometer
Bangle.on('accel', onAccel);

// Button to start/stop
setWatch(toggleRecording, BTN, { repeat: true, edge: "rising" });

// Initial screen
g.clear();
g.setFont("6x8", 2);
g.setColor(1, 1, 1);
g.drawString("Motion", 30, 30);
g.drawString("Controller", 15, 55);
g.setFont("6x8", 1);
g.drawString("Press button to start", 10, 90);
g.drawString("Tilt hand to draw", 15, 105);
