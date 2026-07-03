// ============================================
// Smartwatch Motion → 3D Printer Controller
// Real-time printing via Web Serial API
// ============================================

// --- Ultimaker 2+ build area ---
const BED_X = 223; // mm
const BED_Y = 223; // mm
const CANVAS_SIZE = 600; // pixels

// --- State ---
let bleDevice = null;
let bleCharacteristic = null;
let isRecording = false;
let cursorX = BED_X / 2; // start at center (mm)
let cursorY = BED_Y / 2;
let penDown = true;       // Z-axis pen state
let currentTiltZ = 100;   // current Z tilt value
let path = [];            // array of {x, y} points (in mm)
let allPaths = [];        // array of completed paths (for undo)
let currentPath = [];     // current recording segment

// --- Printer Serial State ---
let serialPort = null;
let serialWriter = null;
let serialReader = null;
let printerConnected = false;
let printerReady = false;
let printerInitialized = false;
let tempPollInterval = null;  // periodic temperature polling
let commandQueue = [];
let waitingForOk = false;
let totalExtruded = 0;    // running E value for real-time extrusion
let lastPrinterX = BED_X / 2;
let lastPrinterY = BED_Y / 2;
let lastSendTime = 0;
const SEND_INTERVAL = 80; // ms between G-code commands (throttle)
const MIN_MOVE_DIST = 0.5; // mm minimum distance to trigger a printer move

// Extrusion constants
const LAYER_HEIGHT = 0.2;
const LINE_WIDTH_MM = 0.4;
const FILAMENT_DIAMETER = 2.85;
const FILAMENT_AREA = Math.PI * (FILAMENT_DIAMETER / 2) * (FILAMENT_DIAMETER / 2);
const EXTRUSION_MULTIPLIER = (LAYER_HEIGHT * LINE_WIDTH_MM) / FILAMENT_AREA;

// --- Canvas setup ---
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// --- UI elements ---
const btnConnect = document.getElementById('btnConnect');
const btnConnectPrinter = document.getElementById('btnConnectPrinter');
const btnRecord = document.getElementById('btnRecord');
const btnStop = document.getElementById('btnStop');
const btnClear = document.getElementById('btnClear');
const btnExport = document.getElementById('btnExport');
const btnUndo = document.getElementById('btnUndo');
const btnEmergencyStop = document.getElementById('btnEmergencyStop');
const recIndicator = document.getElementById('recIndicator');

// --- Settings ---
const lineWidthSlider = document.getElementById('lineWidth');

lineWidthSlider.addEventListener('input', () => {
    document.getElementById('lineWidthVal').textContent = lineWidthSlider.value;
});

// ============================================
// UTILITY
// ============================================

function mapRange(value, inMin, inMax, outMin, outMax) {
    return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
}

// ============================================
// BLE CONNECTION (Watch)
// ============================================

// Nordic UART Service UUIDs (built into Bangle.js)
const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // receive from watch

async function connectWatch() {
    try {
        btnConnect.textContent = 'Connecting...';
        btnConnect.disabled = true;

        // Request BLE device with Nordic UART service
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'Bangle' }],
            optionalServices: [UART_SERVICE]
        });

        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);

        const server = await bleDevice.gatt.connect();
        const service = await server.getPrimaryService(UART_SERVICE);
        bleCharacteristic = await service.getCharacteristic(UART_RX);

        // Subscribe to notifications
        await bleCharacteristic.startNotifications();
        bleCharacteristic.addEventListener('characteristicvaluechanged', onUartData);

        // Update UI
        document.getElementById('bleStatus').className = 'status-dot dot-green';
        document.getElementById('bleText').textContent = 'Watch: Connected';
        btnConnect.textContent = 'Connected';
        btnRecord.disabled = false;

        console.log('Connected to Bangle.js!');

    } catch (error) {
        console.error('BLE connection failed:', error);
        btnConnect.textContent = 'Connect Watch';
        btnConnect.disabled = false;
        document.getElementById('bleStatus').className = 'status-dot dot-red';
        document.getElementById('bleText').textContent = 'Watch: Failed - ' + error.message;
    }
}

