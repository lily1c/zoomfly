// ZoomFly Control — app.js — Full Feature Build

// ── CONFIG ────────────────────────────────────────────────────────
const CRUISE_MPH        = 18;
const BATT_MAH          = 5200;
const CRUISE_AMPS       = 25;
const BATT_MIN_PCT      = 20;
const MAX_LETTERS       = 20;
const LETTER_GRAMS      = 28;
const MAX_PAYLOAD_GRAMS = 500;
const DRONE_AUW_KG      = 4.7;
const USABLE_ENDURANCE  = 9;
const MAX_ALT_FT        = 120;
const MIN_SATS_FLY      = 6;
const MAX_WIND_MPH      = 15;

// ── STATE ─────────────────────────────────────────────────────────
let map, directionsService, directionsRenderer;
let droneMarker = null, homeMarker = null;
let aerialPolyline = null, roadPolyline = null;
let routePolylinePath = [];
let flightTimer = null, flightPct = 0, totalFlightMin = 0, routeMiles = 0;
let flightStartTime = null;
let camExpanded = false, camConnected = false, fcConnected = false;
let ticketQty = 1, activeTicketId = null, sbClient = null, deliveries = [];
let preflightReady = false, lastTelemetry = {};
let enduranceTimer = null, enduranceSecs = USABLE_ENDURANCE * 60;
let techMode = false, queueFilter = 'all';
let originLatLng = null, destLatLng = null;
let weatherOk = true, currentWindMph = null;
let _telRx = false;

const socket = io();

// ── THEME ─────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('zf-theme');
  const dark  = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme:dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  updateThemeIcon(dark);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('zf-theme', next);
  updateThemeIcon(next === 'dark');
  if (map) map.setOptions({ styles: next === 'dark' ? darkMapStyles() : lightMapStyles() });
}
function updateThemeIcon(dark) {
  const icon = document.getElementById('theme-icon');
  if (!icon) return;
  icon.innerHTML = dark
    ? '<path d="M12 3a6 6 0 0 0 0 10 6 6 0 0 1 0-10z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>'
    : '<circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M11.4 3.2l-1.4 1.4M3.2 11.4l1.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
}
initTheme();

// ── MAP STYLES ────────────────────────────────────────────────────
function lightMapStyles() {
  return [
    {featureType:'poi',stylers:[{visibility:'off'}]},
    {featureType:'transit',stylers:[{visibility:'off'}]},
    {featureType:'road',elementType:'labels.icon',stylers:[{visibility:'off'}]},
    {elementType:'geometry',stylers:[{color:'#f0ede8'}]},
    {elementType:'labels.text.fill',stylers:[{color:'#6b6a65'}]},
    {featureType:'road',elementType:'geometry',stylers:[{color:'#d5d0c0'}]},
    {featureType:'road.highway',elementType:'geometry',stylers:[{color:'#c8c2b0'}]},
    {featureType:'water',elementType:'geometry',stylers:[{color:'#c9d4dc'}]},
    {featureType:'landscape',elementType:'geometry',stylers:[{color:'#e8e4d8'}]},
  ];
}
function darkMapStyles() {
  return [
    {elementType:'geometry',stylers:[{color:'#0c1e35'}]},
    {elementType:'labels.text.fill',stylers:[{color:'#7a99bb'}]},
    {elementType:'labels.text.stroke',stylers:[{color:'#071425'}]},
    {featureType:'road',elementType:'geometry',stylers:[{color:'#1a3a6e'}]},
    {featureType:'road.highway',elementType:'geometry',stylers:[{color:'#1e4080'}]},
    {featureType:'water',elementType:'geometry',stylers:[{color:'#071425'}]},
    {featureType:'poi',stylers:[{visibility:'off'}]},
    {featureType:'transit',stylers:[{visibility:'off'}]},
  ];
}

// ── GOOGLE MAPS ───────────────────────────────────────────────────
window.initMap = function() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  map = new google.maps.Map(document.getElementById('gmap'), {
    center:{lat:40.3955,lng:-82.4833}, zoom:14,
    styles: dark ? darkMapStyles() : lightMapStyles(),
    disableDefaultUI:true, zoomControl:true,
    zoomControlOptions:{position:google.maps.ControlPosition.RIGHT_BOTTOM},
    gestureHandling:'greedy',
  });
  directionsService  = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({
    suppressMarkers:true, polylineOptions:{strokeOpacity:0, strokeWeight:0}
  });
  directionsRenderer.setMap(map);
  droneMarker = new google.maps.Marker({
    position:{lat:40.3932,lng:-82.4802}, map, visible:false,
    icon:{path:google.maps.SymbolPath.CIRCLE, scale:9,
          fillColor:'#1D9E75', fillOpacity:1,
          strokeColor:'rgba(29,158,117,0.4)', strokeWeight:8},
    zIndex:20, title:'ZoomFly Drone',
  });
  ['input-origin','input-dest'].forEach(inputId => {
    const input = document.getElementById(inputId);
    const qpId  = inputId === 'input-origin' ? 'qp-origin' : 'qp-dest';
    const ac    = new google.maps.places.Autocomplete(input,{componentRestrictions:{country:'us'}});
    ac.addListener('place_changed', () => { if (ac.getPlace()?.geometry) calculateRoute(); });
    input.addEventListener('focus',  () => { input.value=''; document.getElementById(qpId).style.display='block'; });
    input.addEventListener('blur',   () => setTimeout(()=>{ document.getElementById(qpId).style.display='none'; },200));
    input.addEventListener('input',  () => { document.getElementById(qpId).style.display = input.value?'none':'block'; });
  });
};

