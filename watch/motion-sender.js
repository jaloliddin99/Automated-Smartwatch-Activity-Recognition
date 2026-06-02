// Bangle.js Motion Sender
// This app reads accelerometer data and sends it via BLE to the laptop

var recording = false;

// Turn on screen and keep it on
Bangle.setLCDPower(1);
Bangle.setLCDBrightness(1);
Bangle.setLCDTimeout(0); // never turn off

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
}, { uart: false, advertise: ["12340001-1234-1234-1234-123456789abc"] });

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

function showScreen(title, subtitle, color) {
  g.clear(1);
  g.setFont("Vector", 24);
  g.setColor(color[0], color[1], color[2]);
  g.setFontAlign(0, 0);
  g.drawString(title, 88, 70);
  g.setFont("Vector", 16);
  g.setColor(1, 1, 1);
  g.drawString(subtitle, 88, 105);
  g.flip();
}

// Toggle recording with button press
function toggleRecording() {
  recording = !recording;
  if (recording) {
    smoothX = 0;
    smoothY = 0;
    showScreen("RECORDING", "Tilt to draw", [0, 1, 0]);
    Bangle.buzz(200);
  } else {
    showScreen("PAUSED", "Press BTN", [1, 0, 0]);
    Bangle.buzz(100);
  }
}

// Start accelerometer
Bangle.on('accel', onAccel);

// Button to start/stop (polling BTN1 since setWatch is unreliable on this unit)
var btnPressed = false;
setInterval(function() {
  var btn = digitalRead(BTN1);
  if (btn && !btnPressed) toggleRecording();
  btnPressed = btn;
}, 200);

// Initial screen
showScreen("Motion", "Press button", [1, 1, 1]);
