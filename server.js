import express from "express";
import Database from "better-sqlite3";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";
import ExcelJS from "exceljs";

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });
const db = new Database(process.env.DATABASE_PATH || join(dataDir, "my-trucks.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS vehicles (id TEXT PRIMARY KEY, driver_id TEXT, vehicle_number TEXT NOT NULL UNIQUE, rate_per_quantity REAL NOT NULL DEFAULT 14, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(driver_id) REFERENCES drivers(id));
  CREATE TABLE IF NOT EXISTS daily_entries (id TEXT PRIMARY KEY, date TEXT NOT NULL, vehicle_id TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, FOREIGN KEY(vehicle_id) REFERENCES vehicles(id), UNIQUE(date, vehicle_id));
  CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, date TEXT NOT NULL, vehicle_id TEXT NOT NULL, amount REAL NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT, updated_by TEXT, voided_at TEXT, voided_by TEXT, FOREIGN KEY(vehicle_id) REFERENCES vehicles(id));
  CREATE INDEX IF NOT EXISTS entries_month_idx ON daily_entries(date, vehicle_id);
  CREATE INDEX IF NOT EXISTS payments_month_idx ON payments(date, vehicle_id);
  CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL);
`);

const paymentColumns = new Set(db.prepare("PRAGMA table_info(payments)").all().map(column => column.name));
for (const [column, definition] of Object.entries({ updated_at: "TEXT", updated_by: "TEXT", voided_at: "TEXT", voided_by: "TEXT" })) {
  if (!paymentColumns.has(column)) db.exec(`ALTER TABLE payments ADD COLUMN ${column} ${definition}`);
}

const iso = () => new Date().toISOString();
const idPart = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";

const insertAudit = db.prepare("INSERT INTO audit_logs (id, timestamp, actor, action, details) VALUES (?, ?, ?, ?, ?)");
function logAudit(actor, action, details) {
  insertAudit.run(crypto.randomUUID(), iso(), String(actor).slice(0, 80), action, details);
}

function seedWorkbook() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM vehicles").get().count;
  if (count) return;
  const seed = JSON.parse(readFileSync(join(dataDir, "vehicle-register-seed.json"), "utf8"));
  const timestamp = iso();
  const vehicleMap = new Map();
  for (const month of seed.months) for (const vehicle of month.vehicles) {
    const previous = vehicleMap.get(vehicle.vehicleNumber);
    vehicleMap.set(vehicle.vehicleNumber, {
      driverName: vehicle.driverName !== "Unassigned" ? vehicle.driverName : previous?.driverName || "Unassigned",
      vehicleNumber: String(vehicle.vehicleNumber),
      ratePerQuantity: Number(vehicle.ratePerQuantity || previous?.ratePerQuantity || 14)
    });
  }
  const driverNames = [...new Set([...vehicleMap.values()].map(v => v.driverName).filter(name => name !== "Unassigned"))];
  const driverIds = new Map();
  const vehicleIds = new Map();
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES (?,?,?)");
  const insertDriver = db.prepare("INSERT INTO drivers (id,name,active,sort_order,created_at,updated_at) VALUES (?,?,1,?,?,?)");
  const insertVehicle = db.prepare("INSERT INTO vehicles (id,driver_id,vehicle_number,rate_per_quantity,active,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?)");
  const insertEntry = db.prepare("INSERT OR IGNORE INTO daily_entries (id,date,vehicle_id,quantity,note,version,updated_at,updated_by) VALUES (?,?,?,?,?,1,?,?)");
  const insertPayment = db.prepare("INSERT OR IGNORE INTO payments (id,date,vehicle_id,amount,note,created_at,created_by) VALUES (?,?,?,?,?,?,?)");
  db.transaction(() => {
    insertSetting.run("revision", "1", timestamp);
    insertSetting.run("units_per_mt", "20", timestamp);
    driverNames.forEach((name, index) => {
      const id = `driver-${idPart(name)}-${index + 1}`;
      driverIds.set(name, id);
      insertDriver.run(id, name, index, timestamp, timestamp);
    });
    [...vehicleMap.values()].forEach((vehicle, index) => {
      const id = `vehicle-${idPart(vehicle.vehicleNumber)}-${index + 1}`;
      vehicleIds.set(vehicle.vehicleNumber, id);
      insertVehicle.run(id, driverIds.get(vehicle.driverName) || null, vehicle.vehicleNumber, vehicle.ratePerQuantity, index, timestamp, timestamp);
    });
    let e = 0, p = 0;
    for (const month of seed.months) {
      for (const entry of month.dailyEntries) {
        const vehicleId = vehicleIds.get(String(entry.vehicleNumber));
        if (vehicleId) insertEntry.run(`seed-entry-${++e}`, entry.date, vehicleId, entry.quantity, "", timestamp, "Imported workbook");
      }
      for (const payment of month.payments) {
        const vehicleId = vehicleIds.get(String(payment.vehicleNumber));
        if (vehicleId) insertPayment.run(`seed-payment-${++p}`, payment.date, vehicleId, payment.amount, "Imported workbook payment", timestamp, "Imported workbook");
      }
    }
    logAudit("System", "Import", "Imported initial seed data from workbook");
  })();
}
seedWorkbook();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(root, "public"), { etag: true, maxAge: "1h" }));
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/live" });
const presence = new Map();

function bumpRevision() {
  db.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + 1, updated_at = ? WHERE key = 'revision'").run(iso());
  const revision = Number(db.prepare("SELECT value FROM settings WHERE key='revision'").pluck().get() || 1);
  const message = JSON.stringify({ type: "refresh", revision });
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(message);
  return revision;
}

function activeUsers() {
  const cutoff = Date.now() - 45_000;
  for (const [id, user] of presence) if (user.seen < cutoff) presence.delete(id);
  return [...presence.entries()].slice(0, 5).map(([clientId, user]) => ({ clientId, displayName: user.name, lastSeen: new Date(user.seen).toISOString() }));
}

app.get("/api/dashboard", (req, res) => {
  const latest = db.prepare("SELECT MAX(substr(date,1,7)) FROM daily_entries").pluck().get() || new Date().toISOString().slice(0,7);
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : latest;
  const settings = Object.fromEntries(db.prepare("SELECT key,value FROM settings").all().map(r => [r.key, r.value]));
  res.set("Cache-Control", "no-store").json({
    month,
    revision: Number(settings.revision || 1),
    unitsPerMt: Number(settings.units_per_mt || 20),
    vehicles: db.prepare("SELECT v.id, v.driver_id driverId, v.vehicle_number vehicleNumber, v.rate_per_quantity ratePerQuantity, v.sort_order sortOrder, COALESCE(d.name,'Unassigned') driverName FROM vehicles v LEFT JOIN drivers d ON d.id=v.driver_id WHERE v.active=1 ORDER BY v.sort_order,v.vehicle_number").all(),
    entries: db.prepare("SELECT e.id,e.date,e.vehicle_id vehicleId,e.quantity,e.note,e.version,e.updated_at updatedAt,e.updated_by updatedBy FROM daily_entries e JOIN vehicles v ON v.id=e.vehicle_id WHERE substr(e.date,1,7)=? AND v.active=1 ORDER BY e.date").all(month),
    payments: db.prepare("SELECT p.id,p.date,p.vehicle_id vehicleId,p.amount,p.note,p.created_at createdAt,p.created_by createdBy,p.updated_at updatedAt,p.updated_by updatedBy FROM payments p JOIN vehicles v ON v.id=p.vehicle_id WHERE substr(p.date,1,7)=? AND p.voided_at IS NULL AND v.active=1 ORDER BY p.date DESC,p.created_at DESC").all(month),
    availableMonths: db.prepare("SELECT DISTINCT substr(date,1,7) month FROM daily_entries UNION SELECT DISTINCT substr(date,1,7) FROM payments ORDER BY month DESC").all().map(r => r.month),
    activeUsers: activeUsers(),
    source: "Vehicle Register Q2 26-27.xlsx"
  });
});

app.post("/api/presence", (req, res) => {
  const clientId = String(req.body.clientId || "").slice(0,80);
  const name = String(req.body.actor || "Operator").trim().slice(0,80);
  if (!clientId) return res.status(400).json({ error: "clientId is required" });
  presence.set(clientId, { name, seen: Date.now() });
  res.json({ ok: true, activeUsers: activeUsers() });
});

app.post("/api/entries", (req, res) => {
  const { date, vehicleId } = req.body;
  const quantity = Number(req.body.quantity);
  const actor = String(req.body.actor || "Operator").slice(0,80);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !vehicleId || !Number.isFinite(quantity) || quantity < 0) return res.status(400).json({ error: "Valid date, vehicle and non-negative quantity are required" });
  const existing = db.prepare("SELECT id,version FROM daily_entries WHERE date=? AND vehicle_id=?").get(date, vehicleId);
  if (existing && req.body.version != null && Number(req.body.version) !== existing.version) return res.status(409).json({ error: "Another user updated this quantity. The latest value has been loaded." });
  const timestamp = iso();
  db.transaction(() => {
    if (existing) {
      db.prepare("UPDATE daily_entries SET quantity=?,note=?,version=version+1,updated_at=?,updated_by=? WHERE id=?").run(quantity, String(req.body.note || ""), timestamp, actor, existing.id);
      logAudit(actor, "Updated Quantity", `Updated quantity to ${quantity} for vehicle ${vehicleId} on ${date}`);
    } else if (quantity > 0) {
      db.prepare("INSERT INTO daily_entries (id,date,vehicle_id,quantity,note,version,updated_at,updated_by) VALUES (?,?,?,?,?,1,?,?)").run(crypto.randomUUID(), date, vehicleId, quantity, String(req.body.note || ""), timestamp, actor);
      logAudit(actor, "Added Quantity", `Set quantity to ${quantity} for vehicle ${vehicleId} on ${date}`);
    }
    bumpRevision();
  })();
  res.json({ ok: true });
});

app.post("/api/vehicles", (req, res) => {
  const driverName = String(req.body.driverName || "").trim();
  const vehicleNumber = String(req.body.vehicleNumber || "").trim();
  const rate = Number(req.body.ratePerQuantity);
  if (!driverName || !vehicleNumber || !Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: "Driver, vehicle number and valid rate are required" });
  if (db.prepare("SELECT id FROM vehicles WHERE lower(vehicle_number)=lower(?)").get(vehicleNumber)) return res.status(409).json({ error: "This vehicle number already exists" });
  const timestamp = iso();
  db.transaction(() => {
    let driver = db.prepare("SELECT id FROM drivers WHERE lower(name)=lower(?)").get(driverName);
    if (!driver) {
      driver = { id: crypto.randomUUID() };
      const order = db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 value FROM drivers").get().value;
      db.prepare("INSERT INTO drivers (id,name,active,sort_order,created_at,updated_at) VALUES (?,?,1,?,?,?)").run(driver.id, driverName, order, timestamp, timestamp);
    }
    const order = db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 value FROM vehicles").get().value;
    db.prepare("INSERT INTO vehicles (id,driver_id,vehicle_number,rate_per_quantity,active,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?)").run(crypto.randomUUID(), driver.id, vehicleNumber, rate, order, timestamp, timestamp);
    logAudit(String(req.body.actor || "Operator").slice(0,80), "Added Vehicle", `Added vehicle ${vehicleNumber} for driver ${driverName}`);
    bumpRevision();
  })();
  res.status(201).json({ ok: true });
});

app.patch("/api/vehicles/:id", (req, res) => {
  const vehicleId = String(req.params.id);
  const driverName = String(req.body.driverName || "").trim();
  const vehicleNumber = String(req.body.vehicleNumber || "").trim();
  const rate = Number(req.body.ratePerQuantity);
  if (!driverName || !vehicleNumber || !Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: "Driver, vehicle number and valid rate are required" });
  const current = db.prepare("SELECT id,driver_id driverId FROM vehicles WHERE id=? AND active=1").get(vehicleId);
  if (!current) return res.status(404).json({ error: "Vehicle not found" });
  const duplicate = db.prepare("SELECT id FROM vehicles WHERE lower(vehicle_number)=lower(?) AND id<>? AND active=1").get(vehicleNumber, vehicleId);
  if (duplicate) return res.status(409).json({ error: "This vehicle number already exists" });
  const timestamp = iso();
  db.transaction(() => {
    let driver = db.prepare("SELECT id FROM drivers WHERE lower(name)=lower(?) AND active=1").get(driverName);
    if (!driver) {
      const vehicleCount = current.driverId ? db.prepare("SELECT COUNT(*) count FROM vehicles WHERE driver_id=? AND active=1").get(current.driverId).count : 0;
      if (current.driverId && vehicleCount === 1) {
        db.prepare("UPDATE drivers SET name=?,updated_at=? WHERE id=?").run(driverName, timestamp, current.driverId);
        driver = { id: current.driverId };
      } else {
        driver = { id: crypto.randomUUID() };
        const order = db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 value FROM drivers").get().value;
        db.prepare("INSERT INTO drivers (id,name,active,sort_order,created_at,updated_at) VALUES (?,?,1,?,?,?)").run(driver.id, driverName, order, timestamp, timestamp);
      }
    }
    db.prepare("UPDATE vehicles SET driver_id=?,vehicle_number=?,rate_per_quantity=?,updated_at=? WHERE id=?").run(driver.id, vehicleNumber, rate, timestamp, vehicleId);
    logAudit(String(req.body.actor || "Operator").slice(0,80), "Edited Vehicle", `Updated vehicle ${vehicleNumber} for driver ${driverName}`);
    bumpRevision();
  })();
  res.json({ ok: true });
});

app.delete("/api/vehicles/:id", (req, res) => {
  const vehicle = db.prepare("SELECT id FROM vehicles WHERE id=? AND active=1").get(req.params.id);
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });
  db.transaction(() => {
    db.prepare("UPDATE vehicles SET active=0,updated_at=? WHERE id=?").run(iso(), req.params.id);
    logAudit(String(req.body?.actor || "Operator").slice(0,80), "Deleted Vehicle", `Deleted vehicle with ID ${req.params.id}`);
    bumpRevision();
  })();
  res.json({ ok: true, retainedHistory: true });
});

app.delete("/api/drivers/:id", (req, res) => {
  const driver = db.prepare("SELECT id FROM drivers WHERE id=? AND active=1").get(req.params.id);
  if (!driver) return res.status(404).json({ error: "Driver not found" });
  const timestamp = iso();
  db.transaction(() => {
    db.prepare("UPDATE drivers SET active=0,updated_at=? WHERE id=?").run(timestamp, req.params.id);
    db.prepare("UPDATE vehicles SET active=0,updated_at=? WHERE driver_id=?").run(timestamp, req.params.id);
    logAudit(String(req.body?.actor || "Operator").slice(0,80), "Deleted Driver", `Deleted driver with ID ${req.params.id} and assigned vehicles`);
    bumpRevision();
  })();
  res.json({ ok: true, retainedHistory: true });
});

app.post("/api/payments", (req, res) => {
  const amount = Number(req.body.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.date) || !req.body.vehicleId || !Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: "Valid date, vehicle and non-zero amount are required" });
  db.transaction(() => {
    const actor = String(req.body.actor || "Operator").slice(0,80);
    db.prepare("INSERT INTO payments (id,date,vehicle_id,amount,note,created_at,created_by) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), req.body.date, req.body.vehicleId, amount, String(req.body.note || ""), iso(), actor);
    logAudit(actor, "Recorded Payment", `Recorded ₹${amount} payment for vehicle ${req.body.vehicleId}`);
    bumpRevision();
  })();
  res.status(201).json({ ok: true });
});

app.patch("/api/payments/:id", (req, res) => {
  const amount = Number(req.body.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.date) || !req.body.vehicleId || !Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: "Valid date, vehicle and non-zero amount are required" });
  const payment = db.prepare("SELECT id FROM payments WHERE id=? AND voided_at IS NULL").get(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  const timestamp = iso();
  const actor = String(req.body.actor || "Operator").slice(0,80);
  db.transaction(() => {
    db.prepare("UPDATE payments SET date=?,vehicle_id=?,amount=?,note=?,updated_at=?,updated_by=? WHERE id=?").run(req.body.date, req.body.vehicleId, amount, String(req.body.note || ""), timestamp, actor, req.params.id);
    logAudit(actor, "Updated Payment", `Updated payment to ₹${amount} for vehicle ${req.body.vehicleId}`);
    bumpRevision();
  })();
  res.json({ ok: true });
});

app.delete("/api/payments/:id", (req, res) => {
  const payment = db.prepare("SELECT id FROM payments WHERE id=? AND voided_at IS NULL").get(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  db.transaction(() => {
    const actor = String(req.body?.actor || "Operator").slice(0,80);
    db.prepare("UPDATE payments SET voided_at=?,voided_by=? WHERE id=?").run(iso(), actor, req.params.id);
    logAudit(actor, "Deleted Payment", `Deleted payment with ID ${req.params.id}`);
    bumpRevision();
  })();
  res.json({ ok: true, retainedHistory: true });
});

app.patch("/api/settings", (req, res) => {
  const unitsPerMt = Number(req.body.unitsPerMt);
  if (!Number.isFinite(unitsPerMt) || unitsPerMt <= 0) return res.status(400).json({ error: "Quantity units per MT must be greater than zero" });
  db.transaction(() => {
    db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('units_per_mt',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(String(unitsPerMt), iso());
    logAudit(String(req.body?.actor || "Operator").slice(0,80), "Updated Settings", `Changed units per MT to ${unitsPerMt}`);
    bumpRevision();
  })();
  res.json({ ok: true });
});

function excelColumn(number) {
  let label = "";
  for (let value = number; value > 0; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  return label;
}

app.get("/api/export", async (req, res, next) => {
  try {
    const latest = db.prepare("SELECT MAX(substr(date,1,7)) FROM daily_entries").pluck().get() || new Date().toISOString().slice(0,7);
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : latest;
    const unitsPerMt = Number(db.prepare("SELECT value FROM settings WHERE key='units_per_mt'").pluck().get() || 20);
    const vehicles = db.prepare("SELECT v.id,v.vehicle_number vehicleNumber,v.rate_per_quantity ratePerQuantity,COALESCE(d.name,'Unassigned') driverName FROM vehicles v LEFT JOIN drivers d ON d.id=v.driver_id WHERE v.active=1 ORDER BY v.sort_order,v.vehicle_number").all();
    const entries = db.prepare("SELECT e.date,e.vehicle_id vehicleId,e.quantity FROM daily_entries e JOIN vehicles v ON v.id=e.vehicle_id WHERE substr(e.date,1,7)=? AND v.active=1 ORDER BY e.date").all(month);
    const payments = db.prepare("SELECT p.id,p.date,p.vehicle_id vehicleId,p.amount,p.note,p.created_by createdBy FROM payments p JOIN vehicles v ON v.id=p.vehicle_id WHERE substr(p.date,1,7)=? AND p.voided_at IS NULL AND v.active=1 ORDER BY p.date,p.created_at").all(month);
    const [year, monthNumber] = month.split("-").map(Number);
    const days = Array.from({ length: new Date(Date.UTC(year, monthNumber, 0)).getUTCDate() }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
    const entryMap = new Map(entries.map(entry => [`${entry.date}|${entry.vehicleId}`, Number(entry.quantity)]));
    const paidByVehicle = new Map(vehicles.map(vehicle => [vehicle.id, payments.filter(payment => payment.vehicleId === vehicle.id).reduce((sum, payment) => sum + Number(payment.amount), 0)]));
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "My Trucks Dashboard";
    workbook.created = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;
    workbook.calcProperties.forceFullCalc = true;
    const monthName = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
    const navy = "2C3B4D", peach = "FDB995", line = "E3E8ED";
    const statusStyle = {
      Underpaid: { fill: "FFF6D8", font: "9A6A00" },
      Paid: { fill: "E8F7EF", font: "25885D" },
      Excess: { fill: "FDECEC", font: "C94F4F" }
    };

    const setup = workbook.addWorksheet("Setup", { views: [{ showGridLines: false }] });
    setup.columns = [{ width: 30 }, { width: 18 }];
    setup.addRow(["My Trucks Export Settings", "Value"]);
    setup.addRow(["Quantity units equal to 1 MT", unitsPerMt]);
    setup.addRow(["Export month", monthName]);
    setup.getRow(1).eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } }; cell.font = { bold: true, color: { argb: "FFFFFF" } }; });
    setup.getCell("B2").numFmt = "#,##0.00";

    const register = workbook.addWorksheet("Monthly Register", { views: [{ state: "frozen", xSplit: 3, ySplit: 4, showGridLines: false }] });
    const lastColumn = 3 + vehicles.length;
    register.mergeCells(1, 1, 1, lastColumn);
    register.getCell(1, 1).value = `My Trucks — ${monthName}`;
    register.getCell(1, 1).font = { bold: true, size: 18, color: { argb: "FFFFFF" } };
    register.getCell(1, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } };
    register.getCell(1, 1).alignment = { vertical: "middle" };
    register.getRow(1).height = 32;
    register.mergeCells(2, 1, 2, lastColumn);
    register.getCell(2, 1).value = "Yellow = Underpaid · Green = Paid · Red = Excess · Change Qty-to-MT conversion on the Setup sheet";
    register.getCell(2, 1).font = { italic: true, size: 10, color: { argb: "687583" } };
    register.getRow(4).values = ["Date", "Total Qty", "MTs", ...vehicles.map(vehicle => `${vehicle.driverName}\n${vehicle.vehicleNumber}`)];
    register.getRow(4).height = 44;
    register.getRow(4).eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "F4F6F8" } }; cell.font = { bold: true, color: { argb: "17232F" } }; cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true }; cell.border = { bottom: { style: "thin", color: { argb: line } } }; });
    register.getColumn(1).width = 14;
    register.getColumn(2).width = 13;
    register.getColumn(3).width = 11;
    vehicles.forEach((_, index) => register.getColumn(index + 4).width = 17);
    days.forEach((date, dayIndex) => {
      const rowNumber = dayIndex + 5;
      const row = register.getRow(rowNumber);
      row.getCell(1).value = new Date(`${date}T00:00:00Z`);
      row.getCell(1).numFmt = "dd-mmm-yyyy";
      vehicles.forEach((vehicle, vehicleIndex) => row.getCell(vehicleIndex + 4).value = entryMap.get(`${date}|${vehicle.id}`) || null);
      row.getCell(2).value = { formula: `SUM(D${rowNumber}:${excelColumn(lastColumn)}${rowNumber})` };
      row.getCell(3).value = { formula: `B${rowNumber}/'Setup'!$B$2` };
      row.getCell(2).numFmt = "#,##0.00";
      row.getCell(3).numFmt = "#,##0.00";
      row.eachCell({ includeEmpty: true }, cell => { cell.border = { bottom: { style: "hair", color: { argb: "EDF0F3" } } }; cell.alignment = { vertical: "middle", horizontal: cell.col === 1 ? "left" : "right" }; if (cell.col >= 4) cell.numFmt = "#,##0.00"; });
    });
    const totalRowNumber = days.length + 5;
    const totalRow = register.getRow(totalRowNumber);
    totalRow.getCell(1).value = "MONTH TOTAL";
    totalRow.getCell(2).value = { formula: `SUM(B5:B${totalRowNumber - 1})` };
    totalRow.getCell(3).value = { formula: `B${totalRowNumber}/'Setup'!$B$2` };
    vehicles.forEach((_, index) => totalRow.getCell(index + 4).value = { formula: `SUM(${excelColumn(index + 4)}5:${excelColumn(index + 4)}${totalRowNumber - 1})` });
    totalRow.eachCell({ includeEmpty: true }, cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } }; cell.font = { bold: true, color: { argb: "FFFFFF" } }; cell.numFmt = "#,##0.00"; });
    register.autoFilter = { from: { row: 4, column: 1 }, to: { row: totalRowNumber - 1, column: lastColumn } };

    const settlement = workbook.addWorksheet("Settlement", { views: [{ state: "frozen", ySplit: 3, showGridLines: false }] });
    settlement.mergeCells("A1:H1");
    settlement.getCell("A1").value = `Settlement — ${monthName}`;
    settlement.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } };
    settlement.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFF" } };
    settlement.getRow(3).values = ["Driver", "Vehicle", "Rate / Qty", "Monthly Qty", "Payable", "Paid", "Balance", "Status"];
    settlement.getRow(3).eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: peach } }; cell.font = { bold: true, color: { argb: "17232F" } }; });
    settlement.columns = [{ width: 22 }, { width: 18 }, { width: 14 }, { width: 15 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 14 }];
    vehicles.forEach((vehicle, index) => {
      const rowNumber = index + 4;
      const registerColumn = excelColumn(index + 4);
      const quantity = entries.filter(entry => entry.vehicleId === vehicle.id).reduce((sum, entry) => sum + Number(entry.quantity), 0);
      const payable = quantity * Number(vehicle.ratePerQuantity);
      const paid = paidByVehicle.get(vehicle.id) || 0;
      const balance = payable - paid;
      const status = Math.abs(balance) < 0.01 ? "Paid" : balance > 0 ? "Underpaid" : "Excess";
      const row = settlement.getRow(rowNumber);
      row.values = [vehicle.driverName, vehicle.vehicleNumber, Number(vehicle.ratePerQuantity), { formula: `'Monthly Register'!${registerColumn}${totalRowNumber}`, result: quantity }, { formula: `C${rowNumber}*D${rowNumber}`, result: payable }, paid, { formula: `E${rowNumber}-F${rowNumber}`, result: balance }, { formula: `IF(ABS(G${rowNumber})<0.01,"Paid",IF(G${rowNumber}>0,"Underpaid","Excess"))`, result: status }];
      [3, 4].forEach(column => row.getCell(column).numFmt = "#,##0.00");
      [5, 6, 7].forEach(column => row.getCell(column).numFmt = "₹#,##0.00");
      row.getCell(8).fill = { type: "pattern", pattern: "solid", fgColor: { argb: statusStyle[status].fill } };
      row.getCell(8).font = { bold: true, color: { argb: statusStyle[status].font } };
      row.eachCell(cell => cell.border = { bottom: { style: "hair", color: { argb: line } } });
    });
    settlement.autoFilter = { from: "A3", to: `H${Math.max(3, vehicles.length + 3)}` };

    const paymentSheet = workbook.addWorksheet("Payments", { views: [{ state: "frozen", ySplit: 3, showGridLines: false }] });
    paymentSheet.mergeCells("A1:F1");
    paymentSheet.getCell("A1").value = `Payments — ${monthName}`;
    paymentSheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } };
    paymentSheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFF" } };
    paymentSheet.getRow(3).values = ["Date", "Driver", "Vehicle", "Amount", "Note", "Recorded By"];
    paymentSheet.getRow(3).eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: peach } }; cell.font = { bold: true }; });
    paymentSheet.columns = [{ width: 14 }, { width: 22 }, { width: 18 }, { width: 16 }, { width: 34 }, { width: 20 }];
    payments.forEach((payment, index) => {
      const vehicle = vehicles.find(item => item.id === payment.vehicleId);
      const row = paymentSheet.getRow(index + 4);
      row.values = [new Date(`${payment.date}T00:00:00Z`), vehicle?.driverName || "", vehicle?.vehicleNumber || "", Number(payment.amount), payment.note, payment.createdBy];
      row.getCell(1).numFmt = "dd-mmm-yyyy";
      row.getCell(4).numFmt = "₹#,##0.00";
      row.eachCell(cell => cell.border = { bottom: { style: "hair", color: { argb: line } } });
    });
    paymentSheet.autoFilter = { from: "A3", to: `F${Math.max(3, payments.length + 3)}` };

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `My-Trucks-${month}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", database: "sqlite-wal", websocket: true }));

app.get("/api/audit", (req, res) => {
  const logs = db.prepare("SELECT id, timestamp, actor, action, details FROM audit_logs ORDER BY timestamp DESC LIMIT 200").all();
  res.set("Cache-Control", "no-store").json(logs);
});

app.get("/api/backup", (req, res, next) => {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    const dbPath = process.env.DATABASE_PATH || join(dataDir, "my-trucks.db");
    res.download(dbPath, "my-trucks-backup.db");
  } catch (error) {
    next(error);
  }
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "Unexpected server error" }); });

wss.on("connection", socket => socket.send(JSON.stringify({ type: "connected" })));
const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => {
  console.log(`My Trucks running on http://localhost:${port}`);
  setInterval(() => {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch(e) {}
  }, 5 * 60 * 1000);
});

export { db, server };