function onDisconnected() {
    document.getElementById('bleStatus').className = 'status-dot dot-red';
    document.getElementById('bleText').textContent = 'Watch: Disconnected';
    btnConnect.textContent = 'Reconnect';
    btnConnect.disabled = false;
    btnRecord.disabled = true;
    stopRecording();
    bleCharacteristic = null;
}

// ============================================
// PRINTER SERIAL CONNECTION (Web Serial API)
// ============================================

function togglePrinter() {
    if (printerConnected) {
        disconnectPrinter();
    } else {
        connectPrinter();
    }
}

async function connectPrinter() {
    if (!('serial' in navigator)) {
        alert('Web Serial API not supported. Please use Chrome or Edge browser.');
        return;
    }

    try {
        btnConnectPrinter.textContent = 'Connecting...';
        btnConnectPrinter.disabled = true;

        // Request serial port (user selects from dialog)
        serialPort = await navigator.serial.requestPort();

        // Ultimaker 2+ uses 250000 baud by default
        await serialPort.open({ baudRate: 250000 });

        // Set up writer
        const encoder = new TextEncoderStream();
        encoder.readable.pipeTo(serialPort.writable);
        serialWriter = encoder.writable.getWriter();

        // Set up reader
        const decoder = new TextDecoderStream();
        serialPort.readable.pipeTo(decoder.writable);
        serialReader = decoder.readable.getReader();

        printerConnected = true;
        printerReady = true;

        // Poll temperature every 3 seconds (only when queue is idle)
        tempPollInterval = setInterval(() => {
            if (printerConnected && !waitingForOk && commandQueue.length === 0) {
                sendGcodeCommand('M105');
            }
        }, 3000);

        // Update UI
        document.getElementById('printerStatus').className = 'status-dot dot-green';
        document.getElementById('printerText').textContent = 'Printer: Connected';
        btnConnectPrinter.textContent = 'Disconnect Printer';
        btnConnectPrinter.disabled = false;
        btnEmergencyStop.disabled = false;

        console.log('Printer connected via USB serial!');

        // Start reading printer responses
        readSerialLoop();

    } catch (error) {
        console.error('Printer connection failed:', error);
        btnConnectPrinter.textContent = 'Connect Printer';
        btnConnectPrinter.disabled = false;
        document.getElementById('printerStatus').className = 'status-dot dot-red';
        document.getElementById('printerText').textContent = 'Printer: Failed - ' + error.message;
    }
}

let serialBuffer = ''; // buffer for partial serial data

async function readSerialLoop() {
    try {
        while (printerConnected) {
            const { value, done } = await serialReader.read();
            if (done) break;

            if (value) {
                serialBuffer += value;

                // Process complete lines
                const lines = serialBuffer.split('\n');
                serialBuffer = lines.pop(); // keep incomplete line in buffer

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    console.log('Printer:', trimmed);

                    // Check for "ok" response (can be "ok", "ok T:20.0", etc.)
                    if (trimmed.startsWith('ok') || trimmed === 'start') {
                        waitingForOk = false;
                        processCommandQueue();
                    }

                    // Parse temperature reports (can appear in "ok T:20.0" or standalone "T:20.0")
                    const tempMatch = trimmed.match(/T:([\d.]+)/);
                    if (tempMatch) {
                        document.getElementById('printerTemp').textContent = Math.round(parseFloat(tempMatch[1])) + '\u00B0C';
                    }
                }
            }
        }
    } catch (error) {
        console.error('Serial read error:', error);
        disconnectPrinter();
    }
}

async function sendGcodeCommand(cmd) {
    if (!printerConnected || !serialWriter) return;

    commandQueue.push(cmd);
    processCommandQueue();
}

let okTimeout = null;

async function processCommandQueue() {
    if (waitingForOk || commandQueue.length === 0) return;
    if (!printerConnected || !serialWriter) return;

    const cmd = commandQueue.shift();

    // Internal marker: signals init is complete
    if (cmd === '__INIT_DONE__') {
        printerInitialized = true;
        document.getElementById('printerText').textContent = 'Printer: Ready';
        console.log('Printer initialized and ready!');
        processCommandQueue();
        return;
    }

    waitingForOk = true;

    // Safety timeout: if no "ok" received within 10 seconds, unstick the queue
    // (G28 homing and temp waits are excluded — they take longer)
    if (okTimeout) clearTimeout(okTimeout);
    if (!cmd.startsWith('G28') && !cmd.startsWith('M109') && !cmd.startsWith('M190')) {
        okTimeout = setTimeout(() => {
            if (waitingForOk) {
                console.warn('Timeout waiting for ok, unsticking queue');
                waitingForOk = false;
                processCommandQueue();
            }
        }, 10000);
    }

    try {
        await serialWriter.write(cmd + '\n');
        console.log('Sent:', cmd);
    } catch (error) {
        console.error('Serial write error:', error);
        waitingForOk = false;
        disconnectPrinter();
    }
}

