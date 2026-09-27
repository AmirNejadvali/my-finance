(() => {
"use strict";

const cfg = window.APP_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
const $ = id => document.getElementById(id);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const MONTHS = ["Farvardin","Ordibehesht","Khordad","Tir","Mordad","Shahrivar","Mehr","Aban","Azar","Dey","Bahman","Esfand"];

let user = null;
let accounts = [];
let loans = [];
let payments = [];
let salaries = [];
let salaryMonths = [];
let selected = currentJalali();
let selectedYear = selected.jy;
let selectedMonth = selected.jm;
let dashboardYear = selected.jy;
let dashboardMonth = selected.jm;
let chartInstance = null;
let adminKey = "";

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function n(v) { return Number(v || 0); }
function money(v, currency="TOMAN") {
  const unit = currency === "TOMAN" ? "T" : currency;
  return new Intl.NumberFormat("en-US",{maximumFractionDigits:0}).format(Math.round(n(v))) + " " + unit;
}
function todayISO(){ return new Date().toISOString().slice(0,10); }
function currentJalali() {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian",{year:"numeric",month:"numeric",day:"numeric"}).formatToParts(new Date());
  const pick = t => Number((parts.find(p => p.type === t) || {}).value || 0);
  return {jy: pick("year"), jm: pick("month"), jd: pick("day")};
}
function addJMonth(jy, jm, offset) {
  const idx = jy * 12 + (jm - 1) + offset;
  return {jy: Math.floor(idx / 12), jm: ((idx % 12) + 12) % 12 + 1};
}
function monthSpan(sy,sm,ey,em) {
  return (ey*12+(em-1))-(sy*12+(sm-1))+1;
}
function monthKey(jy,jm){ return jy*100+jm; }
function monthText(jy,jm){ return MONTHS[jm-1] + " " + jy; }
function isPastMonth(jy,jm){ return monthKey(jy,jm) < monthKey(selected.jy,selected.jm); }
function isCurrentMonth(jy,jm){ return jy===selected.jy && jm===selected.jm; }
const PERSIAN_PARTS = new Intl.DateTimeFormat("en-US-u-ca-persian",{year:"numeric",month:"numeric",day:"numeric"});
function jalaliParts(date) {
  const parts=PERSIAN_PARTS.formatToParts(date);
  const pick=t=>Number((parts.find(p=>p.type===t)||{}).value||0);
  return {jy:pick("year"),jm:pick("month"),jd:pick("day")};
}
function gregorianDateForSolar(jy,jm,jd=1) {
  const gy=jm<=10?jy+621:jy+622;
  const gm=(jm+1)%12;
  for(let offset=-35;offset<=35;offset++){
    const d=new Date(gy,gm,15+offset,12,0,0,0);
    const p=jalaliParts(d);
    if(p.jy===jy&&p.jm===jm&&p.jd===jd)return d;
  }
  return null;
}
function solarMonthInfo(jy,jm) {
  const first=gregorianDateForSolar(jy,jm,1);
  if(!first)return {days:jm<=6?31:jm<=11?30:30,firstColumn:0};
  let days=0;
  for(let i=0;i<32;i++){
    const d=new Date(first);d.setDate(first.getDate()+i);
    const p=jalaliParts(d);
    if(p.jy!==jy||p.jm!==jm)break;
    days++;
  }
  return {days,firstColumn:(first.getDay()+1)%7};
}


async function signIn() {
  const email = $("email").value.trim();
  const password = $("password").value;
  $("authMsg").textContent = "Signing in...";
  const r = await sb.auth.signInWithPassword({email,password});
  if (r.error) { $("authMsg").textContent = r.error.message; return; }
  await enter(r.data.user);
}
async function createAccount() {
  const email = $("email").value.trim();
  const password = $("password").value;
  const key = $("accessKey").value;
  if (!email || !password || !key) {
    $("authMsg").textContent = "Email, password and access key are required.";
    return;
  }
  $("authMsg").textContent = "Creating account...";
  try {
    const res = await fetch(cfg.INVITE_SIGNUP_URL,{
      method:"POST",
      headers:{"Content-Type":"application/json","apikey":cfg.SUPABASE_PUBLISHABLE_KEY},
      body:JSON.stringify({email,password,key})
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Could not create account.");
    $("authMsg").textContent = out.message || "Account created. Sign in now.";
    $("accessKey").value = "";
  } catch(e) {
    $("authMsg").textContent = e.message || "Signup failed.";
  }
}
async function enter(u) {
  const access = await sb.from("app_users").select("user_id").eq("user_id",u.id).maybeSingle();
  if (access.error || !access.data) {
    await sb.auth.signOut();
    showAuth();
    $("authMsg").textContent = "This account is not approved.";
    return;
  }
  user = u;
  $("userEmail").textContent = u.email || "";
  $("authView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  await refreshAll();
}
function showAuth() {
  user = null;
  adminKey = "";
  $("appView").classList.add("hidden");
  $("authView").classList.remove("hidden");
}

async function refreshAll() {
  const rs = await Promise.all([
    sb.from("accounts").select("*").order("created_at"),
    sb.from("loans").select("*").order("created_at",{ascending:false}),
    sb.from("loan_payments").select("*").order("due_jyear").order("due_jmonth").order("installment_no"),
    sb.from("salary_definitions").select("*").order("created_at",{ascending:false}),
    sb.from("salary_months").select("*").order("due_jyear").order("due_jmonth")
  ]);
  const err = rs.find(x=>x.error);
  if (err) { toast(err.error.message); return; }
  accounts = rs[0].data || [];
  loans = rs[1].data || [];
  payments = rs[2].data || [];
  salaries = rs[3].data || [];
  salaryMonths = rs[4].data || [];
  renderAll();
}
function renderAll() {
  renderDashboard();
  renderPayments();
  renderLoans();
  renderSalaries();
  renderAccounts();
  renderChartControls();
  renderChart();
}

function paymentTotals(jy,jm) {
  const rows = payments.filter(p=>p.due_jyear===jy && p.due_jmonth===jm);
  const due = rows.reduce((s,p)=>s+n(p.amount),0);
  const paid = rows.filter(p=>p.is_paid).reduce((s,p)=>s+n(p.amount),0);
  return {rows,due,paid,remaining:Math.max(0,due-paid)};
}
function earningTotal(jy,jm) {
  return salaryMonths.filter(s=>s.due_jyear===jy && s.due_jmonth===jm).reduce((sum,s)=>sum+n(s.amount),0);
}

function dashboardHeatColor(due,remaining) {
  if (due <= 0) return "heat-none";
  if (remaining <= 0) return "heat-green";
  const paidRatio = (due-remaining)/due;
  if (paidRatio <= 0.25) return "heat-red";
  if (paidRatio <= 0.60) return "heat-orange";
  return "heat-yellow";
}
function renderDashboard() {
  const yearOptions=Array.from({length:11},(_,i)=>selected.jy-5+i);
  if(!yearOptions.includes(dashboardYear)) dashboardYear=selected.jy;
  if(dashboardMonth<1||dashboardMonth>12) dashboardMonth=selected.jm;

  $("dashboardYearCircles").innerHTML=yearOptions.map((year,i)=>{
    const current=year===selected.jy?" current-year":"";
    const active=year===dashboardYear?" selected-circle":"";
    return '<button class="nav-circle year-circle'+current+active+'" data-dashboard-year="'+year+'" title="'+year+'"><span>'+year+'</span></button>';
  }).join("");

  const yearPayments=payments.filter(p=>p.due_jyear===dashboardYear);
  const yearTotal=yearPayments.reduce((s,p)=>s+n(p.amount),0);
  const yearPaid=yearPayments.filter(p=>p.is_paid).reduce((s,p)=>s+n(p.amount),0);
  const yearEarn=salaryMonths.filter(s=>s.due_jyear===dashboardYear).reduce((sum,s)=>sum+n(s.amount),0);
  $("dashYearPayments").textContent=money(yearTotal);
  $("dashYearEarnings").textContent=money(yearEarn);
  $("dashYearPaid").textContent=money(yearPaid);

  $("heatYearLabel").textContent=String(dashboardYear);
  $("paymentHeatmap").innerHTML=MONTHS.map((name,i)=>{
    const m=i+1,t=paymentTotals(dashboardYear,m),cls=dashboardHeatColor(t.due,t.remaining);
    const selectedClass=m===dashboardMonth?" heat-selected":"";
    return '<button class="heat-month '+cls+selectedClass+'" data-heat-month="'+m+'">' +
      '<span class="heat-name">'+name+'</span>' +
      '<span class="heat-due">'+money(t.due)+'</span>' +
      '<span class="heat-rem">'+(t.due ? money(t.remaining)+" remaining" : "No payment")+'</span>' +
      '</button>';
  }).join("");

  const clickedRows=payments
    .filter(p=>p.due_jyear===dashboardYear&&p.due_jmonth===dashboardMonth)
    .sort((a,b)=>a.due_day-b.due_day||a.installment_no-b.installment_no);
  $("dashClickedMonthTitle").textContent=monthText(dashboardYear,dashboardMonth)+" payments";
  $("dashClickedMonthPayments").innerHTML=clickedRows.length?clickedRows.map(p=>{
    const l=loans.find(x=>x.id===p.loan_id);
    const badge=p.is_paid?'<span class="pill good">Paid</span>':'<span class="pill bad">Unpaid</span>';
    return '<div class="row compact-row"><div><div class="row-title">'+esc(l?l.name:"Loan")+'</div><div class="small muted">Day '+p.due_day+' · Installment '+p.installment_no+'</div></div><div>'+money(p.amount)+'</div><div>'+badge+'</div></div>';
  }).join(""):'<div class="empty">No loan payments in this month.</div>';
}

function renderPayments() {
  selectedYear=selected.jy;
  if(selectedMonth<1||selectedMonth>12) selectedMonth=selected.jm;
  $("monthCircles").innerHTML=MONTHS.map((name,i)=>{
    const m=i+1;
    const current=m===selected.jm?" current-month":"";
    const active=m===selectedMonth?" selected-circle":"";
    return '<button class="nav-circle month-circle'+current+active+'" data-payment-month="'+m+'" title="'+name+'"><span class="circle-number">'+m+'</span><span class="circle-label">'+name.slice(0,3)+'</span></button>';
  }).join("");
  renderSelectedMonth();
}
function renderSelectedMonth() {
  const t=paymentTotals(selectedYear,selectedMonth);
  t.rows.sort((a,b)=>a.due_day-b.due_day || a.installment_no-b.installment_no);
  $("selectedMonthTitle").textContent=monthText(selectedYear,selectedMonth);
  $("paymentCountLabel").textContent=t.rows.length+' payment'+(t.rows.length===1?"":"s");
  $("payDue").textContent=money(t.due);
  $("payPaid").textContent=money(t.paid);
  $("payRemaining").textContent=money(t.remaining);

  $("paymentsList").innerHTML=t.rows.length?t.rows.map(p=>{
    const loan=loans.find(l=>l.id===p.loan_id);
    const badge=p.is_paid?'<span class="pill good">Paid</span>':'<span class="pill bad">'+(isPastMonth(p.due_jyear,p.due_jmonth)?"Overdue":"Unpaid")+'</span>';
    return '<div class="row">' +
      '<div><div class="row-title">'+esc(loan?loan.name:"Loan")+'</div><div class="small muted">Installment '+p.installment_no+' · day '+p.due_day+'</div></div>' +
      '<div>'+money(p.amount)+'</div><div class="mobile-hide">'+badge+'</div>' +
      '<div class="optional small muted">'+(p.paid_at ? "Paid "+new Date(p.paid_at).toLocaleDateString("en-US-u-ca-persian") : "Not paid")+'</div>' +
      '<div><input class="pay-toggle" type="checkbox" data-id="'+p.id+'" '+(p.is_paid?"checked":"")+' title="Mark paid/unpaid"></div></div>';
  }).join(""):'<div class="empty">No loan payments in this Solar month.</div>';
  renderSolarCalendar(selectedYear,selectedMonth,t.rows);
}
function renderSolarCalendar(jy,jm,rows) {
  const info=solarMonthInfo(jy,jm);
  $("calendarMonthTitle").textContent=monthText(jy,jm);
  const byDay={};
  rows.forEach(p=>{
    const day=Math.min(Math.max(1,n(p.due_day)),info.days);
    (byDay[day]||(byDay[day]=[])).push(p);
  });
  const cells=[];
  for(let i=0;i<info.firstColumn;i++)cells.push('<div class="solar-day empty-day"></div>');
  for(let day=1;day<=info.days;day++){
    const events=(byDay[day]||[]).sort((a,b)=>a.installment_no-b.installment_no);
    const todayClass=(jy===selected.jy&&jm===selected.jm&&day===selected.jd)?" today":"";
    const chips=events.map(p=>{
      const l=loans.find(x=>x.id===p.loan_id);
      return '<div class="cal-event '+(p.is_paid?"paid":"unpaid")+'" title="'+esc((l?l.name:"Loan")+" · "+money(p.amount))+'"><span>'+esc(l?l.name:"Loan")+'</span><span>'+money(p.amount)+'</span></div>';
    }).join("");
    cells.push('<div class="solar-day'+todayClass+'"><div class="day-num">'+day+'</div>'+chips+'</div>');
  }
  $("solarCalendar").innerHTML=cells.join("");
}

async function togglePayment(id,checked) {
  const r=await sb.from("loan_payments").update({is_paid:checked,paid_at:checked?new Date().toISOString():null}).eq("id",id);
  if(r.error){toast(r.error.message);return;}
  await refreshAll();
}

function loanFinancials(l,lp) {
  const principal=n(l.total_amount);
  const finalPayable=n(l.final_payable_amount)||lp.reduce((s,p)=>s+n(p.amount),0);
  const interest=Math.max(0,n(l.interest_amount)||(finalPayable-principal));
  const rate=principal>0?interest/principal*100:0;
  return {principal,finalPayable,interest,rate};
}
function renderLoans() {
  $("loansGrid").innerHTML=loans.length?loans.map(l=>{
    const lp=payments.filter(p=>p.loan_id===l.id);
    const paid=lp.filter(p=>p.is_paid);
    const rem=lp.filter(p=>!p.is_paid).reduce((s,p)=>s+n(p.amount),0);
    const monthRows=lp.filter(p=>p.due_jyear===selected.jy&&p.due_jmonth===selected.jm);
    const monthTotal=monthRows.reduce((s,p)=>s+n(p.amount),0);
    const monthPaid=monthRows.filter(p=>p.is_paid).reduce((s,p)=>s+n(p.amount),0);
    const pct=lp.length?Math.round(paid.length*100/lp.length):0;
    const f=loanFinancials(l,lp);
    return '<div class="mini-card">' +
      '<h3>'+esc(l.name)+'</h3>' +
      '<div class="small muted">'+esc(l.lender||"Loan")+' · '+(l.repayment_mode==="manual"?"Manual schedule":"Equal installments")+'</div>' +
      '<div class="loan-figures">' +
        '<div><span class="small muted">Original</span><span>'+money(f.principal)+'</span></div>' +
        '<div><span class="small muted">Final payable</span><span>'+money(f.finalPayable)+'</span></div>' +
        '<div><span class="small muted">Interest</span><span>'+money(f.interest)+' ('+f.rate.toFixed(1)+'%)</span></div>' +
      '</div>' +
      '<div class="small muted">'+monthText(l.start_jyear,l.start_jmonth)+' → '+monthText(l.end_jyear,l.end_jmonth)+' · '+lp.length+' payments</div>' +
      '<div class="progress"><span style="width:'+pct+'%"></span></div>' +
      '<div class="small">'+paid.length+'/'+lp.length+' payments paid · Remaining '+money(rem)+'</div>' +
      '<div class="month-card-line"><span>This month</span><span>'+money(monthPaid)+' paid / '+money(monthTotal)+' total</span></div>' +
      '<div class="mini-actions"><button class="ghost loan-edit" data-id="'+l.id+'">Edit</button><button class="ghost loan-open-map" data-id="'+l.id+'">Payments</button><button class="ghost danger loan-delete" data-id="'+l.id+'">Delete</button></div>' +
      '</div>';
  }).join(""):'<div class="empty full">No loans defined yet.</div>';
}
function currentManualAmounts() {
  const map={};
  $$("#manualScheduleRows .manual-payment-input").forEach(input=>{map[input.dataset.key]=input.value;});
  return map;
}
function buildManualSchedule(preserve=true) {
  const sy=n($("loanStartYear").value), sm=n($("loanStartMonth").value), ey=n($("loanEndYear").value), em=n($("loanEndMonth").value);
  const rows=$("manualScheduleRows");
  if(!sy||!sm||!ey||!em){rows.innerHTML="";updateLoanSummary();return;}
  const count=monthSpan(sy,sm,ey,em);
  if(count<1||count>600){rows.innerHTML='<div class="small bad">End month must be after the start month.</div>';updateLoanSummary();return;}
  const old=preserve?currentManualAmounts():{};
  const fill=n($("manualFillAmount").value);
  rows.innerHTML=Array.from({length:count},(_,i)=>{
    const d=addJMonth(sy,sm,i), key=d.jy+"-"+d.jm, val=old[key] != null ? old[key] : (fill>0?String(Math.round(fill)):"");
    return '<div class="schedule-row"><span>'+monthText(d.jy,d.jm)+'</span><input class="manual-payment-input" data-key="'+key+'" data-jyear="'+d.jy+'" data-jmonth="'+d.jm+'" type="number" min="1" step="1" value="'+esc(val)+'" placeholder="Payment amount"></div>';
  }).join("");
  $("manualPaymentCount").textContent=String(count);
  updateLoanSummary();
}
function fillManualSchedule() {
  const value=Math.round(n($("manualFillAmount").value));
  if(value<=0){toast("Enter a monthly amount first.");return;}
  $$("#manualScheduleRows .manual-payment-input").forEach(input=>{input.value=String(value);});
  updateLoanSummary();
}
function updateLoanSummary() {
  const principal=Math.round(n($("loanTotal").value));
  const mode=$("loanRepaymentMode").value;
  let finalPayable=0,count=0,endText="—";
  if(mode==="equal"){
    count=Math.max(0,Math.round(n($("loanCount").value)));
    const installment=Math.round(n($("loanInstallment").value));
    finalPayable=count*installment;
    const sy=n($("loanStartYear").value),sm=n($("loanStartMonth").value);
    if(sy&&sm&&count){const d=addJMonth(sy,sm,count-1);endText=monthText(d.jy,d.jm);}
  }else{
    const inputs=$$("#manualScheduleRows .manual-payment-input");
    count=inputs.length;
    finalPayable=inputs.reduce((s,input)=>s+Math.round(n(input.value)),0);
    const ey=n($("loanEndYear").value),em=n($("loanEndMonth").value);
    if(ey&&em)endText=monthText(ey,em);
  }
  const interest=finalPayable-principal;
  const rate=principal>0?interest/principal*100:0;
  $("loanEndText").textContent=endText;
  $("loanFinalAmount").textContent=money(finalPayable);
  $("loanInterestAmount").textContent=money(Math.max(0,interest));
  $("loanInterestRate").textContent=(interest>=0?rate:0).toFixed(1)+"%";
  $("loanSummaryWarning").textContent=principal>0&&finalPayable>0&&finalPayable<principal?"Final payable amount cannot be lower than the original loan amount.":"";
}
function syncLoanMode() {
  const manual=$("loanRepaymentMode").value==="manual";
  $("equalLoanFields").classList.toggle("hidden",manual);
  $("manualLoanFields").classList.toggle("hidden",!manual);
  $("loanCount").required=!manual;
  $("loanInstallment").required=!manual;
  $("loanEndYear").required=manual;
  $("loanEndMonth").required=manual;
  if(manual)buildManualSchedule(true);
  updateLoanSummary();
}
function openLoanDialog(loanId=null) {
  $("loanForm").reset();
  $("loanId").value=loanId||"";
  $("loanModalTitle").textContent=loanId?"Edit loan":"Add loan";
  const c=currentJalali();
  $("loanStartYear").value=c.jy;$("loanStartMonth").value=c.jm;$("loanCount").value=12;$("loanDueDay").value=1;
  const de=addJMonth(c.jy,c.jm,11);$("loanEndYear").value=de.jy;$("loanEndMonth").value=de.jm;
  $("loanRepaymentMode").value="equal";$("manualFillAmount").value="";$("manualScheduleRows").innerHTML="";$("manualPaymentCount").textContent="0";

  if(loanId){
    const l=loans.find(x=>x.id===loanId);if(!l)return;
    const lp=payments.filter(p=>p.loan_id===loanId).sort((a,b)=>monthKey(a.due_jyear,a.due_jmonth)-monthKey(b.due_jyear,b.due_jmonth));
    $("loanName").value=l.name||"";$("loanLender").value=l.lender||"";$("loanTotal").value=l.total_amount||"";
    $("loanStartYear").value=l.start_jyear;$("loanStartMonth").value=l.start_jmonth;$("loanEndYear").value=l.end_jyear;$("loanEndMonth").value=l.end_jmonth;
    $("loanDueDay").value=l.due_day||1;$("loanNotes").value=l.notes||"";
    const same=lp.length>0 && lp.every(p=>n(p.amount)===n(lp[0].amount));
    const mode=(l.repayment_mode==="manual"||!same)?"manual":"equal";
    $("loanRepaymentMode").value=mode;
    if(mode==="equal"){
      $("loanCount").value=lp.length||l.payment_count||1;$("loanInstallment").value=lp.length?lp[0].amount:l.installment_amount;
    }else{
      syncLoanMode();
      const map={};lp.forEach(p=>{map[p.due_jyear+"-"+p.due_jmonth]=p.amount;});
      $$("#manualScheduleRows .manual-payment-input").forEach(input=>{if(map[input.dataset.key]!=null)input.value=map[input.dataset.key];});
    }
  }
  syncLoanMode();updateLoanSummary();$("loanDialog").showModal();
}
function loanScheduleFromForm() {
  const mode=$("loanRepaymentMode").value,sy=n($("loanStartYear").value),sm=n($("loanStartMonth").value);
  if(mode==="equal"){
    const count=Math.round(n($("loanCount").value)),inst=Math.round(n($("loanInstallment").value));
    if(count<1||inst<=0)return null;
    return Array.from({length:count},(_,i)=>{const d=addJMonth(sy,sm,i);return {jyear:d.jy,jmonth:d.jm,amount:inst};});
  }
  const inputs=$$("#manualScheduleRows .manual-payment-input");
  const rows=inputs.map(input=>({jyear:n(input.dataset.jyear),jmonth:n(input.dataset.jmonth),amount:Math.round(n(input.value))}));
  return rows.length&&rows.every(x=>x.amount>0)?rows:null;
}
async function saveLoan(e) {
  e.preventDefault();
  const id=$("loanId").value||null, name=$("loanName").value.trim(),principal=Math.round(n($("loanTotal").value));
  const sy=n($("loanStartYear").value),sm=n($("loanStartMonth").value),dueDay=n($("loanDueDay").value),mode=$("loanRepaymentMode").value;
  const schedule=loanScheduleFromForm();
  if(!name||principal<=0||!sy||!sm||!schedule){toast("Complete the loan schedule.");return;}
  const finalPayable=schedule.reduce((s,x)=>s+x.amount,0);
  if(finalPayable<principal){toast("Final payable amount cannot be lower than the original loan amount.");return;}
  const last=schedule[schedule.length-1], installment=mode==="equal"?schedule[0].amount:null;
  const data={
    name:name,lender:$("loanLender").value.trim(),total_amount:principal,start_jyear:sy,start_jmonth:sm,
    end_jyear:last.jyear,end_jmonth:last.jmonth,installment_amount:installment,due_day:dueDay,
    notes:$("loanNotes").value.trim(),repayment_mode:mode,final_payable_amount:finalPayable,interest_amount:finalPayable-principal
  };
  const r=await sb.rpc("save_loan_schedule",{p_loan_id:id,p_loan:data,p_schedule:schedule});
  if(r.error){toast(r.error.message);return;}
  $("loanDialog").close();toast(id?"Loan updated.":"Loan added.");await refreshAll();
}

function salarySchedule(def) {
  const count=monthSpan(def.start_jyear,def.start_jmonth,def.end_jyear,def.end_jmonth);
  if(count<1||count>600)return [];
  const growth=n(def.annual_growth_percent)/100;
  return Array.from({length:count},(_,i)=>{
    const d=addJMonth(def.start_jyear,def.start_jmonth,i);
    const step=Math.floor(i/12);
    const amount=Math.round(n(def.base_monthly_amount)*Math.pow(1+growth,step));
    return {jyear:d.jy,jmonth:d.jm,amount:amount};
  });
}
function renderSalaries() {
  $("salaryGrid").innerHTML=salaries.length?salaries.map(s=>{
    const rows=salaryMonths.filter(x=>x.salary_id===s.id);
    const total=rows.reduce((sum,x)=>sum+n(x.amount),0);
    const first=rows.length?n(rows[0].amount):n(s.base_monthly_amount);
    const last=rows.length?n(rows[rows.length-1].amount):n(s.base_monthly_amount);
    return '<div class="mini-card"><h3>'+esc(s.person_name)+'</h3><div class="small muted">'+esc(s.title||"Salary")+'</div>' +
      '<div class="loan-figures"><div><span class="small muted">Starting monthly</span><span>'+money(first)+'</span></div><div><span class="small muted">Ending monthly</span><span>'+money(last)+'</span></div><div><span class="small muted">Forecast total</span><span>'+money(total)+'</span></div></div>' +
      '<div class="small muted">'+monthText(s.start_jyear,s.start_jmonth)+' → '+monthText(s.end_jyear,s.end_jmonth)+' · annual growth '+n(s.annual_growth_percent).toFixed(1)+'%</div>' +
      '<div class="mini-actions"><button class="ghost salary-edit" data-id="'+s.id+'">Edit</button><button class="ghost danger salary-delete" data-id="'+s.id+'">Delete</button></div></div>';
  }).join(""):'<div class="empty full">No salary definitions yet.</div>';
}
function updateSalarySummary() {
  const def={
    base_monthly_amount:n($("salaryAmount").value),
    start_jyear:n($("salaryStartYear").value),start_jmonth:n($("salaryStartMonth").value),
    end_jyear:n($("salaryEndYear").value),end_jmonth:n($("salaryEndMonth").value),
    annual_growth_percent:n($("salaryGrowth").value)
  };
  const rows=salarySchedule(def);
  $("salaryMonthsCount").textContent=String(rows.length);
  $("salaryFirstAmount").textContent=money(rows.length?rows[0].amount:0);
  $("salaryLastAmount").textContent=money(rows.length?rows[rows.length-1].amount:0);
  $("salaryForecastTotal").textContent=money(rows.reduce((s,x)=>s+n(x.amount),0));
  $("salarySummaryWarning").textContent=rows.length?"":"End month must be after the start month.";
}
function openSalaryDialog(id=null) {
  $("salaryForm").reset();$("salaryId").value=id||"";$("salaryModalTitle").textContent=id?"Edit salary definition":"Add salary definition";
  const c=currentJalali(),end=addJMonth(c.jy,c.jm,59);
  $("salaryStartYear").value=c.jy;$("salaryStartMonth").value=c.jm;$("salaryEndYear").value=end.jy;$("salaryEndMonth").value=end.jm;$("salaryGrowth").value=0;$("salaryPayDay").value=1;
  if(id){
    const s=salaries.find(x=>x.id===id);if(!s)return;
    $("salaryPerson").value=s.person_name||"";$("salaryTitle").value=s.title||"";$("salaryAmount").value=s.base_monthly_amount||"";
    $("salaryStartYear").value=s.start_jyear;$("salaryStartMonth").value=s.start_jmonth;$("salaryEndYear").value=s.end_jyear;$("salaryEndMonth").value=s.end_jmonth;
    $("salaryGrowth").value=s.annual_growth_percent||0;$("salaryPayDay").value=s.pay_day||1;$("salaryNotes").value=s.notes||"";
  }
  updateSalarySummary();$("salaryDialog").showModal();
}
async function saveSalary(e) {
  e.preventDefault();
  const id=$("salaryId").value||null;
  const def={
    person_name:$("salaryPerson").value.trim(),title:$("salaryTitle").value.trim()||"Salary",
    base_monthly_amount:Math.round(n($("salaryAmount").value)),
    start_jyear:n($("salaryStartYear").value),start_jmonth:n($("salaryStartMonth").value),
    end_jyear:n($("salaryEndYear").value),end_jmonth:n($("salaryEndMonth").value),
    annual_growth_percent:n($("salaryGrowth").value),pay_day:n($("salaryPayDay").value),
    notes:$("salaryNotes").value.trim()
  };
  const schedule=salarySchedule(def);
  if(!def.person_name||def.base_monthly_amount<=0||!schedule.length){toast("Complete the salary definition.");return;}
  const r=await sb.rpc("save_salary_definition",{p_salary_id:id,p_definition:def,p_schedule:schedule});
  if(r.error){toast(r.error.message);return;}
  $("salaryDialog").close();toast(id?"Salary definition updated.":"Salary definition added.");await refreshAll();
}

function renderAccounts() {
  $("accountsGrid").innerHTML=accounts.length?accounts.map(a=>
    '<div class="mini-card"><h3>'+esc(a.name)+'</h3><div class="small muted">'+esc(a.type)+' · '+esc(a.currency)+'</div><div class="account-value">'+money(a.opening_balance,a.currency)+'</div><div class="mini-actions"><button class="ghost danger account-delete" data-id="'+a.id+'">Delete</button></div></div>'
  ).join(""):'<div class="empty full">No financial accounts.</div>';
}
function openAccount() {
  $("accountForm").reset();$("accountCurrency").value="TOMAN";$("accountOpening").value=0;$("accountDialog").showModal();
}
async function saveAccount(e) {
  e.preventDefault();
  const row={user_id:user.id,name:$("accountName").value.trim(),type:$("accountType").value,currency:$("accountCurrency").value,opening_balance:n($("accountOpening").value)};
  const r=await sb.from("accounts").insert(row);if(r.error){toast(r.error.message);return;}$("accountDialog").close();await refreshAll();
}

function chartYears() {
  const set=new Set();
  for(let y=selected.jy-10;y<=selected.jy+30;y++)set.add(y);
  payments.forEach(x=>set.add(x.due_jyear));salaryMonths.forEach(x=>set.add(x.due_jyear));
  return Array.from(set).sort((a,b)=>a-b);
}
function renderChartControls() {
  const years=chartYears();
  const yearVal=n($("chartYear").value)||selected.jy;
  $("chartYear").innerHTML=years.map(y=>'<option value="'+y+'" '+(y===yearVal?"selected":"")+'>'+y+'</option>').join("");
  const minY=years[0]||selected.jy,maxY=years[years.length-1]||selected.jy;
  const d0=Math.floor(minY/10)*10,d1=Math.floor(maxY/10)*10;
  const dec=[];for(let d=d0;d<=d1;d+=10)dec.push(d);
  const dVal=n($("chartDecade").value)||Math.floor(selected.jy/10)*10;
  if(!dec.includes(dVal))dec.push(dVal);
  dec.sort((a,b)=>a-b);
  $("chartDecade").innerHTML=dec.map(d=>'<option value="'+d+'" '+(d===dVal?"selected":"")+'>'+d+'–'+(d+9)+'</option>').join("");
  const yearMode=$("chartMode").value==="year";
  $("chartYearWrap").classList.toggle("hidden",!yearMode);$("chartDecadeWrap").classList.toggle("hidden",yearMode);
}
function annualSum(rows,year) {
  return rows.filter(x=>x.due_jyear===year).reduce((s,x)=>s+n(x.amount),0);
}
function renderChart() {
  if(typeof Chart==="undefined"||!$("cashflowChart"))return;
  const mode=$("chartMode").value;
  const chartType=$("chartType").value;
  let labels=[],totalData=[],paidData=[],remainingData=[],earnData=[];
  if(mode==="year"){
    const year=n($("chartYear").value)||selected.jy;
    labels=MONTHS.slice();
    totalData=MONTHS.map((_,i)=>payments.filter(p=>p.due_jyear===year&&p.due_jmonth===i+1).reduce((s,p)=>s+n(p.amount),0));
    paidData=MONTHS.map((_,i)=>payments.filter(p=>p.due_jyear===year&&p.due_jmonth===i+1&&p.is_paid).reduce((s,p)=>s+n(p.amount),0));
    remainingData=MONTHS.map((_,i)=>payments.filter(p=>p.due_jyear===year&&p.due_jmonth===i+1&&!p.is_paid).reduce((s,p)=>s+n(p.amount),0));
    earnData=MONTHS.map((_,i)=>salaryMonths.filter(p=>p.due_jyear===year&&p.due_jmonth===i+1).reduce((s,p)=>s+n(p.amount),0));
    $("chartTitle").textContent="Monthly cash-flow · "+year;
  }else{
    const start=n($("chartDecade").value)||Math.floor(selected.jy/10)*10;
    labels=Array.from({length:10},(_,i)=>String(start+i));
    totalData=labels.map(y=>payments.filter(p=>p.due_jyear===Number(y)).reduce((s,p)=>s+n(p.amount),0));
    paidData=labels.map(y=>payments.filter(p=>p.due_jyear===Number(y)&&p.is_paid).reduce((s,p)=>s+n(p.amount),0));
    remainingData=labels.map(y=>payments.filter(p=>p.due_jyear===Number(y)&&!p.is_paid).reduce((s,p)=>s+n(p.amount),0));
    earnData=labels.map(y=>annualSum(salaryMonths,Number(y)));
    $("chartTitle").textContent="Decade cash-flow · "+start+"–"+(start+9);
  }
  const datasets=[];
  const common = chartType==="line"
    ? {fill:false,tension:.25,borderWidth:2,pointRadius:3,pointHoverRadius:5}
    : {borderWidth:1,borderRadius:5};
  if($("chartPaymentsOn").checked)datasets.push(Object.assign({label:"Total payments",data:totalData,backgroundColor:"rgba(17,24,39,.22)",borderColor:"#111827"},common));
  if($("chartEarningsOn").checked)datasets.push(Object.assign({label:"Earnings",data:earnData,backgroundColor:"rgba(37,99,235,.28)",borderColor:"#2563eb"},common));
  if($("chartRemainingOn").checked)datasets.push(Object.assign({label:"Remaining payments",data:remainingData,backgroundColor:"rgba(239,68,68,.26)",borderColor:"#dc2626"},common));
  if($("chartPaidOn").checked)datasets.push(Object.assign({label:"Paid payments",data:paidData,backgroundColor:"rgba(34,197,94,.28)",borderColor:"#16a34a"},common));
  if(chartInstance)chartInstance.destroy();
  chartInstance=new Chart($("cashflowChart"),{
    type:chartType,
    data:{labels,datasets},
    options:{
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:"index",intersect:false},
      plugins:{legend:{labels:{usePointStyle:true,boxWidth:8,font:{weight:"normal"}}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+money(ctx.raw)}}},
      scales:{
        x:{grid:{display:false},title:{display:true,text:mode==="year"?"Solar month":"Solar year"}},
        y:{beginAtZero:true,title:{display:true,text:"T"},ticks:{callback:v=>new Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:1}).format(v)}}
      }
    }
  });
}

async function manageUsersRequest(action,extra={}) {
  const session=(await sb.auth.getSession()).data.session;
  if(!session)throw new Error("Sign in first.");
  const res=await fetch(cfg.MANAGE_USERS_URL,{
    method:"POST",
    headers:{"Content-Type":"application/json","apikey":cfg.SUPABASE_PUBLISHABLE_KEY,"Authorization":"Bearer "+session.access_token},
    body:JSON.stringify(Object.assign({action,key:adminKey},extra))
  });
  const out=await res.json();if(!res.ok)throw new Error(out.error||"Request failed.");return out;
}
async function unlockUserManager() {
  adminKey=$("adminPassKey").value;
  if(!adminKey){$("adminMsg").textContent="Enter the pass key.";return;}
  $("adminMsg").textContent="Checking...";
  try{
    const out=await manageUsersRequest("list");
    $("adminMsg").textContent="";
    renderUsers(out.users||[]);
    $("adminLocked").classList.add("hidden");$("adminUnlocked").classList.remove("hidden");
  }catch(e){$("adminMsg").textContent=e.message;}
}
function renderUsers(users) {
  $("usersList").innerHTML=users.length?users.map(u=>
    '<div class="user-row"><div><div class="row-title">'+esc(u.email||"(no email)")+'</div><div class="small muted">Created '+new Date(u.created_at).toLocaleDateString()+(u.last_sign_in_at?" · Last sign-in "+new Date(u.last_sign_in_at).toLocaleDateString():"")+'</div></div>' +
    '<div><span class="pill '+(u.approved?"good":"bad")+'">'+(u.approved?"Approved":"Blocked")+'</span></div>' +
    '<div><button class="ghost user-access-toggle" data-id="'+u.id+'" data-approved="'+(u.approved?"1":"0")+'" '+(u.is_current?"disabled":"")+'>'+(u.approved?"Revoke":"Approve")+'</button></div></div>'
  ).join(""):'<div class="empty">No users.</div>';
}
async function refreshUsers() {
  try{const out=await manageUsersRequest("list");renderUsers(out.users||[]);}catch(e){toast(e.message);}
}
function openUserManager() {
  adminKey="";$("adminPassKey").value="";$("adminMsg").textContent="";$("usersList").innerHTML="";
  $("adminLocked").classList.remove("hidden");$("adminUnlocked").classList.add("hidden");$("usersDialog").showModal();
}

function exportBackup() {
  const blob=new Blob([JSON.stringify({exported_at:new Date().toISOString(),accounts,loans,loan_payments:payments,salary_definitions:salaries,salary_months:salaryMonths},null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="my-finance-backup-"+todayISO()+".json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

function bind() {
  $("authForm").onsubmit=e=>{e.preventDefault();signIn();};
  $("signupBtn").onclick=createAccount;
  $("logoutBtn").onclick=async()=>{await sb.auth.signOut();showAuth();};
  $("exportBtn").onclick=exportBackup;
  $("manageUsersBtn").onclick=openUserManager;

  $$(".tab").forEach(b=>b.onclick=()=>{
    $$(".tab").forEach(x=>x.classList.remove("active"));b.classList.add("active");
    $$(".view").forEach(v=>v.classList.remove("active"));$(b.dataset.view+"View").classList.add("active");
    $("pageTitle").textContent=b.textContent.trim();
    if(b.dataset.view==="charts"){renderChartControls();renderChart();}
  });
  $$("[data-close]").forEach(b=>b.onclick=()=>$(b.dataset.close).close());

  $("monthCircles").onclick=e=>{
    const b=e.target.closest("[data-payment-month]");if(!b)return;
    selectedMonth=n(b.dataset.paymentMonth);renderPayments();
  };
  $("dashboardYearCircles").onclick=e=>{
    const b=e.target.closest("[data-dashboard-year]");if(!b)return;
    dashboardYear=n(b.dataset.dashboardYear);dashboardMonth=selected.jm;renderDashboard();
  };
  $("paymentHeatmap").onclick=e=>{
    const b=e.target.closest("[data-heat-month]");if(!b)return;
    dashboardMonth=n(b.dataset.heatMonth);renderDashboard();
  };
  $("paymentsList").onchange=e=>{if(e.target.classList.contains("pay-toggle"))togglePayment(e.target.dataset.id,e.target.checked);};

  $("addLoanBtn").onclick=()=>openLoanDialog();
  $("loanForm").onsubmit=saveLoan;
  $("loanRepaymentMode").onchange=syncLoanMode;
  ["loanTotal","loanStartYear","loanStartMonth","loanCount","loanInstallment"].forEach(id=>$(id).addEventListener("input",updateLoanSummary));
  ["loanStartYear","loanStartMonth","loanEndYear","loanEndMonth"].forEach(id=>$(id).addEventListener("change",()=>{if($("loanRepaymentMode").value==="manual")buildManualSchedule(true);else updateLoanSummary();}));
  $("manualFillBtn").onclick=fillManualSchedule;
  $("manualScheduleRows").addEventListener("input",e=>{if(e.target.classList.contains("manual-payment-input"))updateLoanSummary();});
  $("loansGrid").onclick=async e=>{
    const edit=e.target.closest(".loan-edit"),map=e.target.closest(".loan-open-map"),del=e.target.closest(".loan-delete");
    if(edit)openLoanDialog(edit.dataset.id);
    if(map){document.querySelector('[data-view="payments"]').click();renderPayments();}
    if(del&&confirm("Delete this loan and all its payment schedule?")){const r=await sb.from("loans").delete().eq("id",del.dataset.id);if(r.error)toast(r.error.message);else await refreshAll();}
  };

  $("addSalaryBtn").onclick=()=>openSalaryDialog();
  $("salaryForm").onsubmit=saveSalary;
  ["salaryAmount","salaryStartYear","salaryStartMonth","salaryEndYear","salaryEndMonth","salaryGrowth"].forEach(id=>$(id).addEventListener("input",updateSalarySummary));
  $("salaryGrid").onclick=async e=>{
    const edit=e.target.closest(".salary-edit"),del=e.target.closest(".salary-delete");
    if(edit)openSalaryDialog(edit.dataset.id);
    if(del&&confirm("Delete this salary definition and its forecast?")){const r=await sb.from("salary_definitions").delete().eq("id",del.dataset.id);if(r.error)toast(r.error.message);else await refreshAll();}
  };

  $("addAccountBtn").onclick=openAccount;$("accountForm").onsubmit=saveAccount;
  $("accountsGrid").onclick=async e=>{
    const b=e.target.closest(".account-delete");if(!b)return;
    if(confirm("Delete this financial account?")){const r=await sb.from("accounts").delete().eq("id",b.dataset.id);if(r.error)toast(r.error.message);else await refreshAll();}
  };

  ["chartType","chartMode","chartYear","chartDecade","chartPaymentsOn","chartEarningsOn","chartRemainingOn","chartPaidOn"].forEach(id=>$(id).addEventListener("change",()=>{renderChartControls();renderChart();}));

  $("adminUnlockBtn").onclick=unlockUserManager;
  $("adminRefreshBtn").onclick=refreshUsers;
  $("usersList").onclick=async e=>{
    const b=e.target.closest(".user-access-toggle");if(!b)return;
    try{
      await manageUsersRequest("set_access",{user_id:b.dataset.id,approved:b.dataset.approved!=="1"});
      await refreshUsers();
    }catch(err){toast(err.message);}
  };
}

bind();
sb.auth.onAuthStateChange((event,session)=>{
  if(event==="SIGNED_OUT")showAuth();
  else if(session&&(!user||session.user.id!==user.id))enter(session.user);
});
sb.auth.getSession().then(r=>r.data.session?enter(r.data.session.user):showAuth());
})();