function setAddr(field, addr) {
  const inputId = field==='origin'?'input-origin':'input-dest';
  const qpId    = field==='origin'?'qp-origin':'qp-dest';
  document.getElementById(inputId).value = addr;
  document.getElementById(qpId).style.display = 'none';
  calculateRoute();
}

// ── ROUTE CALCULATION ─────────────────────────────────────────────
function calculateRoute() {
  const origin = document.getElementById('input-origin').value.trim();
  const dest   = document.getElementById('input-dest').value.trim();
  if (!origin || !dest || !directionsService) return;

  directionsService.route({origin, destination:dest, travelMode:google.maps.TravelMode.DRIVING},
    (result, status) => {
    if (status !== 'OK') { console.warn('Directions:', status); return; }

    const leg = result.routes[0].legs[0];
    originLatLng = leg.start_location;
    destLatLng   = leg.end_location;

    // Road route — gray subtle
    directionsRenderer.setDirections(result);
    if (roadPolyline) roadPolyline.setMap(null);
    roadPolyline = new google.maps.Polyline({
      path: google.maps.geometry.encoding.decodePath(result.routes[0].overview_polyline),
      geodesic:true, strokeColor:'#888888', strokeOpacity:0.3, strokeWeight:2, map, zIndex:3,
    });

    // Aerial direct line — green dashed
    drawAerialLine();

    // Origin / destination markers
    if (window._oMk) window._oMk.setMap(null);
    if (window._dMk) window._dMk.setMap(null);
    const dark = document.documentElement.getAttribute('data-theme')==='dark';
    window._oMk = new google.maps.Marker({
      position:leg.start_location, map, zIndex:10, title:'Origin',
      icon:{path:google.maps.SymbolPath.CIRCLE, scale:8,
            fillColor:dark?'#e2eaf4':'#1a1a18', fillOpacity:1,
            strokeColor:dark?'#071425':'#fff', strokeWeight:2.5},
    });
    window._dMk = new google.maps.Marker({
      position:leg.end_location, map, zIndex:10, title:'Destination',
      icon:{path:google.maps.SymbolPath.CIRCLE, scale:8,
            fillColor:'#1D9E75', fillOpacity:1, strokeColor:'#fff', strokeWeight:2.5},
    });

    // Calculations
    const aerialMi  = haversine(leg.start_location.lat(),leg.start_location.lng(),leg.end_location.lat(),leg.end_location.lng());
    const flightMin = aerialMi / CRUISE_MPH * 60;
    const mAhUsed   = CRUISE_AMPS * (flightMin/60) * 1000;
    const usableMah = BATT_MAH * ((100-BATT_MIN_PCT)/100);
    const battPct   = Math.min(Math.round((mAhUsed/usableMah)*100),99);
    routeMiles = aerialMi; totalFlightMin = flightMin;

    set('route-pill', leg.start_address.split(',')[0]+' → '+leg.end_address.split(',')[0]);
    set('eta-pill', Math.round(flightMin)+' min aerial flight');
    document.getElementById('estimate-placeholder').style.display = 'none';
    document.getElementById('estimate-data').style.display = '';
    set('est-time', Math.round(flightMin)+' min');
    const edEl = document.getElementById('est-dist');
    if (edEl) edEl.innerHTML = aerialMi.toFixed(2)+' <small>mi aerial</small>';
    set('bd-aerial', aerialMi.toFixed(2)+' mi');
    set('bd-road',   leg.distance?.text||'—'+' road');
    set('bd-ftime',  Math.round(flightMin)+' min');
    set('bd-batt',   '~'+battPct+'% ('+Math.round(mAhUsed)+' mAh)');
    set('bd-endurance', USABLE_ENDURANCE+' min usable ('+BATT_MIN_PCT+'% reserve)');

    droneMarker.setPosition(leg.start_location);
    droneMarker.setVisible(true);
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(leg.start_location); bounds.extend(leg.end_location);
    map.fitBounds(bounds,{top:50,bottom:50,left:50,right:50});
    updateStartButtonState();
  });
}

function drawAerialLine() {
  if (!originLatLng || !destLatLng) return;
  if (aerialPolyline) aerialPolyline.setMap(null);
  aerialPolyline = new google.maps.Polyline({
    path:[originLatLng, destLatLng], geodesic:true,
    strokeColor:'#1D9E75', strokeOpacity:0, strokeWeight:0,
    icons:[{icon:{path:'M 0,-1 0,1', strokeOpacity:1, strokeColor:'#1D9E75', scale:3}, offset:'0', repeat:'16px'}],
    map, zIndex:6,
  });
}