async function initPrinter(withHeating) {
    if (!printerConnected) return;

    document.getElementById('printerText').textContent = 'Printer: Initializing...';

    // Basic setup — always needed
    sendGcodeCommand('G21');  // millimeters
    sendGcodeCommand('G90');  // absolute positioning
    sendGcodeCommand('G28');  // home all axes

    if (withHeating) {
        // Start both heaters simultaneously (don't wait one by one)
        sendGcodeCommand('M104 S200');   // start nozzle heating (no wait)
        sendGcodeCommand('M140 S60');    // start bed heating (no wait)
        sendGcodeCommand('M190 S60');    // now wait for bed temp
        sendGcodeCommand('M109 S200');   // then wait for nozzle temp
        // Prime nozzle after heating
        sendGcodeCommand('G1 Z5 F3000');
        sendGcodeCommand('G1 X5 Y5 F3000');
        sendGcodeCommand('G1 Z0.3 F1000');
        sendGcodeCommand('G1 X50 E10 F500');  // prime line
        sendGcodeCommand('G1 Z5 F3000');
        sendGcodeCommand('G92 E0');

        document.getElementById('printerText').textContent = 'Printer: Heating...';
    }

    // Move to print height and center
    sendGcodeCommand('G1 Z' + LAYER_HEIGHT.toFixed(1) + ' F1000');
    sendGcodeCommand('G1 X' + (BED_X / 2).toFixed(1) + ' Y' + (BED_Y / 2).toFixed(1) + ' F3000');

    // Mark init complete AFTER all init commands finish (queued in order)
    sendGcodeCommand('__INIT_DONE__');

    totalExtruded = 0;
    lastPrinterX = BED_X / 2;
    lastPrinterY = BED_Y / 2;
    // printerInitialized will be set to true when __INIT_DONE__ is processed
}

async function emergencyStop() {
    if (!printerConnected || !serialWriter) return;

    // Clear queue and send emergency stop immediately
    commandQueue = [];
    waitingForOk = false;

    try {
        await serialWriter.write('M112\n'); // emergency stop
        await serialWriter.write('M999\n'); // reset after emergency
    } catch (error) {
        console.error('Emergency stop error:', error);
    }

    document.getElementById('printerText').textContent = 'Printer: EMERGENCY STOP';
    document.getElementById('printerStatus').className = 'status-dot dot-red';
    printerInitialized = false;
}

function disconnectPrinter() {
    printerConnected = false;
    printerReady = false;
    printerInitialized = false;

    if (serialPort) {
        try { serialPort.close(); } catch (e) { /* ignore */ }
    }
    serialPort = null;
    serialWriter = null;
    serialReader = null;
    serialBuffer = '';
    commandQueue = [];
    waitingForOk = false;
    if (okTimeout) clearTimeout(okTimeout);
    if (tempPollInterval) { clearInterval(tempPollInterval); tempPollInterval = null; }

    document.getElementById('printerStatus').className = 'status-dot dot-red';
    document.getElementById('printerText').textContent = 'Printer: Disconnected';
    btnConnectPrinter.textContent = 'Connect Printer';
    btnConnectPrinter.disabled = false;
    btnEmergencyStop.disabled = true;
}

// ============================================
// REAL-TIME PRINTER MOVEMENT
// ============================================

