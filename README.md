# Smartwatch Motion to 3D Printer

This project turns hand movement into a printable drawing.

A Bangle.js smartwatch sends accelerometer data over Bluetooth. The web app converts the movement into a path, displays it live, and exports G-code for an Ultimaker 2+.

## Run it

1. Upload `watch/motion-sender.js` to the watch using the [Espruino Web IDE](https://www.espruino.com/ide/).
2. Open `webapp/index.html` in Chrome.
3. Connect the watch, record a movement, and export the drawing as G-code.
4. Copy the G-code to an SD card and run it on the printer.

The canvas also supports mouse drawing when no watch is connected.

## Files

- `watch/motion-sender.js` — reads and sends watch movement
- `webapp/index.html` — user interface
- `webapp/app.js` — Bluetooth, drawing, and G-code generation