function haversine(lat1,lon1,lat2,lon2) {
  const R=3958.8, dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function set(id,v) { const el=document.getElementById(id); if(el) el.textContent=v; }

// ── QUANTITY + PAYLOAD WARNING ────────────────────────────────────
function changeQty(delta) {
  ticketQty = Math.max(1, Math.min(MAX_LETTERS, ticketQty+delta));
  set('qty-display', ticketQty);
  updatePayloadWarning();
}
function updatePayloadWarning() {
  const grams = ticketQty * LETTER_GRAMS;
  const el    = document.getElementById('payload-weight');
  const warn  = document.getElementById('payload-warn');
  if (el)   el.textContent = grams+'g est.';
  if (warn) warn.style.display = grams > MAX_PAYLOAD_GRAMS ? 'flex' : 'none';
}

// ── TECH MODE TOGGLE ──────────────────────────────────────────────
function toggleTechMode() {
  techMode = !techMode;
  document.body.classList.toggle('tech-mode', techMode);
  const btn = document.getElementById('tech-toggle');
  if (btn) btn.textContent = techMode ? '⚙ Operator Mode' : '⚙ Tech Mode';
  document.querySelectorAll('.tech-only').forEach(el => { el.style.display = techMode ? '' : 'none'; });
}

// ── START BUTTON GATE ─────────────────────────────────────────────
function updateStartButtonState() {
  const routeReady  = routeMiles > 0;
  const canDispatch = preflightReady && routeReady && weatherOk;
  document.querySelectorAll('.qi-start-btn').forEach(btn => {
    btn.disabled = !canDispatch;
    btn.title = !preflightReady ? 'Preflight not passing'
              : !routeReady    ? 'No route calculated'
              : !weatherOk     ? 'Wind too high'
              : '';
  });
}

// ── ARM CONFIRMATION ──────────────────────────────────────────────
function showArmConfirm() { document.getElementById('arm-confirm-overlay').style.display='flex'; }
function hideArmConfirm() { document.getElementById('arm-confirm-overlay').style.display='none'; }
async function confirmArm() {
  hideArmConfirm();
  log('Arming…','warn');
  const d = await apiPost('/api/arm');
  log(d.msg, d.ok?'ok':'err');
  if (d.ok) startEnduranceCountdown();
}

// ── ENDURANCE COUNTDOWN ───────────────────────────────────────────
function startEnduranceCountdown() {
  enduranceSecs = USABLE_ENDURANCE * 60;
  if (enduranceTimer) clearInterval(enduranceTimer);
  const wrap = document.getElementById('endurance-wrap');
  if (wrap) wrap.style.display = 'block';

  enduranceTimer = setInterval(() => {
    // If real battery data available use it
    if (lastTelemetry.battery_pct > 0) {
      const rem = Math.max(0, lastTelemetry.battery_pct - BATT_MIN_PCT);
      enduranceSecs = Math.round((rem/(100-BATT_MIN_PCT))*USABLE_ENDURANCE*60);
    } else {
      enduranceSecs = Math.max(0, enduranceSecs-1);
    }
    const mins = Math.floor(enduranceSecs/60);
    const secs = enduranceSecs % 60;
    const pct  = (enduranceSecs/(USABLE_ENDURANCE*60))*100;
    set('endurance-timer', mins+':'+String(secs).padStart(2,'0'));
    const bar = document.getElementById('endurance-bar');
    if (bar) { bar.style.width=pct+'%'; bar.className='endurance-fill'+(pct<22?' crit':pct<44?' warn':''); }
    if (enduranceSecs===120) showLowBattWarning(false);
    if (enduranceSecs===0)  { clearInterval(enduranceTimer); showLowBattWarning(true); }
  }, 1000);
}
function stopEnduranceCountdown() {
  if (enduranceTimer) { clearInterval(enduranceTimer); enduranceTimer=null; }
  const wrap = document.getElementById('endurance-wrap');
  if (wrap) wrap.style.display='none';
  hideLowBattWarning();
}

// ── LOW BATTERY OVERLAY ───────────────────────────────────────────
function showLowBattWarning(critical=false) {
  const overlay = document.getElementById('low-batt-overlay');
  const msg     = document.getElementById('low-batt-msg');
  if (!overlay) return;
  if (msg) msg.textContent = critical
    ? 'ENDURANCE ELAPSED — LAND IMMEDIATELY'
    : '⚠ Battery critical — 2 minutes remaining. Initiate RTL now.';
  overlay.className = 'low-batt-overlay'+(critical?' critical':'');
  overlay.style.display = 'flex';
  if (!critical) setTimeout(hideLowBattWarning, 8000);
}
function hideLowBattWarning() {
  const o = document.getElementById('low-batt-overlay');
  if (o) o.style.display='none';
}

// ── RTL EMERGENCY ─────────────────────────────────────────────────
async function triggerRTL() {
  log('⚠ RTL triggered','warn');
  const d = await apiPost('/api/mode',{mode:'RTL'});
  log(d.msg, d.ok?'ok':'err');
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
}

// ── SUPABASE ──────────────────────────────────────────────────────
const SB_URL  = 'YOUR_SUPABASE_URL';
const SB_ANON = 'YOUR_SUPABASE_ANON_KEY';

function initDB() {
  if (typeof window.supabase !== 'undefined' && SB_URL !== 'YOUR_SUPABASE_URL') {
    sbClient = window.supabase.createClient(SB_URL, SB_ANON);
    sbClient.channel('deliveries')
      .on('postgres_changes',{event:'*',schema:'public',table:'deliveries'},()=>loadQueue())
      .subscribe();
  }
  loadQueue();
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) loadQueue(); });
}