function sendPositionToPrinter(x, y, isPenDown) {
    if (!printerConnected || !printerInitialized) return;

    const now = Date.now();
    if (now - lastSendTime < SEND_INTERVAL) return; // throttle

    const dx = x - lastPrinterX;
    const dy = y - lastPrinterY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < MIN_MOVE_DIST) return; // skip tiny moves

    const feedRate = parseInt(document.getElementById('printSpeed').value) || 1500;

    if (isPenDown) {
        // Extrude while moving
        totalExtruded += dist * EXTRUSION_MULTIPLIER;
        sendGcodeCommand('G1 X' + x.toFixed(2) + ' Y' + y.toFixed(2) + ' E' + totalExtruded.toFixed(4) + ' F' + feedRate);
    } else {
        // Travel move (no extrusion)
        sendGcodeCommand('G0 X' + x.toFixed(2) + ' Y' + y.toFixed(2) + ' F3000');
    }

    lastPrinterX = x;
    lastPrinterY = y;
    lastSendTime = now;
}

// ============================================
// MOTION DATA HANDLING
// ============================================

// Buffer for incoming UART data (may arrive in chunks)
let uartBuffer = '';

function onUartData(event) {
    const data = event.target.value;
    const text = new TextDecoder().decode(data);
    uartBuffer += text;

    // Process complete lines
    const lines = uartBuffer.split('\n');
    uartBuffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
        const parts = line.trim().split(',');
        // Accept both 2-value (legacy) and 3-value (with Z) formats
        if (parts.length === 2) {
            const tiltX = parseInt(parts[0]);
            const tiltY = parseInt(parts[1]);
            if (isNaN(tiltX) || isNaN(tiltY)) continue;
            processMotionData(tiltX, tiltY, 100); // default Z = 100 (flat)
        } else if (parts.length === 3) {
            const tiltX = parseInt(parts[0]);
            const tiltY = parseInt(parts[1]);
            const tiltZ = parseInt(parts[2]);
            if (isNaN(tiltX) || isNaN(tiltY) || isNaN(tiltZ)) continue;
            processMotionData(tiltX, tiltY, tiltZ);
        }
    }
}

function processMotionData(tiltX, tiltY, tiltZ) {

    // Update raw tilt display values
    document.getElementById('valX').textContent = tiltX;
    document.getElementById('valY').textContent = tiltY;
    document.getElementById('valZ').textContent = tiltZ;

    // Determine pen state from Z-axis
    // Bangle.js with face UP: Z ≈ -100 (gravity pulls away from screen)
    // Bangle.js tilted sideways or flipped: Z rises toward 0 or positive
    // Pen is DOWN (drawing) when watch face is up (Z < -20)
    // Pen is UP (not drawing) when watch is tilted/raised (Z > -20)
    currentTiltZ = tiltZ;
    penDown = tiltZ < -20;

    // Update pen state display
    const penStateEl = document.getElementById('penState');
    if (penDown) {
        penStateEl.textContent = 'DOWN';
        penStateEl.style.color = '#44ff44';
    } else {
        penStateEl.textContent = 'UP';
        penStateEl.style.color = '#ff4444';
    }

    // Direct position mapping: tilt angle → position on bed
    // tiltX: -100 (left) to +100 (right) → 5mm to 218mm
    // tiltY: inverted so tilt forward = cursor moves up on bed
    cursorX = mapRange(tiltX, -100, 100, 5, BED_X - 5);
    cursorY = mapRange(-tiltY, -100, 100, 5, BED_Y - 5);

    // Clamp to bed boundaries
    cursorX = Math.max(5, Math.min(BED_X - 5, cursorX));
    cursorY = Math.max(5, Math.min(BED_Y - 5, cursorY));

    // Update position display
    document.getElementById('valPX').textContent = cursorX.toFixed(1);
    document.getElementById('valPY').textContent = cursorY.toFixed(1);

    // Send to printer in real-time (always, not just when recording)
    if (isRecording) {
        sendPositionToPrinter(cursorX, cursorY, penDown);
    }

    // Record path on canvas
    if (isRecording && penDown) {
        currentPath.push({ x: cursorX, y: cursorY });

        // Update point count
        const totalPoints = allPaths.reduce((sum, p) => sum + p.length, 0) + currentPath.length;
        document.getElementById('pointCount').textContent = 'Points: ' + totalPoints;
    } else if (isRecording && !penDown && currentPath.length > 1) {
        // Pen lifted — save current segment, start a new one when pen comes down
        allPaths.push([...currentPath]);
        currentPath = [];
    }

    // Redraw canvas
    drawCanvas();
}

// ============================================
// RECORDING CONTROLS
// ============================================

