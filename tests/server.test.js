import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const port = 31987;
const baseUrl = `http://127.0.0.1:${port}`;
let child;
let tempDirectory;

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Server did not become healthy in time");
}

before(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), "my-trucks-test-"));
  child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: join(tempDirectory, "test.db") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer();
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
  }
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
});

test("health reports SQLite WAL and WebSocket support", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", database: "sqlite-wal", websocket: true });
});

test("dashboard imports the workbook and calculates with 20 units per MT", async () => {
  const response = await fetch(`${baseUrl}/api/dashboard?month=2026-07`);
  const dashboard = await response.json();
  assert.equal(response.status, 200);
  assert.equal(dashboard.month, "2026-07");
  assert.equal(dashboard.unitsPerMt, 20);
  assert.ok(dashboard.vehicles.length >= 60);
  assert.ok(dashboard.entries.length >= 600);
  assert.ok(dashboard.payments.length >= 50);
});

test("a quantity update is persisted and stale edits are rejected", async () => {
  const dashboard = await (await fetch(`${baseUrl}/api/dashboard?month=2026-07`)).json();
  const vehicleId = dashboard.vehicles[0].id;
  const date = "2026-07-01";
  const original = dashboard.entries.find(entry => entry.vehicleId === vehicleId && entry.date === date);

  const update = await fetch(`${baseUrl}/api/entries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date, vehicleId, quantity: 25, version: original?.version, actor: "Test operator" })
  });
  assert.equal(update.status, 200);

  const refreshed = await (await fetch(`${baseUrl}/api/dashboard?month=2026-07`)).json();
  const saved = refreshed.entries.find(entry => entry.vehicleId === vehicleId && entry.date === date);
  assert.equal(saved.quantity, 25);

  const stale = await fetch(`${baseUrl}/api/entries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date, vehicleId, quantity: 30, version: saved.version - 1, actor: "Second operator" })
  });
  assert.equal(stale.status, 409);
});

test("a new driver and vehicle can be added", async () => {
  const created = await fetch(`${baseUrl}/api/vehicles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ driverName: "Test Driver", vehicleNumber: "TEST-001", ratePerQuantity: 15 })
  });
  assert.equal(created.status, 201);

  const dashboard = await (await fetch(`${baseUrl}/api/dashboard?month=2026-07`)).json();
  assert.ok(dashboard.vehicles.some(vehicle => vehicle.vehicleNumber === "TEST-001" && vehicle.driverName === "Test Driver"));
});

test("vehicle details and MT conversion can be changed", async () => {
  let dashboard = await (await fetch(`${baseUrl}/api/dashboard?month=2026-07`)).json();
  const vehicle = dashboard.vehicles.find(item => item.vehicleNumber === "TEST-001");
  const updated = await fetch(`${baseUrl}/api/vehicles/${vehicle.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ driverName: "Edited Driver", vehicleNumber: "EDIT-002", ratePerQuantity: 18.5 })
  });
  assert.equal(updated.status, 200);

  const settings = await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unitsPerMt: 25 })
  });
  assert.equal(settings.status, 200);

  dashboard = await (await fetch(`${baseUrl}/api/dashboard?month=2026-07`)).json();
  const saved = dashboard.vehicles.find(item => item.id === vehicle.id);
  assert.equal(saved.driverName, "Edited Driver");
  assert.equal(saved.vehicleNumber, "EDIT-002");
  assert.equal(saved.ratePerQuantity, 18.5);
  assert.equal(dashboard.unitsPerMt, 25);
});

test("payments can be edited and removed without losing audit history", async () => {
  let dashboard = await (await fetch(`${baseUrl}/api/dashboard?month=2026-07`)).json();
  const vehicle = dashboard.vehicles.find(item => item.vehicleNumber === "EDIT-002");
  const created = await fetch(`${baseUrl}/api/payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date: "2026-07-31", vehicleId: vehicle.id, amount: 1500, note: "Initial", actor: "Tester" })
  });
  assert.equal(created.status, 201);

  dashboard = await (await fetch(`${baseUrl}/api/dashboard?month=2026-07`)).json();
  const payment = dashboard.payments.find(item => item.vehicleId === vehicle.id);
  const edited = await fetch(`${baseUrl}/api/payments/${payment.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date: "2026-07-30", vehicleId: vehicle.id, amount: 1700, note: "Corrected", actor: "Tester" })
  });
  assert.equal(edited.status, 200);

  dashboard = await (await fetch(`${baseUrl}/api/dashboard?month=2026-07`)).json();
  assert.equal(dashboard.payments.find(item => item.id === payment.id).amount, 1700);

  const removed = await fetch(`${baseUrl}/api/payments/${payment.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "Tester" })
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).retainedHistory, true);

  dashboard = await (await fetch(`${baseUrl}/api/dashboard?month=2026-07`)).json();
  assert.ok(!dashboard.payments.some(item => item.id === payment.id));
});

test("deleting a driver hides all assigned vehicles while retaining history", async () => {
  let dashboard = await (await fetch(`${baseUrl}/api/dashboard?month=2026-07`)).json();
  const vehicle = dashboard.vehicles.find(item => item.vehicleNumber === "EDIT-002");
  const removed = await fetch(`${baseUrl}/api/drivers/${vehicle.driverId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "Tester" })
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).retainedHistory, true);

  dashboard = await (await fetch(`${baseUrl}/api/dashboard?month=2026-07`)).json();
  assert.ok(!dashboard.vehicles.some(item => item.driverId === vehicle.driverId));
});

test("the selected month downloads as a complete Excel workbook", async () => {
  const response = await fetch(`${baseUrl}/api/export?month=2026-07`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /spreadsheetml/);
  assert.match(response.headers.get("content-disposition"), /My-Trucks-2026-07\.xlsx/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Setup", "Monthly Register", "Settlement", "Payments"]);
  assert.equal(workbook.getWorksheet("Setup").getCell("B2").value, 25);
  assert.equal(workbook.getWorksheet("Monthly Register").getCell("A1").value, "My Trucks — July 2026");
  assert.ok(workbook.getWorksheet("Settlement").rowCount > 50);
  assert.ok(workbook.getWorksheet("Payments").rowCount > 50);
});
