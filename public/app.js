const state = {
  data: null,
  month: "2026-08",
  selectedDate: "2026-08-04",
  search: "",
  mobileTab: "register",
  clientId: localStorage.getItem("my-trucks-client-id") || crypto.randomUUID(),
  actor: localStorage.getItem("my-trucks-operator") || "Operator",
};
localStorage.setItem("my-trucks-client-id", state.clientId);
if (state.actor === "Operator") state.actor = `Operator ${state.clientId.slice(0,4).toUpperCase()}`;
localStorage.setItem("my-trucks-operator", state.actor);

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const shortDate = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });
const longDate = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
const icon = (name) => ({ plus: "+", left: "‹", right: "›", search: "⌕", close: "×" }[name] || "");
const dateObj = date => new Date(`${date}T00:00:00Z`);
const key = (date, vehicleId) => `${date}|${vehicleId}`;

function monthLabel(month) {
  const [year, value] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, value - 1, 1)));
}
 shiftMonth(month, offset) {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}`;
}
 daysInMonth(month) {
  const [year, value] = month.split("-").map(Number);
  return Array.from({length:new Date(Date.UTC(year,value,0)).getUTCDate()},(_,i)=>`${month}-${String(i+1).padStart(2,"0")}`);
}
 escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

async  load(quiet=false) {
  if (!quiet && !state.data) document.querySelector("#app").innerHTML = `<div class="loading-screen"><div class="loading-mark">MT</div><strong>Preparing My Trucks</strong><span>Loading vehicle register…</span></div>`;
  try {
    const res = await fetch(`/api/dashboard?month=${state.month}`, {cache:"no-store"});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unable to load dashboard");
    state.data = data;
    if (!state.selectedDate.startsWith(state.month)) state.selectedDate = `${state.month}-01`;
    render();
  } catch (error) { document.querySelector("#app").innerHTML = `<div class="loading-screen error"><strong>Dashboard unavailable</strong><span>${escapeHtml(error.message)}</span><button onclick="location.reload()">Try again</button></div>`; }
}

async  mutate(url, method, body={}) {
  const res = await fetch(url,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,actor:state.actor,clientId:state.clientId})});
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Could not save change");
  await load(true);
  return result;
}
const send = (url, body) => mutate(url, "POST", body);

 model() {
  const data = state.data;
  const dates = daysInMonth(state.month);
  const entries = new Map(data.entries.map(e=>[key(e.date,e.vehicleId),e]));
  const vehicles = data.vehicles.filter(v => !state.search || `${v.driverName} ${v.vehicleNumber}`.toLowerCase().includes(state.search.toLowerCase()));
  const stats = new Map();
  for (const vehicle of data.vehicles) {
    const override = entries.get(key(state.month, vehicle.id));
    const quantity = override ? Number(override.quantity) : data.entries.filter(e=>e.vehicleId===vehicle.id && e.date!==state.month).reduce((s,e)=>s+Number(e.quantity),0);
    const payable = quantity*Number(vehicle.ratePerQuantity);
    const paid = data.payments.filter(p=>p.vehicleId===vehicle.id).reduce((s,p)=>s+Number(p.amount),0);
    const balance = payable-paid;
    stats.set(vehicle.id,{quantity,payable,paid,balance,status:Math.abs(balance)<.01?"cleared":balance>0?"pending":"excess"});
  }
  const daily = new Map(dates.map(date=>{ const quantity=data.entries.filter(e=>e.date===date).reduce((s,e)=>s+Number(e.quantity),0); return [date,{quantity,mt:quantity/data.unitsPerMt}]; }));
  const all=[...stats.values()], quantity=all.reduce((s,v)=>s+v.quantity,0);
  return {data,dates,entries,vehicles,stats,daily,totals:{quantity,mt:quantity/data.unitsPerMt,pending:all.reduce((s,v)=>s+Math.max(v.balance,0),0),excess:all.reduce((s,v)=>s+Math.max(-v.balance,0),0),cleared:all.filter(v=>v.status==="cleared").length}};
}

function desktop({data,dates,entries,vehicles,stats,daily,totals}) {
  const heads=vehicles.map(v=>{const s=stats.get(v.id);return `<th class="driver-head ${s.status} clickable" data-manage="${v.id}"><div><strong>${escapeHtml(v.driverName)}</strong><span>${escapeHtml(v.vehicleNumber)}</span><small>${money.format(v.ratePerQuantity)} / qty</small><i></i></div></th>`}).join("");
  const rows=dates.map(date=>`<tr><th class="sticky date-cell">${longDate.format(dateObj(date))}</th><td class="sticky qty-cell">${daily.get(date).quantity?number.format(daily.get(date).quantity):"—"}</td><td class="sticky mt-cell">${daily.get(date).mt?number.format(daily.get(date).mt):"—"}</td>${vehicles.map(v=>{const e=entries.get(key(date,v.id));return `<td class="${e?.quantity?"has-value":""}"><button class="matrix-cell" data-cell="${date}|${v.id}">${e?.quantity?number.format(e.quantity):"<span>+</span>"}</button></td>`}).join("")}<td></td></tr>`).join("");
  const cards=vehicles.map(v=>{const s=stats.get(v.id);return `<article class="settlement-card ${s.status} clickable" data-manage="${v.id}"><div class="settlement-top"><div><strong>${escapeHtml(v.driverName)}</strong><span>${escapeHtml(v.vehicleNumber)}</span></div><span class="card-actions"><span class="status-pill">${s.status}</span></span></div><div class="balance-value"><span>${s.status==="excess"?"Excess":s.status==="cleared"?"Cleared":"Pending amt"}</span><strong>${money.format(Math.abs(s.balance))}</strong></div><div class="settlement-meta"><span><small>Qty</small>${number.format(s.quantity)}</span><span><small>Payable</small>${money.format(s.payable)}</span><span><small>Paid</small>${money.format(s.paid)}</span></div></article>`}).join("");
  return `<aside class="rail"><div class="brand-mark">MT</div><button class="rail-button active">▦</button><button class="rail-button" data-action="payment">₹</button><button class="rail-button" data-action="drivers">＋</button><button class="secondary-button export-button" data-action="export">↓ Excel</button>