function generateTicketId() { return 'ZF-'+String(deliveries.length+1).padStart(3,'0'); }

async function createTicket() {
  const mailNum = document.getElementById('tf-mail').value.trim();
  const first   = document.getElementById('tf-first').value.trim();
  const last    = document.getElementById('tf-last').value.trim();
  const by      = document.getElementById('tf-by').value.trim();
  const type    = document.getElementById('tf-type').value;
  const origin  = document.getElementById('input-origin').value.trim();
  const dest    = document.getElementById('input-dest').value.trim();

  if (!mailNum||!first||!last||!by||!origin||!dest) {
    showToast('Please fill in all fields including addresses.','error'); return;
  }
  const grams = ticketQty * LETTER_GRAMS;
  if (grams > MAX_PAYLOAD_GRAMS) {
    showToast(`Payload ~${grams}g exceeds ${MAX_PAYLOAD_GRAMS}g limit. Reduce quantity.`,'error'); return;
  }

  const ticket = {
    ticket_id:generateTicketId(), mail_number:mailNum, package_type:type,
    quantity:ticketQty, recipient_first:first, recipient_last:last,
    delivered_by:by, origin, destination:dest, status:'pending',
    created_at:new Date().toISOString(), started_at:null, completed_at:null,
  };

  if (sbClient) {
    const {error} = await sbClient.from('deliveries').insert(ticket);
    if (error) { showToast('DB error: '+error.message,'error'); return; }
  } else { ticket.id=Date.now(); deliveries.unshift(ticket); }

  ['tf-mail','tf-first','tf-last','tf-by'].forEach(id=>document.getElementById(id).value='');
  ticketQty=1; set('qty-display','1'); updatePayloadWarning();
  loadQueue(); showToast('Ticket '+ticket.ticket_id+' created','ok');
}