function startHeating() {
    if (!printerConnected) {
        alert('Connect printer first');
        return;
    }
    console.log('Sending heating commands directly...');
    sendGcodeCommand('M104 S200');
    sendGcodeCommand('M140 S60');
    document.getElementById('printerText').textContent = 'Printer: Heating...';
}

function startRecording() {
    isRecording = true;
    currentPath = [];

    console.log('startRecording called, printerConnected:', printerConnected, 'heatToggle:', document.getElementById('heatToggle').checked);

    btnRecord.disabled = true;
    btnStop.disabled = false;
    btnExport.disabled = true;
    recIndicator.style.display = 'block';

    document.getElementById('bleStatus').className = 'status-dot dot-yellow';
    document.getElementById('bleText').textContent = 'Watch: Recording...';

    // Initialize printer each time recording starts
    if (printerConnected) {
        const withHeating = document.getElementById('heatToggle').checked;
        initPrinter(withHeating);
    }
}

function stopRecording() {
    if (!isRecording) return;
    isRecording = false;

    // Save current path if it has points
    if (currentPath.length > 1) {
        allPaths.push([...currentPath]);
    }
    currentPath = [];

    btnRecord.disabled = !bleCharacteristic;
    btnStop.disabled = true;
    btnExport.disabled = allPaths.length === 0;
    btnClear.disabled = allPaths.length === 0;
    btnUndo.disabled = allPaths.length === 0;
    recIndicator.style.display = 'none';

    if (bleCharacteristic) {
        document.getElementById('bleStatus').className = 'status-dot dot-green';
        document.getElementById('bleText').textContent = 'Watch: Connected';
    }

    // Lift printer nozzle when stopping
    if (printerConnected && printerInitialized) {
        sendGcodeCommand('G1 Z5 F3000');
    }
    printerInitialized = false; // re-initialize on next Record
}

function clearDrawing() {
    allPaths = [];
    currentPath = [];
    cursorX = BED_X / 2;
    cursorY = BED_Y / 2;
    document.getElementById('pointCount').textContent = 'Points: 0';
    document.getElementById('valPX').textContent = cursorX.toFixed(0);
    document.getElementById('valPY').textContent = cursorY.toFixed(0);
    btnExport.disabled = true;
    btnClear.disabled = true;
    btnUndo.disabled = true;
    drawCanvas();
}

function undoLast() {
    if (allPaths.length > 0) {
        allPaths.pop();
        const totalPoints = allPaths.reduce((sum, p) => sum + p.length, 0);
        document.getElementById('pointCount').textContent = 'Points: ' + totalPoints;
        btnExport.disabled = allPaths.length === 0;
        btnClear.disabled = allPaths.length === 0;
        btnUndo.disabled = allPaths.length === 0;
        drawCanvas();
    }
}

// ============================================
// CANVAS DRAWING
// ============================================

function drawCanvas() {
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Background grid (represents printer bed)
    drawGrid();

    // Draw all completed paths
    allPaths.forEach((p, index) => {
        drawPath(p, getPathColor(index), false);
    });

    // Draw current recording path
    if (currentPath.length > 0) {
        drawPath(currentPath, '#00ff88', true);
    }

    // Draw cursor
    drawCursor();
}

function drawGrid() {
    const scale = CANVAS_SIZE / BED_X;

    ctx.strokeStyle = '#1a2a44';
    ctx.lineWidth = 1;

    // Grid lines every 10mm
    for (let i = 0; i <= BED_X; i += 10) {
        const pos = i * scale;
        ctx.beginPath();
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, CANVAS_SIZE);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, pos);
        ctx.lineTo(CANVAS_SIZE, pos);
        ctx.stroke();
    }

    // Center crosshair
    ctx.strokeStyle = '#2a3a54';
    ctx.lineWidth = 1;
    const center = CANVAS_SIZE / 2;
    ctx.beginPath();
    ctx.moveTo(center, 0);
    ctx.lineTo(center, CANVAS_SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, center);
    ctx.lineTo(CANVAS_SIZE, center);
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = '#445';
    ctx.font = '12px monospace';
    ctx.fillText('X', CANVAS_SIZE - 15, CANVAS_SIZE / 2 - 5);
    ctx.fillText('Y', CANVAS_SIZE / 2 + 5, 15);

    // Border
    ctx.strokeStyle = '#334';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, CANVAS_SIZE - 2, CANVAS_SIZE - 2);
}