<button class="secondary-button" data-action="settings">Settings</button><button class="rail-button" data-action="settings">⚙</button><div class="rail-spacer"></div><button class="rail-avatar" data-action="actor">${escapeHtml(state.actor[0])}</button></aside><section class="workspace"><header class="app-header"><div class="title-group"><span class="eyebrow">Fleet operations</span><h1>My Trucks</h1><p>Daily quantity, tonnage and payment control</p></div><div class="header-actions"><div class="live-users"><i></i><b>Live</b><div class="avatar-stack">${(data.activeUsers||[]).map(u=>`<span title="${escapeHtml(u.displayName)}">${escapeHtml(u.displayName[0])}</span>`).join("")}</div><small>${Math.max(data.activeUsers?.length||0,1)} active</small></div><button class="secondary-button" data-action="settings">Settings</button><button class="secondary-button" data-action="payment">Payments</button><button class="primary-button" data-action="drivers">Manage drivers</button></div></header><div class="desktop-dashboard"><section class="control-row"><div class="month-control"><button data-month="-1">${icon("left")}</button><div><span>Register month</span><strong>${monthLabel(state.month)}</strong></div><button data-month="1">${icon("right")}</button></div><div class="legend"><span><i class="pending"></i>Pending amt</span><span><i class="cleared"></i>Cleared</span><span><i class="excess"></i>Excess</span></div><label class="search-box"><span>${icon("search")}</span><input id="desktop-search" value="${escapeHtml(state.search)}" placeholder="Find driver or vehicle"></label></section><section class="kpi-grid"><article><span>Total quantity</span><strong>${number.format(totals.quantity)}</strong><small>${monthLabel(state.month)}</small></article><article><span>Total MT</span><strong>${number.format(totals.mt)}</strong><small>${data.unitsPerMt} qty = 1 MT</small></article><article class="pending"><span>Pending amt</span><strong>${money.format(totals.pending)}</strong><small>Action required</small></article><article class="cleared"><span>Cleared vehicles</span><strong>${totals.cleared}</strong><small>Fully settled</small></article><article class="excess"><span>Excess</span><strong>${money.format(totals.excess)}</strong><small>Review adjustment</small></article></section><section class="register-card"><div class="register-heading"><div><span class="eyebrow">Daily vehicle register</span><h2>Dates on the left. Drivers on top.</h2></div><span class="sync-note"><i></i>Click on any driver to view data</span></div><div class="matrix-wrap"><table class="register-matrix"><thead><tr><th class="sticky date-head">Date</th><th class="sticky qty-head">Total Qty</th><th class="sticky mt-head">MTs</th>${heads}<th class="add-column"><button data-action="vehicle">+<span>Add</span></button></th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th class="sticky date-cell">Month total</th><td class="sticky qty-cell">${number.format(totals.quantity)}</td><td class="sticky mt-cell">${number.format(totals.mt)}</td>${vehicles.map(v=>{const isOverride=entries.has(key(state.month,v.id));return `<td class="${isOverride?'has-value':''}"><button class="matrix-cell override-cell" data-total-cell="${v.id}">${isOverride?`<span>*</span> `:''}${number.format(stats.get(v.id).quantity)}</button></td>`}).join("")}<td></td></tr></tfoot></table></div></section><section class="settlement-section"><div class="section-heading"><div><span class="eyebrow">Monthly settlement</span><h2>Driver and vehicle balances</h2></div><button class="text-button" data-action="payment">Manage payments ›</button></div><div class="settlement-grid">${cards}</div></section></div></section>`;
}

function mobile({data,dates,entries,vehicles,stats,daily,totals}) {
  let content="";
  if(state.mobileTab==="register") content=`<div class="date-strip">${dates.map(d=>`<button class="${state.selectedDate===d?"active":""}" data-date="${d}"><span>${shortDate.format(dateObj(d)).split(" ")[0]}</span><strong>${dateObj(d).toLocaleDateString("en-IN",{weekday:"short",timeZone:"UTC"})}</strong></button>`).join("")}</div><section class="mobile-daily-summary"><div><span>Total quantity</span><strong>${number.format(daily.get(state.selectedDate)?.quantity||0)}</strong></div><div><span>Metric tonnes</span><strong>${number.format(daily.get(state.selectedDate)?.mt||0)}</strong></div></section><label class="mobile-search"><span>${icon("search")}</span><input id="mobile-search" value="${escapeHtml(state.search)}" placeholder="Find driver or vehicle"></label><section class="mobile-driver-list"><div class="mobile-section-title"><div><span>${longDate.format(dateObj(state.selectedDate))}</span><strong>${vehicles.length} vehicles</strong></div><button data-action="vehicle">+ Add</button></div>${vehicles.map(v=>{const e=entries.get(key(state.selectedDate,v.id)),s=stats.get(v.id);return `<article class="mobile-driver-card"><div class="mobile-driver-info"><i class="status-line ${s.status}"></i><div><strong>${escapeHtml(v.driverName)}</strong><span>${escapeHtml(v.vehicleNumber)} · ${money.format(v.ratePerQuantity)}/qty</span></div><span class="mini-status ${s.status}">${s.status}</span><button class="mobile-manage" data-manage="${v.id}" aria-label="Edit driver">•••</button></div><label><span>Quantity</span><input class="mobile-qty" data-date="${state.selectedDate}" data-vehicle="${v.id}" data-version="${e?.version??""}" type="number" min="0" step="0.01" value="${e?.quantity||""}" placeholder="0"></label></article>`}).join("")}</section>`;
  if(state.mobileTab==="settlements") content=`<section class="mobile-panel"><div class="mobile-panel-head"><span>Monthly settlement</span><h2>${monthLabel(state.month)}</h2></div><div class="mobile-status-summary"><span class="pending">${money.format(totals.pending)}<small>Pending</small></span><span class="cleared">${totals.cleared}<small>Cleared</small></span><span class="excess">${money.format(totals.excess)}<small>Excess</small></span></div>${vehicles.map(v=>{const s=stats.get(v.id);return `<article class="mobile-settlement ${s.status}"><div><strong>${escapeHtml(v.driverName)}</strong><span>${escapeHtml(v.vehicleNumber)}</span></div><div><small>${s.status}</small><strong>${money.format(Math.abs(s.balance))}</strong></div></article>`}).join("")}</section>`;
  if(state.mobileTab==="payments") content=`<section class="mobile-panel"><div class="mobile-panel-head"><span>Payment ledger</span><h2>${monthLabel(state.month)}</h2><button class="primary-button" data-action="payment">+ Record payment</button></div>${data.payments.map(p=>{const v=data.vehicles.find(x=>x.id===p.vehicleId);return `<article class="mobile-payment"><div><strong>${escapeHtml(v?.driverName||"Driver")}</strong><span>${escapeHtml(v?.vehicleNumber||"")} · ${shortDate.format(dateObj(p.date))}</span></div><strong>${money.format(p.amount)}</strong><button data-edit-payment="${p.id}">Edit</button></article>`}).join("")}</section>`;
  return `<div class="mobile-dashboard"><div class="mobile-top"><div><span class="eyebrow">Fleet operations</span><h1>My Trucks</h1></div><div class="mobile-top-actions">
  <button class="mobile-live" style="background:#f6fdf9; color:#0e8345; border:1px solid #b9ddca; cursor:pointer;" data-action="export">↓ Excel</button>
  <button class="mobile-settings" data-action="settings">⚙️</button>