async function loadQueue() {
  let rows=[];
  if (sbClient) {
    let q = sbClient.from('deliveries').select('*').order('created_at',{ascending:false}).limit(20);
    if (queueFilter!=='all') q=q.eq('status',queueFilter);
    const {data,error}=await q;
    if (!error&&data) rows=data;
  } else {
    rows=deliveries.slice(0,20);
    if (queueFilter!=='all') rows=rows.filter(r=>r.status===queueFilter);
  }

  const inProgress = rows.find(r=>r.status==='in_progress');
  activeTicketId   = inProgress?.id||null;
  const listEl = document.getElementById('queue-list');
  const countEl = document.getElementById('queue-count');
  if (countEl) countEl.textContent = rows.length?`(${rows.length})`:'';

  if (!rows.length) {
    listEl.innerHTML='<div class="queue-empty">No deliveries — create one above</div>';
    updateStartButtonState(); return;
  }

  const labels={pending:'Pending',in_progress:'In Progress',delivered:'Delivered',failed:'Failed'};
  listEl.innerHTML='';
  rows.forEach(r=>{
    const div=document.createElement('div');
    div.className='queue-item '+r.status;
    const created=new Date(r.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const canStart = r.status==='pending' && !inProgress;
    const destShort=(r.destination||'').split(',').slice(0,2).join(',');
    const weightG=(r.quantity||1)*LETTER_GRAMS;
    let elapsed='';
    if (r.status==='delivered'&&r.started_at&&r.completed_at) {
      const s=Math.round((new Date(r.completed_at)-new Date(r.started_at))/1000);
      elapsed=`<div class="qi-elapsed">Delivered in ${Math.floor(s/60)}m ${s%60}s</div>`;
    }
    div.innerHTML=`
      <div>
        <div class="qi-ticket">${r.ticket_id}</div>
        <div class="qi-recipient">${r.recipient_first} ${r.recipient_last}</div>
        <div class="qi-meta">${r.quantity}× letter · ~${weightG}g · #${r.mail_number} · by ${r.delivered_by}</div>
        <div class="qi-meta" style="margin-top:2px;color:var(--text3);font-size:10px">${destShort}</div>
        ${elapsed}
      </div>
      <div class="qi-right">
        <span class="status-badge ${r.status}">${labels[r.status]||r.status}</span>
        <span class="qi-date">${created}</span>
        ${canStart?`<button class="qi-start-btn" data-id="${r.id}" data-origin="${encodeURIComponent(r.origin)}" data-dest="${encodeURIComponent(r.destination)}" data-name="${encodeURIComponent(r.recipient_first+' '+r.recipient_last)}">Start</button>`:''}
        ${r.status==='in_progress'?'<span class="qi-active-badge">● Active</span>':''}
      </div>`;
    listEl.appendChild(div);
  });

  listEl.querySelectorAll('.qi-start-btn').forEach(btn=>{
    btn.addEventListener('click',()=>startDelivery(
      btn.dataset.id,
      decodeURIComponent(btn.dataset.origin),
      decodeURIComponent(btn.dataset.dest),
      decodeURIComponent(btn.dataset.name)
    ));
  });
  updateStartButtonState();
}

function setQueueFilter(filter) {
  queueFilter=filter;
  document.querySelectorAll('.filter-tab').forEach(t=>t.classList.toggle('active',t.dataset.filter===filter));
  loadQueue();
}

async function startDelivery(id,origin,destination,recipient) {
  if (!preflightReady) { showToast('Preflight not passing — check Preflight panel','error'); return; }
  if (!weatherOk)      { showToast('Wind too high — delivery blocked','error'); return; }

  document.getElementById('input-origin').value=origin;
  document.getElementById('input-dest').value=destination;
  calculateRoute();

  if (sbClient) {
    await sbClient.from('deliveries').update({status:'in_progress',started_at:new Date().toISOString()}).eq('id',id);
  } else {
    const d=deliveries.find(d=>String(d.id)===String(id));
    if(d){d.status='in_progress';d.started_at=new Date().toISOString();}
  }
  activeTicketId=id; flightStartTime=new Date();
  loadQueue();

  setTimeout(()=>{
    if(!routeMiles){showToast('Route not loaded — try again','error');return;}
    document.getElementById('btn-create-ticket').disabled=true;
    document.getElementById('progress-block').style.display='block';
    document.getElementById('inflight-stats').style.display='block';
    document.getElementById('delivered-card').style.display='none';
    startFlight(id,recipient);
  },1800);
}

function startFlight(ticketId, recipient) {
  flightPct=0;
  const steps=300, interval=Math.max((totalFlightMin*60*1000)/steps,80);

  flightTimer=setInterval(async()=>{
    // Real GPS progress if available
    if (lastTelemetry.lat&&lastTelemetry.lat!==0&&originLatLng&&destLatLng) {
      const total=haversine(originLatLng.lat(),originLatLng.lng(),destLatLng.lat(),destLatLng.lng());
      const rem=haversine(lastTelemetry.lat,lastTelemetry.lon,destLatLng.lat(),destLatLng.lng());
      flightPct=Math.min(Math.max(((total-rem)/total)*100,flightPct),99.9);
    } else {
      flightPct=Math.min(flightPct+(100/steps),100);
    }

    const pct=Math.round(flightPct);
    document.getElementById('pb-bar').style.width=pct+'%';
    set('pb-pct',pct+'%');

    // Animate along straight aerial line when no real GPS
    if ((!lastTelemetry.lat||lastTelemetry.lat===0)&&originLatLng&&destLatLng) {
      const t=flightPct/100;
      droneMarker.setPosition({
        lat:originLatLng.lat()+(destLatLng.lat()-originLatLng.lat())*t,
        lng:originLatLng.lng()+(destLatLng.lng()-originLatLng.lng())*t,
      });
    }

    const remMi=((100-flightPct)/100*routeMiles).toFixed(2);
    const remMin=Math.round((100-flightPct)/100*totalFlightMin);
    const remEl=document.getElementById('rem-dist');
    const etaEl=document.getElementById('rem-eta');
    if(remEl) remEl.innerHTML=remMi+' <small>mi</small>';
    if(etaEl) etaEl.innerHTML=remMin+' <small>min</small>';
    set('eta-pill',pct<100?'ETA '+remMin+' min':'Delivered ✓');

    if (flightPct>=100) {
      clearInterval(flightTimer);
      const completedAt=new Date().toISOString();
      if(sbClient){
        await sbClient.from('deliveries').update({status:'delivered',completed_at:completedAt}).eq('id',ticketId);
      } else {
        const d=deliveries.find(d=>String(d.id)===String(ticketId));
        if(d){d.status='delivered';d.completed_at=completedAt;}
      }
      const elapsed=new Date()-flightStartTime;
      const em=Math.floor(elapsed/60000), es=Math.floor((elapsed%60000)/1000);
      activeTicketId=null;
      document.getElementById('progress-block').style.display='none';
      document.getElementById('inflight-stats').style.display='none';
      document.getElementById('delivered-card').style.display='block';
      set('delivered-sub',recipient);
      set('delivered-time','Delivered in '+em+'m '+es+'s');
      document.getElementById('btn-create-ticket').disabled=false;
      loadQueue(); showToast('Delivery complete — '+recipient,'ok');
    }
  },interval);
}

// ── SOCKET / TELEMETRY ────────────────────────────────────────────
socket.on('connect',()=>{ if(!_telRx){ set('conn-label','server only'); document.getElementById('conn-dot').className='dot'; } });
socket.on('disconnect',()=>{ set('conn-label','offline'); document.getElementById('conn-dot').className='dot'; fcConnected=false; _telRx=false; });
socket.on('telemetry',d=>{
  lastTelemetry=d; _telRx=true;
  const hasFc=d.battery_voltage>0||d.satellites>0||d.altitude!==0;
  if(hasFc){
    fcConnected=true;
    document.getElementById('conn-dot').className=d.armed?'dot ready':'dot fc-connected';
    set('conn-label',d.armed?'armed':'FC connected');
  }
  updateSidebar(d); updateTelemetryPanel(d); updatePreflightVitals(d);
  if(d.lat&&d.lat!==0&&droneMarker?.getVisible()) droneMarker.setPosition({lat:d.lat,lng:d.lon});
  if(d.armed&&d.lat&&d.lat!==0&&!homeMarker) placeHomeMarker(d.lat,d.lon);
  if(!d.armed&&homeMarker){homeMarker.setMap(null);homeMarker=null;}
  if(d.battery_voltage>0&&d.battery_voltage<20.0) showLowBattWarning(d.battery_voltage<18.5);
});

function placeHomeMarker(lat,lon) {
  homeMarker=new google.maps.Marker({
    position:{lat,lng:lon}, map, zIndex:15, title:'RTL Home Point',
    icon:{path:'M 0,-2 2,2 -2,2 Z', fillColor:'#f59e0b', fillOpacity:1, strokeColor:'#fff', strokeWeight:1.5, scale:6},
  });
}

function updateSidebar(d) {
  set('sb-alt',  d.altitude?Math.round(d.altitude*3.281)+'ft':'—');
  set('sb-mode', d.mode||'—');
  set('sb-gps',  d.satellites!=null?d.satellites+' sats':'—');
  set('sb-port', d.port||'—');
  if(d.battery_pct>0)    set('sb-batt',d.battery_pct+'%');
  if(d.battery_voltage>0) set('sb-volt',d.battery_voltage.toFixed(1)+'V');
  const badge=document.getElementById('arm-badge');
  if(badge){badge.textContent=d.armed?'Armed':'Disarmed';badge.classList.toggle('armed',!!d.armed);}
}

function updateTelemetryPanel(d) {
  const altFt  = d.altitude?Math.round(d.altitude*3.281):null;
  const spdMph = d.groundspeed?Math.round(d.groundspeed*2.237):null;

  // Altitude with FAA limit coloring
  const altEl=document.getElementById('tl-alt');
  if(altEl){
    altEl.innerHTML=altFt!=null?altFt+' <small>ft</small>':'— <small>ft</small>';
    const card=altEl.closest('.stat-card');
    if(card){card.classList.toggle('warn-card',altFt!=null&&altFt>100); card.classList.toggle('err-card',altFt!=null&&altFt>120);}
  }

  // Speed vs target
  const spdEl=document.getElementById('tl-spd');
  if(spdEl){
    spdEl.innerHTML=spdMph!=null?spdMph+' <small>mph</small>':'— <small>mph</small>';
    const hint=document.getElementById('tl-spd-hint');
    if(hint&&spdMph!=null){
      const diff=spdMph-CRUISE_MPH;
      hint.textContent=diff>2?'↑ above target':diff<-2?'↓ below target':'≈ on target';
    }
  }

  // Battery voltage with threshold coloring
  const battEl=document.getElementById('tl-batt');
  if(battEl){
    const v=d.battery_voltage;
    battEl.innerHTML=v?v.toFixed(1)+' <small>V</small>':'— <small>V</small>';
    const card=battEl.closest('.stat-card');
    if(card){card.classList.toggle('warn-card',v>0&&v<21.0); card.classList.toggle('err-card',v>0&&v<19.8);}
  }

  // GPS with min satellite coloring
  const satEl=document.getElementById('tl-sat');
  if(satEl){
    satEl.textContent=d.satellites??'—';
    const card=satEl.closest('.stat-card');
    if(card){
      card.classList.toggle('warn-card',d.satellites!=null&&d.satellites<MIN_SATS_FLY&&d.satellites>=4);
      card.classList.toggle('err-card', d.satellites!=null&&d.satellites<4);
    }
  }

  const rollEl=document.getElementById('tl-roll');
  const pitchEl=document.getElementById('tl-pitch');
  if(rollEl)  rollEl.innerHTML=d.roll!=null?d.roll+' <small>°</small>':'— <small>°</small>';
  if(pitchEl) pitchEl.innerHTML=d.pitch!=null?d.pitch+' <small>°</small>':'— <small>°</small>';
}

// ── NAV ───────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.nav-item,.settings-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-'+btn.dataset.panel).classList.add('active');
    if(btn.dataset.panel==='delivery'&&map) google.maps.event.trigger(map,'resize');
  });
});
const settingsBtn=document.getElementById('settings-btn');
if(settingsBtn){
  settingsBtn.addEventListener('click',function(){
    document.querySelectorAll('.nav-item,.settings-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    this.classList.add('active');
    document.getElementById('panel-preflight').classList.add('active');
    loadPreflight();
  });
}

// ── CAMERA — auto connects to current server ──────────────────────
function connectCamera() {
  const url='/video?t='+Date.now();
  [document.getElementById('cam-img'),document.getElementById('cam-feed-tl')].forEach(img=>{
    if(!img) return;
    img.onload=()=>{
      img.style.display='block'; camConnected=true;
      const dot=document.getElementById('cam-status-dot');
      if(dot) dot.classList.add('live');
      const ph=document.getElementById('cam-placeholder');
      if(ph) ph.style.display='none';
      const off=document.getElementById('cam-offline-tl');
      if(off) off.style.display='none';
    };
    img.onerror=()=>{
      img.style.display='none'; camConnected=false;
      const dot=document.getElementById('cam-status-dot');
      if(dot) dot.classList.remove('live');
    };
    img.src=url;
  });
}
function toggleCamExpand(){
  camExpanded=!camExpanded;
  const o=document.getElementById('cam-overlay');
  if(o) o.classList.toggle('expanded',camExpanded);
}
setInterval(()=>{if(!camConnected) connectCamera();},10000);
connectCamera();

// ── WEATHER ───────────────────────────────────────────────────────
async function checkWeather() {
  try {
    const res=await fetch('https://api.open-meteo.com/v1/forecast?latitude=40.3955&longitude=-82.4833&current=windspeed_10m,weathercode&windspeed_unit=mph');
    const data=await res.json();
    const wind=data.current?.windspeed_10m;
    const code=data.current?.weathercode;
    currentWindMph=wind;
    const isRaining=code>=51;
    weatherOk=wind<=MAX_WIND_MPH&&!isRaining;
    const el=document.getElementById('weather-status');
    if(el){
      el.textContent=`Wind: ${wind?.toFixed(1)||'—'} mph · ${isRaining?'⚠ Precipitation':'Clear'}`;
      el.className='weather-status'+(weatherOk?'':' weather-warn');
    }
    updateStartButtonState();
  } catch(e){ console.warn('Weather check failed'); }
}
checkWeather();
setInterval(checkWeather,5*60*1000);

// ── PREFLIGHT ─────────────────────────────────────────────────────
const GPS_FIX_LABELS={0:'No fix',1:'No fix',2:'2D fix',3:'3D fix',4:'DGPS',5:'RTK float',6:'RTK fixed'};
const DEVICE_ICONS={fc:'✈',camera:'◉',lte:'◈',gps:'◎',rc:'⊛'};

async function loadPreflight() {
  const dl=document.getElementById('device-list');
  const ps=document.getElementById('pf-sub');
  const pc=document.getElementById('pf-checks');
  if(dl) dl.innerHTML='<div class="device-loading">Scanning…</div>';
  if(ps) ps.textContent='Scanning…';
  if(pc) pc.innerHTML='';
  try {
    const res=await fetch('/api/health');
    const data=await res.json();
    preflightReady=!!data.ready;
    renderPreflight(data);
    updateStartButtonState();
  } catch(e){ if(dl) dl.innerHTML='<div class="device-loading">Cannot reach server</div>'; }
}

function renderPreflight(data) {
  const ps=document.getElementById('pf-sub');
  if(ps){
    ps.textContent=data.ready?'✓ All systems go — ready to fly':'✗ Some checks failed — review below';
    ps.style.color=data.ready?'var(--green-text)':'#ef4444';
  }
  const pc=document.getElementById('pf-checks');
  if(pc){
    pc.innerHTML='';
    (data.checks||[]).forEach(c=>{
      const pill=document.createElement('div');
      pill.className='pf-check '+(c.ok?'ok':'fail');
      pill.innerHTML=(c.ok
        ?'<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        :'<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
      )+' '+c.label;
      pc.appendChild(pill);
    });
  }
  const dl=document.getElementById('device-list');
  if(dl){
    dl.innerHTML='';
    (data.devices||[]).forEach(dev=>{
      const st=dev.status;
      const card=document.createElement('div');
      card.className='device-card '+st;
      card.innerHTML=`
        <div class="device-icon ${st}">${DEVICE_ICONS[dev.id]||'◆'}</div>
        <div class="device-info">
          <div class="device-name">${dev.name}</div>
          <div class="device-detail">${dev.detail}</div>
          <div class="device-notes">${dev.notes}</div>
          <div class="test-result" id="dev-result-${dev.id}"></div>
        </div>
        <div class="device-actions">
          <span class="status-dot ${st}"></span>
          ${dev.testable?`<button class="test-btn" data-devid="${dev.id}">Test</button>`:''}
        </div>`;
      dl.appendChild(card);
    });
    dl.querySelectorAll('.test-btn').forEach(btn=>{
      btn.addEventListener('click',()=>testDevice(btn.dataset.devid));
    });
  }
  // Static drone specs
  set('pf-spec-auw', DRONE_AUW_KG+' kg');
  set('pf-spec-end', USABLE_ENDURANCE+' min ('+BATT_MIN_PCT+'% reserve)');
  set('pf-spec-cap', MAX_PAYLOAD_GRAMS+'g / '+MAX_LETTERS+' letters max');
  set('pf-spec-spd', CRUISE_MPH+' mph target cruise');
  updatePreflightVitals(data.telemetry||{});
}

async function testDevice(id) {
  const btn=document.querySelector(`[data-devid="${id}"]`);
  const res=document.getElementById('dev-result-'+id);
  if(!btn||!res) return;
  btn.textContent='Testing…'; btn.disabled=true; res.style.display='none';
  try {
    const r=await fetch('/api/device/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
    const data=await r.json();
    res.textContent=data.message; res.className='test-result '+(data.ok?'ok':'fail'); res.style.display='block';
  } catch(e){ res.textContent='Server error'; res.className='test-result fail'; res.style.display='block'; }
  btn.textContent='Test'; btn.disabled=false;
}

function updatePreflightVitals(d) {
  if(!document.getElementById('panel-preflight')?.classList.contains('active')) return;
  const bPct=d.battery_pct||0;
  set('pf-batt-pct',bPct?bPct+'%':'—');
  set('pf-batt-v',d.battery_voltage?d.battery_voltage.toFixed(1)+'V':'—');
  const fill=document.getElementById('pf-batt-fill');
  if(fill){fill.style.width=bPct+'%';fill.className='battery-fill'+(bPct<20?' low':bPct<40?' med':'');}
  set('pf-armed',d.armed?'Armed':'Disarmed');
  set('pf-mode',d.mode||'—');
  set('pf-gps-fix',GPS_FIX_LABELS[d.gps_fix]||'—');
  set('pf-sats',d.satellites!=null?d.satellites+' sats':'—');
  set('pf-roll',d.roll!=null?d.roll+'°':'—');
  set('pf-pitch',d.pitch!=null?d.pitch+'°':'—');
  set('pf-alt',d.altitude?Math.round(d.altitude*3.281)+' ft':'—');
}

async function pfArm()    { showArmConfirm(); }
async function pfDisarm() { const d=await apiPost('/api/disarm'); stopEnduranceCountdown(); loadPreflight(); }
setInterval(()=>{ if(document.getElementById('panel-preflight')?.classList.contains('active')) loadPreflight(); },30000);
setTimeout(loadPreflight,2000);

// ── CONTROLS ──────────────────────────────────────────────────────
function log(msg,type='') {
  const box=document.getElementById('log-box');
  if(!box) return;
  const line=document.createElement('div');
  if(type) line.className='log-'+type;
  const ts=new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  line.textContent=`[${ts}] ${msg}`;
  box.appendChild(line); box.scrollTop=box.scrollHeight;
}

async function apiPost(path,body={}) {
  try {
    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return await r.json();
  } catch(e){ return {ok:false,msg:e.message}; }
}

async function armDrone()    { showArmConfirm(); }
async function disarmDrone() {
  log('Disarming…','warn');
  const d=await apiPost('/api/disarm');
  log(d.msg,d.ok?'ok':'err');
  if(d.ok) stopEnduranceCountdown();
}

async function setMode(m) {
  log('Mode → '+m);
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.toggle('active',b.textContent.trim()===m));
  const d=await apiPost('/api/mode',{mode:m});
  log(d.msg,d.ok?'ok':'err');
}

async function testMotor(num) {
  const pct=parseInt(document.getElementById('mtr-pct').value)||10;
  log('Motor '+num+' @ '+pct+'%','warn');
  const d=await apiPost('/api/motortest',{motor:num,pct,duration:3});
  log(d.msg,d.ok?'ok':'err');
}
async function testHoverThrottle() {
  log('Hover test — all motors @ 55% for 3s','warn');
  const d=await apiPost('/api/motortest',{motor:0,pct:55,duration:3});
  log(d.msg,d.ok?'ok':'err');
}
async function testAllMotors() {
  for(let i=1;i<=4;i++){await testMotor(i);await new Promise(r=>setTimeout(r,4200));}
  log('All motors tested','ok');
}

const mtrSlider=document.getElementById('mtr-pct');
if(mtrSlider) mtrSlider.addEventListener('input',e=>{
  const el=document.getElementById('mtr-pct-val');
  if(el) el.textContent=e.target.value+'%';
});

// ── TOASTS ────────────────────────────────────────────────────────
function showToast(msg,type='ok') {
  const container=document.getElementById('toast-container');
  if(!container) return;
  const toast=document.createElement('div');
  toast.className='toast toast-'+type;
  toast.textContent=msg;
  container.appendChild(toast);
  setTimeout(()=>toast.classList.add('toast-show'),10);
  setTimeout(()=>{ toast.classList.remove('toast-show'); setTimeout(()=>toast.remove(),300); },3500);
}

// ── INIT ──────────────────────────────────────────────────────────
updatePayloadWarning();
initDB();
document.querySelectorAll('.tech-only').forEach(el=>{el.style.display='none';});