function getPathColor(index) {
    const colors = ['#00d4ff', '#ff6688', '#ffaa00', '#aa66ff', '#44ffaa', '#ff44aa'];
    return colors[index % colors.length];
}

function drawPath(points, color, isActive) {
    if (points.length < 2) return;

    const scale = CANVAS_SIZE / BED_X;
    const width = parseInt(lineWidthSlider.value);

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (isActive) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x * scale, (BED_Y - points[0].y) * scale);

    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x * scale, (BED_Y - points[i].y) * scale);
    }

    ctx.stroke();
    ctx.shadowBlur = 0;

    // Draw start point marker
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(points[0].x * scale, (BED_Y - points[0].y) * scale, 4, 0, Math.PI * 2);
    ctx.fill();
}

function drawCursor() {
    const scale = CANVAS_SIZE / BED_X;
    const cx = cursorX * scale;
    const cy = (BED_Y - cursorY) * scale;

    // Outer ring — color shows pen state
    const cursorColor = !isRecording ? '#ffffff' : (penDown ? '#44ff44' : '#ff4444');
    ctx.strokeStyle = cursorColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.stroke();

    // Center dot
    ctx.fillStyle = cursorColor;
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Crosshair lines
    ctx.globalAlpha = 0.2;
    ctx.strokeStyle = cursorColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, CANVAS_SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(CANVAS_SIZE, cy);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
}

// ============================================
// G-CODE EXPORT (file download — fallback)
// ============================================

function exportGcode() {
    if (allPaths.length === 0) return;

    const feedRate = parseInt(document.getElementById('printSpeed').value) || 1500;

    let gcode = [];

    // Header
    gcode.push('; ==========================================');
    gcode.push('; Generated by Smartwatch Motion Controller');
    gcode.push('; Ultimaker 2+ compatible');
    gcode.push('; Date: ' + new Date().toISOString());
    gcode.push('; Paths: ' + allPaths.length);
    gcode.push('; ==========================================');
    gcode.push('');
    gcode.push('; --- Printer Setup ---');
    gcode.push('G21 ; set units to millimeters');
    gcode.push('G90 ; absolute positioning');
    gcode.push('G28 ; home all axes');
    gcode.push('');
    gcode.push('; --- Heat bed and nozzle (PLA defaults) ---');
    gcode.push('M140 S60 ; set bed temp');
    gcode.push('M105 ; report temp');
    gcode.push('M190 S60 ; wait for bed temp');
    gcode.push('M104 S200 ; set nozzle temp');
    gcode.push('M105 ; report temp');
    gcode.push('M109 S200 ; wait for nozzle temp');
    gcode.push('');
    gcode.push('; --- Prime nozzle ---');
    gcode.push('G1 Z5 F3000 ; lift nozzle');
    gcode.push('G1 X5 Y5 F3000 ; move to corner');
    gcode.push('G1 Z0.3 F1000 ; lower');
    gcode.push('G1 X50 E10 F500 ; prime line');
    gcode.push('G1 Z5 F3000 ; lift');
    gcode.push('G92 E0 ; reset extruder');
    gcode.push('');
    gcode.push('; --- Start Drawing ---');

    let totalE = 0; // extruder position
    const layerHeight = 0.2;
    const lineWidthMM = 0.4;
    const filamentDiameter = 2.85;
    const filamentArea = Math.PI * (filamentDiameter / 2) * (filamentDiameter / 2);
    const extrusionMultiplier = (layerHeight * lineWidthMM) / filamentArea;

    allPaths.forEach((pathPoints, pathIndex) => {
        gcode.push('');
        gcode.push('; --- Path ' + (pathIndex + 1) + ' (' + pathPoints.length + ' points) ---');

        // Simplify path to reduce G-code size
        const simplified = simplifyPath(pathPoints, 0.5);

        // Move to start of path (travel move - no extrusion)
        gcode.push('G1 Z' + (layerHeight + 2).toFixed(1) + ' F3000 ; lift for travel');
        gcode.push('G1 X' + simplified[0].x.toFixed(2) + ' Y' + simplified[0].y.toFixed(2) + ' F3000 ; travel to start');
        gcode.push('G1 Z' + layerHeight.toFixed(1) + ' F1000 ; lower to print height');

        // Draw path
        for (let i = 1; i < simplified.length; i++) {
            const dx = simplified[i].x - simplified[i - 1].x;
            const dy = simplified[i].y - simplified[i - 1].y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            totalE += dist * extrusionMultiplier;

            gcode.push(
                'G1 X' + simplified[i].x.toFixed(2) +
                ' Y' + simplified[i].y.toFixed(2) +
                ' E' + totalE.toFixed(4) +
                ' F' + feedRate
            );
        }
    });

    // Footer
    gcode.push('');
    gcode.push('; --- End ---');
    gcode.push('G1 Z10 F3000 ; lift nozzle');
    gcode.push('G1 X5 Y' + (BED_Y - 5).toFixed(0) + ' F3000 ; move to back');
    gcode.push('M104 S0 ; turn off nozzle');
    gcode.push('M140 S0 ; turn off bed');
    gcode.push('M84 ; disable motors');
    gcode.push('M107 ; turn off fan');

    // Download file
    const blob = new Blob([gcode.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'smartwatch_drawing_' + Date.now() + '.gcode';
    a.click();
    URL.revokeObjectURL(url);
}

// Simplify path using Douglas-Peucker algorithm
function simplifyPath(points, tolerance) {
    if (points.length <= 2) return points;

    let maxDist = 0;
    let maxIndex = 0;

    const first = points[0];
    const last = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
        const dist = perpendicularDistance(points[i], first, last);
        if (dist > maxDist) {
            maxDist = dist;
            maxIndex = i;
        }
    }

    if (maxDist > tolerance) {
        const left = simplifyPath(points.slice(0, maxIndex + 1), tolerance);
        const right = simplifyPath(points.slice(maxIndex), tolerance);
        return left.slice(0, -1).concat(right);
    } else {
        return [first, last];
    }
}

function perpendicularDistance(point, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len === 0) {
        const ddx = point.x - lineStart.x;
        const ddy = point.y - lineStart.y;
        return Math.sqrt(ddx * ddx + ddy * ddy);
    }

    return Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x) / len;
}

