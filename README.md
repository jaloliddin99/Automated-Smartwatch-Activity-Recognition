# Automated Smartwatch Activity Recognition

**Control a 3D printer with hand movements using a Bangle.js smartwatch.**

Draw in the air → see it on screen → print it on Ultimaker 2+.

## Architecture

```
Bangle.js Watch (accelerometer)
        ↓ Bluetooth BLE
Web App on Laptop (visualize + record)
        ↓ Export G-code
Ultimaker 2+ (prints the drawing)
```

## Project Structure

```
watch/
  motion-sender.js    → JavaScript app for Bangle.js watch
webapp/
  index.html          → Web interface
  app.js              → BLE connection, motion visualization, G-code export
```

## How to Use

### Step 1: Upload Code to Watch
1. Open [Espruino Web IDE](https://www.espruino.com/ide/) in Chrome
2. Connect to your Bangle.js watch via Bluetooth
3. Copy the code from `watch/motion-sender.js` and upload it
4. Press the watch button — screen should say "RECORDING"

### Step 2: Run the Web App
1. Open `webapp/index.html` in Chrome (must be Chrome for Web Bluetooth)
2. Click **Connect Watch** and select "BangleMotion"
3. Click **Record** and tilt your hand to draw
4. Click **Stop** when done
5. Click **Export G-code** to download the file

### Step 3: Print
1. Copy the `.gcode` file to an SD card
2. Insert SD card into Ultimaker 2+
3. Select the file and print

**Tip:** For testing, run without filament first — the printer head traces the path without actually printing.

### Demo Mode
No watch? You can draw with your mouse directly on the canvas to test the G-code export.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Smartwatch | Bangle.js 2 (JavaScript / Espruino) |
| Communication | Bluetooth Low Energy (BLE) |
| Web App | HTML5 + JavaScript (Web Bluetooth API) |
| 3D Printer | Ultimaker 2+ (G-code) |

## Safety Features

- Low-pass filter on accelerometer data (prevents jitter)
- Dead zone for small movements (ignores hand tremor)
- Boundary limits (cursor stays within printer bed area)
- Path simplification in G-code (Douglas-Peucker algorithm)
- Movement speed limits

## Requirements

- Chrome browser (Web Bluetooth only works in Chrome)
- Bangle.js smartwatch
- Ultimaker 2+ 3D printer