</div><div class="mobile-top-actions"><button class="mobile-settings mobile-export" data-action="export" aria-label="Download Excel">↓</button><button class="mobile-settings" data-action="settings" aria-label="Settings">⚙</button><button class="mobile-live" data-action="actor"><i></i>${escapeHtml(state.actor)}</button></div></div><div class="mobile-month"><button data-month="-1">${icon("left")}</button><strong>${monthLabel(state.month)}</strong><button data-month="1">${icon("right")}</button></div>${content}<nav class="mobile-nav"><button data-tab="register" class="${state.mobileTab==="register"?"active":""}"><b>▦</b><span>Register</span></button><button data-tab="settlements" class="${state.mobileTab==="settlements"?"active":""}"><b>✓</b><span>Settlement</span></button><button data-tab="payments" class="${state.mobileTab==="payments"?"active":""}"><b>₹</b><span>Payments</span></button><button data-action="drivers"><b>＋</b><span>Drivers</span></button></nav></div>`;
}

function render() {
  const m=model();
  document.querySelector("#app").innerHTML = `<main class="truck-app">${desktop(m)}${mobile(m)}</main>`;
  bind();
}

function bind() {
  document.querySelectorAll("[data-month]").forEach(b=>b.onclick=()=>{state.month=shiftMonth(state.month,Number(b.dataset.month));load()});
  document.querySelectorAll("[data-date]").forEach(b=>b.onclick=()=>{state.selectedDate=b.dataset.date;render()});
  document.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{state.mobileTab=b.dataset.tab;render()});
  document.querySelectorAll("[data-action='vehicle']").forEach(b=>b.onclick=showVehicleModal);
  document.querySelectorAll("[data-action='drivers']").forEach(b=>b.onclick=showDriverManager);
  document.querySelectorAll("[data-action='payment']").forEach(b=>b.onclick=showPaymentModal);
  document.querySelectorAll("[data-action='settings']").forEach(b=>b.onclick=showSettingsModal);
  document.querySelectorAll("[data-action='export']").forEach(b=>b.onclick=()=>{window.location.href=`/api/export?month=${state.month}`;toast(`Preparing ${monthLabel(state.month)} Excel file`)});
  document.querySelectorAll("[data-manage]").forEach(b=>b.onclick=()=>showVehicleModal(b.getAttribute("data-manage")));
  document.querySelectorAll("[data-action='actor']").forEach(b=>b.onclick=changeActor);
  document.querySelectorAll("[data-edit-payment]").forEach(b=>b.onclick=()=>showPaymentModal(b.getAttribute("data-edit-payment")));
  document.querySelectorAll("[data-cell]").forEach(b=>b.onclick=()=>showEntryModal(...b.getAttribute("data-cell").split("|")));
  document.querySelectorAll("[data-total-cell]").forEach(b=>b.onclick=()=>showTotalModal(b.getAttribute("data-total-cell")));
  document.querySelectorAll(".mobile-qty").forEach(input=>input.onchange=async()=>{try{await send("/api/entries",{date:input.dataset.date,vehicleId:input.dataset.vehicle,quantity:Number(input.value||0),version:input.dataset.version===""?null:Number(input.dataset.version)});toast("Quantity updated for everyone")}catch(e){toast(e.message);load(true)}});
  [document.querySelector("#desktop-search"),document.querySelector("#mobile-search")].filter(Boolean).forEach(input=>input.oninput=()=>{state.search=input.value;window.clearTimeout(input._timer);input._timer=window.setTimeout(render,180)});
}

function modal(html) { document.querySelector("#modal-root").innerHTML=`<div class="modal-backdrop"><div class="modal">${html}</div></div>`; document.querySelector(".modal-backdrop").onclick=e=>{if(e.target===e.currentTarget)closeModal()}; document.querySelector("[data-close]").onclick=closeModal; }
function closeModal(){document.querySelector("#modal-root").innerHTML=""}
function showEntryModal(date,vehicleId){const m=model(),v=m.data.vehicles.find(x=>x.id===vehicleId),e=m.entries.get(key(date,vehicleId));modal(`<button class="modal-close" data-close>×</button><span class="eyebrow">Daily quantity</span><h2>${escapeHtml(v.driverName)}</h2><p>${escapeHtml(v.vehicleNumber)} · ${longDate.format(dateObj(date))}</p><form id="entry-form"><label class="field"><span>Quantity</span><input name="quantity" autofocus type="number" min="0" step="0.01" value="${e?.quantity||""}" placeholder="Enter quantity"></label><div class="computed-mt"><span>Calculated MT</span><strong id="mt-preview">${number.format((e?.quantity||0)/m.data.unitsPerMt)}</strong></div><div class="modal-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">Save quantity</button></div></form>`);document.querySelector("#entry-form input").oninput=e=>document.querySelector("#mt-preview").textContent=number.format(Number(e.target.value||0)/m.data.unitsPerMt);document.querySelectorAll("[data-close]").forEach(b=>b.onclick=closeModal);document.querySelector("#entry-form").onsubmit=async ev=>{ev.preventDefault();try{await send("/api/entries",{date,vehicleId,quantity:Number(ev.target.quantity.value||0),version:e?.version??null});closeModal();toast("Quantity updated for everyone")}catch(err){toast(err.message)}}}
function showDriverManager(){
  const groups=new Map();
  for(const vehicle of state.data.vehicles){const groupKey=vehicle.driverId||`unassigned-${vehicle.id}`;if(!groups.has(groupKey))groups.set(groupKey,{driverId:vehicle.driverId,name:vehicle.driverName,vehicles:[]});groups.get(groupKey).vehicles.push(vehicle)}
  const rows=[...groups.values()].map(group=>`<section class="manager-group"><header><div><strong>${escapeHtml(group.name)}</strong><span>${group.vehicles.length} vehicle${group.vehicles.length===1?"":"s"}</span></div>${group.driverId?`<button class="manager-delete-driver" data-manager-delete-driver="${group.driverId}" data-driver-name="${escapeHtml(group.name)}">Delete driver</button>`:""}</header>${group.vehicles.map(vehicle=>`<div class="manager-row"><div><strong>${escapeHtml(vehicle.vehicleNumber)}</strong><span>${money.format(vehicle.ratePerQuantity)} per quantity${vehicle.driverId?"":" · Unassigned column"}</span></div><button data-manager-edit="${vehicle.id}">Edit</button><button class="manager-delete" data-manager-delete-vehicle="${vehicle.id}">Delete</button></div>`).join("")}</section>`).join("");
  modal(`<button class="modal-close" data-close>×</button><div class="manager-title"><div><span class="eyebrow">Fleet management</span><h2>Manage drivers</h2><p>Edit or delete any imported or newly added dashboard column.</p></div><button class="primary-button" data-manager-add>+ Add driver</button></div><div class="manager-list">${rows||`<div class="empty-history">No active drivers.</div>`}</div>`);
  document.querySelectorAll("[data-close]").forEach(b=>b.onclick=closeModal);
  document.querySelector("[data-manager-add]").onclick=()=>showVehicleModal();
  document.querySelectorAll("[data-manager-edit]").forEach(button=>button.onclick=()=>showVehicleModal(button.getAttribute("data-manager-edit")));
  document.querySelectorAll("[data-manager-delete-vehicle]").forEach(button=>button.onclick=async()=>{const vehicle=state.data.vehicles.find(item=>item.id===button.getAttribute("data-manager-delete-vehicle"));if(!confirm(`Delete ${vehicle.driverName} / ${vehicle.vehicleNumber} from the dashboard? Historical data will be retained.`))return;try{await mutate(`/api/vehicles/${vehicle.id}`,"DELETE");showDriverManager();toast("Driver column deleted")}catch(error){toast(error.message)}});
  document.querySelectorAll("[data-manager-delete-driver]").forEach(button=>button.onclick=async()=>{if(!confirm(`Delete driver ${button.getAttribute("data-driver-name")} and every assigned vehicle? Historical data will be retained.`))return;try{await mutate(`/api/drivers/${button.getAttribute("data-manager-delete-driver")}`,"DELETE");showDriverManager();toast("Driver and assigned vehicles deleted")}catch(error){toast(error.message)}});
}
function showVehicleModal(vehicleId=null){
  const editId=typeof vehicleId==="string"?vehicleId:null;
  const m=model();
  const vehicle=editId?m.data.vehicles.find(v=>v.id===editId):null;
  if(editId&&!vehicle)return toast("Vehicle not found");
  let driverDataHtml = "";
  if(vehicle){
    const s = m.stats.get(vehicle.id);
    const vPayments = m.data.payments.filter(p=>p.vehicleId===vehicle.id);
    const history = vPayments.length ? vPayments.map(p=>`<div class="payment-row"><div><strong>${shortDate.format(dateObj(p.date))}</strong><span>${escapeHtml(p.note||"Payment")}</span></div><b>${money.format(p.amount)}</b><button type="button" data-edit-payment="${p.id}">Edit</button><button type="button" class="delete-link" data-delete-payment="${p.id}">Delete</button></div>`).join("") : `<div class="empty-history">No payments recorded this month.</div>`;
    driverDataHtml = `<div class="settlement-meta" style="margin-top:20px;padding-top:15px;display:flex;justify-content:space-between;border-top:1px solid var(--line);"><span><small>Month Qty</small>${number.format(s.quantity)}</span><span><small>Payable</small>${money.format(s.payable)}</span><span><small>Paid</small>${money.format(s.paid)}</span><span><small>Balance</small>${money.format(s.balance)}</span></div><div class="payment-history"><div class="history-heading"><strong>${monthLabel(state.month)} payments</strong><button type="button" class="text-button" data-record-payment="${vehicle.id}">+ Record payment</button></div>${history}</div>`;
  }
  modal(`<button class="modal-close" data-close>×</button><span class="eyebrow">Fleet setup</span><h2>${vehicle?"Driver Profile":"Add driver and vehicle"}</h2><p>${vehicle?"Change details or manage payments.":"The new driver appears as another column in the shared register."}</p><form id="vehicle-form"><label class="field"><span>Driver name</span><input name="driverName" required autofocus value="${escapeHtml(vehicle?.driverName||"")}" placeholder="e.g. Ramesh"></label><label class="field"><span>Vehicle number</span><input name="vehicleNumber" required value="${escapeHtml(vehicle?.vehicleNumber||"")}" placeholder="e.g. KA 01 AB 1234"></label><label class="field"><span>Rate per quantity</span><input name="rate" required type="number" min="0" step="0.01" value="${vehicle?.ratePerQuantity??14}"></label>${vehicle?`<div class="formula-note"><strong>Payable formula</strong><span>Monthly quantity × ₹${number.format(vehicle.ratePerQuantity)} per quantity</span></div>`:""}<div class="modal-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">${vehicle?"Save changes":"Add to register"}</button></div></form>${driverDataHtml}${vehicle?`<div class="danger-zone"><div><strong>Remove records</strong><span>Deleted items are hidden, while historical entries remain protected.</span></div><div><button class="danger-button" data-delete-vehicle>Delete vehicle</button>${vehicle.driverId?`<button class="danger-button strong" data-delete-driver>Delete driver & all vehicles</button>`:""}</div></div>`:""}`);
  document.querySelectorAll("[data-close]").forEach(b=>b.onclick=closeModal);
  document.querySelector("#vehicle-form").onsubmit=async e=>{e.preventDefault();try{const body={driverName:e.target.driverName.value,vehicleNumber:e.target.vehicleNumber.value,ratePerQuantity:Number(e.target.rate.value)};if(vehicle)await mutate(`/api/vehicles/${vehicle.id}`,"PATCH",body);else await send("/api/vehicles",body);closeModal();toast(vehicle?"Driver and vehicle updated":"Driver and vehicle added")}catch(err){toast(err.message)}};
  const deleteVehicle=document.querySelector("[data-delete-vehicle]");
  if(deleteVehicle)deleteVehicle.onclick=async()=>{if(!confirm(`Delete vehicle ${vehicle.vehicleNumber} from the dashboard? Its historical data will be retained.`))return;try{await mutate(`/api/vehicles/${vehicle.id}`,"DELETE");closeModal();toast("Vehicle removed")}catch(err){toast(err.message)}};
  const deleteDriver=document.querySelector("[data-delete-driver]");
  if(deleteDriver)deleteDriver.onclick=async()=>{if(!confirm(`Delete driver ${vehicle.driverName} and every vehicle assigned to this driver? Historical data will be retained.`))return;try{await mutate(`/api/drivers/${vehicle.driverId}`,"DELETE");closeModal();toast("Driver and assigned vehicles removed")}catch(err){toast(err.message)}};
  if(vehicle){
    document.querySelectorAll("[data-edit-payment]").forEach(b=>b.onclick=()=>showPaymentModal(b.getAttribute("data-edit-payment")));
    document.querySelectorAll("[data-delete-payment]").forEach(b=>b.onclick=async()=>{if(!confirm("Delete this payment record?"))return;try{await mutate(`/api/payments/${b.getAttribute("data-delete-payment")}`,"DELETE");showVehicleModal(vehicle.id);toast("Payment removed")}catch(err){toast(err.message)}});
    document.querySelector("[data-record-payment]").onclick=()=>showPaymentModal(null, vehicle.id);
  }
}
function showPaymentModal(paymentId=null, defaultVehicleId=null){
  const editId=typeof paymentId==="string"?paymentId:null;
  const payment=editId?state.data.payments.find(p=>p.id===editId):null;
  const vehicles=state.data.vehicles;
  const history=!payment?`<div class="payment-history"><div class="history-heading"><strong>${monthLabel(state.month)} payments</strong><span>${state.data.payments.length} records</span></div>${state.data.payments.length?state.data.payments.map(p=>{const v=vehicles.find(x=>x.id===p.vehicleId);return `<div class="payment-row"><div><strong>${escapeHtml(v?.driverName||"Driver")}</strong><span>${escapeHtml(v?.vehicleNumber||"")} · ${shortDate.format(dateObj(p.date))}${p.note?` · ${escapeHtml(p.note)}`:""}</span></div><b>${money.format(p.amount)}</b><button data-edit-payment="${p.id}">Edit</button><button class="delete-link" data-delete-payment="${p.id}">Delete</button></div>`}).join(""):`<div class="empty-history">No payments recorded this month.</div>`}</div>`:"";
  const selectedId = payment?.vehicleId || defaultVehicleId || vehicles[0]?.id;
  modal(`<button class="modal-close" data-close>×</button><span class="eyebrow">Settlement</span><h2>${payment?"Edit payment":"Record and manage payments"}</h2><p>Balances and colours update automatically across every device.</p><form id="payment-form"><label class="field"><span>Driver / vehicle</span><select name="vehicleId">${vehicles.map(v=>`<option value="${v.id}" ${selectedId===v.id?"selected":""}>${escapeHtml(v.driverName)} — ${escapeHtml(v.vehicleNumber)}</option>`).join("")}</select></label><div class="field-row"><label class="field"><span>Date</span><input name="date" type="date" required value="${payment?.date||state.selectedDate}"></label><label class="field"><span>Amount</span><input name="amount" type="number" step="0.01" required value="${payment?.amount??""}" placeholder="₹ 0"></label></div><label class="field"><span>Note</span><input name="note" value="${escapeHtml(payment?.note||"")}" placeholder="Reference or adjustment note"></label><small>Use a negative amount only for a reversal or adjustment.</small><div class="modal-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">${payment?"Save payment":"Record payment"}</button></div></form>${history}`);
  document.querySelectorAll("[data-close]").forEach(b=>b.onclick=closeModal);
  document.querySelector("#payment-form").onsubmit=async e=>{e.preventDefault();try{const body={vehicleId:e.target.vehicleId.value,date:e.target.date.value,amount:Number(e.target.amount.value),note:e.target.note.value};if(payment)await mutate(`/api/payments/${payment.id}`,"PATCH",body);else await send("/api/payments",body);closeModal();toast(payment?"Payment updated":"Payment recorded for everyone")}catch(err){toast(err.message)}};
  document.querySelectorAll("[data-edit-payment]").forEach(b=>b.onclick=()=>showPaymentModal(b.getAttribute("data-edit-payment")));
  document.querySelectorAll("[data-delete-payment]").forEach(b=>b.onclick=async()=>{if(!confirm("Delete this payment record? The audit history will be retained."))return;try{await mutate(`/api/payments/${b.getAttribute("data-delete-payment")}`,"DELETE");showPaymentModal();toast("Payment removed")}catch(err){toast(err.message)}});
}
function showTotalModal(vehicleId){
  const m=model(),v=m.data.vehicles.find(x=>x.id===vehicleId),e=m.entries.get(key(state.month,vehicleId));
  modal(`<button class="modal-close" data-close>×</button><span class="eyebrow">Monthly quantity</span><h2>${escapeHtml(v.driverName)}</h2><p>${escapeHtml(v.vehicleNumber)} · ${monthLabel(state.month)}</p><form id="total-form"><label class="field"><span>Manual Total Quantity</span><input name="quantity" autofocus type="number" min="0" step="0.01" value="${e?.quantity||""}" placeholder="Leave empty for auto-sum"></label><div class="computed-mt"><span>Calculated MT</span><strong id="mt-preview">${number.format((e?.quantity||0)/m.data.unitsPerMt)}</strong></div><div class="modal-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">Save total</button></div></form>`);
  document.querySelector("#total-form input").oninput=ev=>document.querySelector("#mt-preview").textContent=number.format(Number(ev.target.value||0)/m.data.unitsPerMt);
  document.querySelectorAll("[data-close]").forEach(b=>b.onclick=closeModal);
  document.querySelector("#total-form").onsubmit=async ev=>{
    ev.preventDefault();
    try{
      const val=ev.target.quantity.value;
      if(val===""){if(e)await mutate(`/api/entries/${e.id}`,"DELETE");}
      else{await send("/api/entries",{date:state.month,vehicleId,quantity:Number(val),version:e?.version??null});}
      closeModal();toast("Total updated for everyone");
    }catch(err){toast(err.message)}
  };
}
function showSettingsModal(){
  modal(`<button class="modal-close" data-close>×</button><span class="eyebrow">Calculation settings</span><h2>Quantity and MT conversion</h2><p>Change how the dashboard converts total quantity into metric tonnes.</p><form id="settings-form"><label class="field"><span>Quantity units equal to 1 MT</span><input name="unitsPerMt" required autofocus type="number" min="0.01" step="0.01" value="${state.data.unitsPerMt}"></label><div class="formula-note"><strong>Current calculations</strong><span>Total MT = Total Qty ÷ ${number.format(state.data.unitsPerMt)}</span><span>Vehicle payable = Monthly Qty × Vehicle Rate</span></div><div class="modal-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">Save settings</button></div></form>`);
  document.querySelectorAll("[data-close]").forEach(b=>b.onclick=closeModal);
  document.querySelector("#settings-form").onsubmit=async e=>{e.preventDefault();try{await mutate("/api/settings","PATCH",{unitsPerMt:Number(e.target.unitsPerMt.value)});closeModal();toast("MT conversion updated for everyone")}catch(err){toast(err.message)}};
}
function changeActor(){const name=prompt("Name shown to other dashboard users",state.actor);if(name?.trim()){state.actor=name.trim().slice(0,80);localStorage.setItem("my-trucks-operator",state.actor);heartbeat();render()}}
function toast(message){const el=document.querySelector("#toast");el.textContent=message;el.classList.add("show");clearTimeout(el._timer);el._timer=setTimeout(()=>el.classList.remove("show"),2600)}
async function heartbeat(){await fetch("/api/presence",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId:state.clientId,actor:state.actor})}).catch(()=>{})}
function connect(){const protocol=location.protocol==="https:"?"wss":"ws";const ws=new WebSocket(`${protocol}://${location.host}/live`);ws.onmessage=e=>{try{if(JSON.parse(e.data).type==="refresh")load(true)}catch{}};ws.onclose=()=>setTimeout(connect,2000)}
heartbeat();setInterval(heartbeat,15000);connect();load();