// ============================================
// DEMO MODE (mouse drawing for testing)
// ============================================

let mouseDown = false;

canvas.addEventListener('mousedown', (e) => {
    if (bleCharacteristic) return;
    mouseDown = true;
    const rect = canvas.getBoundingClientRect();
    const scale = BED_X / CANVAS_SIZE;
    cursorX = (e.clientX - rect.left) * scale;
    cursorY = BED_Y - (e.clientY - rect.top) * scale;
    currentPath = [{ x: cursorX, y: cursorY }];
    isRecording = true;
    penDown = true;
    recIndicator.style.display = 'block';
    drawCanvas();
});

canvas.addEventListener('mousemove', (e) => {
    if (!mouseDown) return;
    const rect = canvas.getBoundingClientRect();
    const scale = BED_X / CANVAS_SIZE;
    cursorX = Math.max(5, Math.min(BED_X - 5, (e.clientX - rect.left) * scale));
    cursorY = Math.max(5, Math.min(BED_Y - 5, BED_Y - (e.clientY - rect.top) * scale));

    document.getElementById('valPX').textContent = cursorX.toFixed(1);
    document.getElementById('valPY').textContent = cursorY.toFixed(1);

    currentPath.push({ x: cursorX, y: cursorY });

    // Also send to printer in real-time during mouse drawing
    sendPositionToPrinter(cursorX, cursorY, true);

    const totalPoints = allPaths.reduce((sum, p) => sum + p.length, 0) + currentPath.length;
    document.getElementById('pointCount').textContent = 'Points: ' + totalPoints;

    drawCanvas();
});

canvas.addEventListener('mouseup', () => {
    if (!mouseDown) return;
    mouseDown = false;
    isRecording = false;
    recIndicator.style.display = 'none';

    if (currentPath.length > 1) {
        allPaths.push([...currentPath]);
    }
    currentPath = [];

    btnExport.disabled = allPaths.length === 0;
    btnClear.disabled = allPaths.length === 0;
    btnUndo.disabled = allPaths.length === 0;
    drawCanvas();
});

// ============================================
// INIT
// ============================================

drawCanvas();
console.log('Smartwatch Motion Controller ready.');
console.log('No watch? Draw with your mouse on the canvas to test!');
