(() => {
"use strict";

const cfg = window.APP_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
const $ = id => document.getElementById(id);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const MONTHS = ["Farvardin / فروردین","Ordibehesht / اردیبهشت","Khordad / خرداد","Tir / تیر","Mordad / مرداد","Shahrivar / شهریور","Mehr / مهر","Aban / آبان","Azar / آذر","Dey / دی","Bahman / بهمن","Esfand / اسفند"];
const CURRENCIES = ["TOMAN","AZN","USD","EUR","IRR"];

let user = null;
let accounts = [], transactions = [], budgets = [], loans = [], payments = [];
let selected = currentJalali();
let selectedYear = selected.jy;
let selectedMonth = selected.jm;

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function n(v) { return Number(v || 0); }
function money(v, currency="TOMAN") {
  return new Intl.NumberFormat("en-US",{maximumFractionDigits:0}).format(Math.round(n(v))) + " " + currency;
}
function currentJalali() {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian",{year:"numeric",month:"numeric",day:"numeric"}).formatToParts(new Date());
  const pick = t => Number(parts.find(p => p.type === t)?.value || 0);
  return {jy: pick("year"), jm: pick("month"), jd: pick("day")};
}
function addJMonth(jy, jm, offset) {
  const idx = jy * 12 + (jm - 1) + offset;
  return {jy: Math.floor(idx / 12), jm: (idx % 12 + 12) % 12 + 1};
}
function monthKey(jy,jm) { return jy * 100 + jm; }
function monthText(jy,jm) { return `${MONTHS[jm-1]} ${jy}`; }
function isPastMonth(jy,jm) { return monthKey(jy,jm) < monthKey(selected.jy,selected.jm); }
function isCurrentMonth(jy,jm) { return jy===selected.jy && jm===selected.jm; }
function groupMoney(rows, amountFn, currencyFn) {
  const m = {};
  rows.forEach(r => { const c=currencyFn(r)||"TOMAN"; m[c]=(m[c]||0)+amountFn(r); });
  const keys=Object.keys(m);
  return keys.length ? keys.map(c=>money(m[c],c)).join(" · ") : "0";
}
function accountBalance(a) {
  let b = n(a.opening_balance);
  transactions.forEach(t => {
    if (t.type === "income" && t.account_id === a.id) b += n(t.amount);
    if (t.type === "expense" && t.account_id === a.id) b -= n(t.amount);
    if (t.type === "transfer") {
      if (t.account_id === a.id) b -= n(t.amount);
      if (t.to_account_id === a.id) b += n(t.amount);
    }
  });
  return b;
}
function todayISO(){ return new Date().toISOString().slice(0,10); }

async function signIn() {
  const email = $("email").value.trim();
  const password = $("password").value;
  $("authMsg").textContent = "Signing in...";
  const {data,error} = await sb.auth.signInWithPassword({email,password});
  if (error) { $("authMsg").textContent = error.message; return; }
  await enter(data.user);
}
async function createAccount() {
  const email = $("email").value.trim();
  const password = $("password").value;
  const key = $("accessKey").value;
  if (!email || !password || !key) { $("authMsg").textContent = "Email, password and access key are required."; return; }
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
    $("authView").classList.remove("hidden");
    $("appView").classList.add("hidden");
    $("authMsg").textContent = "This account is not approved. Create it using the access key.";
    return;
  }
  user = u;
  $("userEmail").textContent = u.email || "";
  $("authView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  await refreshAll();
}
function showAuth(){
  user=null;
  $("appView").classList.add("hidden");
  $("authView").classList.remove("hidden");
}
async function refreshAll() {
  const [ar,tr,br,lr,pr] = await Promise.all([
    sb.from("accounts").select("*").order("created_at"),
    sb.from("transactions").select("*").order("date",{ascending:false}).order("created_at",{ascending:false}),
    sb.from("budgets").select("*").order("category"),
    sb.from("loans").select("*").order("created_at",{ascending:false}),
    sb.from("loan_payments").select("*").order("due_jyear").order("due_jmonth").order("installment_no")
  ]);
  const err = [ar,tr,br,lr,pr].find(x=>x.error)?.error;
  if (err) { toast(err.message); return; }
  accounts=ar.data||[]; transactions=tr.data||[]; budgets=br.data||[]; loans=lr.data||[]; payments=pr.data||[];
  renderAll();
}
function renderAll(){
  renderDashboard();
  renderLoans();
  renderPayments();
  renderTransactions();
  renderAccounts();
  renderBudgets();
  fillAccountSelects();
}

function renderDashboard() {
  const balances = accounts.map(a=>({currency:a.currency,amount:accountBalance(a)}));
  $("totalBalance").textContent = groupMoney(balances,x=>x.amount,x=>x.currency);
  const now = new Date(), y=now.getFullYear(), m=now.getMonth();
  const mt = transactions.filter(t=>{const d=new Date(t.date+"T12:00:00");return d.getFullYear()===y&&d.getMonth()===m;});
  $("monthIncome").textContent = groupMoney(mt.filter(t=>t.type==="income"),t=>n(t.amount),t=>t.currency);
  $("monthExpense").textContent = groupMoney(mt.filter(t=>t.type==="expense"),t=>n(t.amount),t=>t.currency);

  const cur = payments.filter(p=>p.due_jyear===selected.jy && p.due_jmonth===selected.jm);
  const due = cur.reduce((s,p)=>s+n(p.amount),0);
  const rem = cur.filter(p=>!p.is_paid).reduce((s,p)=>s+n(p.amount),0);
  const outstanding = payments.filter(p=>!p.is_paid).reduce((s,p)=>s+n(p.amount),0);
  $("currentSolarMonth").textContent = monthText(selected.jy,selected.jm);
  $("monthLoanDue").textContent = money(due);
  $("monthLoanRemaining").textContent = money(rem);
  $("loanOutstanding").textContent = money(outstanding);

  const recent = transactions.slice(0,6);
  $("recentTransactions").innerHTML = recent.length ? recent.map(t=>{
    const sign=t.type==="income"?"+":t.type==="expense"?"−":"↔";
    return `<div class="row"><div><div class="row-title">${esc(t.category||t.type)}</div><div class="small muted">${esc(t.description||t.date)}</div></div><div class="${t.type==="income"?"good":t.type==="expense"?"bad":""}">${sign} ${money(t.amount,t.currency)}</div><div class="mobile-hide muted">${esc(t.date)}</div><div class="optional"></div><div></div></div>`;
  }).join("") : '<div class="empty">No transactions yet.</div>';

  const next = payments.filter(p=>!p.is_paid && monthKey(p.due_jyear,p.due_jmonth)>=monthKey(selected.jy,selected.jm)).slice(0,6);
  $("nextPayments").innerHTML = next.length ? next.map(p=>{
    const loan=loans.find(l=>l.id===p.loan_id);
    return `<div class="row"><div><div class="row-title">${esc(loan?.name||"Loan")}</div><div class="small muted">Installment ${p.installment_no}</div></div><div>${money(p.amount)}</div><div class="mobile-hide">${monthText(p.due_jyear,p.due_jmonth)}</div><div class="optional">day ${p.due_day}</div><div><span class="pill warn">Unpaid</span></div></div>`;
  }).join("") : '<div class="empty">No upcoming unpaid loan payments.</div>';
}

function renderLoans() {
  $("loansGrid").innerHTML = loans.length ? loans.map(l=>{
    const lp=payments.filter(p=>p.loan_id===l.id);
    const paid=lp.filter(p=>p.is_paid);
    const paidAmount=paid.reduce((s,p)=>s+n(p.amount),0);
    const rem=lp.filter(p=>!p.is_paid).reduce((s,p)=>s+n(p.amount),0);
    const pct=lp.length?Math.round(paid.length*100/lp.length):0;
    return `<div class="mini-card">
      <h3>${esc(l.name)}</h3>
      <div class="small muted">${esc(l.lender||"Loan")} · ${l.payment_count} payments</div>
      <div style="margin-top:9px;font-weight:900">${money(l.total_amount)}</div>
      <div class="small muted">${monthText(l.start_jyear,l.start_jmonth)} → ${monthText(l.end_jyear,l.end_jmonth)}</div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <div class="small"><b>${paid.length}/${lp.length}</b> paid · Remaining ${money(rem)}</div>
      <div class="small muted">Standard installment: ${money(l.installment_amount)} · due day ${l.due_day}</div>
      <div class="mini-actions"><button class="ghost loan-open-map" data-id="${l.id}">View payments</button><button class="ghost danger loan-delete" data-id="${l.id}">Delete</button></div>
    </div>`;
  }).join("") : '<div class="empty full">No loans defined yet. Add your first loan.</div>';
}
function updateLoanCalc() {
  const jy=Number($("loanStartYear").value), jm=Number($("loanStartMonth").value), count=Number($("loanCount").value), total=Number($("loanTotal").value);
  if(jy&&jm&&count){
    const end=addJMonth(jy,jm,count-1);
    $("loanEndText").textContent=monthText(end.jy,end.jm);
  } else $("loanEndText").textContent="—";
  if(total>0&&count>0&&$("loanInstallment").dataset.manual!=="1"){
    $("loanInstallment").value=Math.floor(total/count);
  }
}
function openLoanDialog() {
  const c=currentJalali();
  $("loanForm").reset();
  $("loanStartYear").value=c.jy;
  $("loanStartMonth").value=c.jm;
  $("loanCount").value=12;
  $("loanDueDay").value=1;
  $("loanInstallment").dataset.manual="0";
  updateLoanCalc();
  $("loanDialog").showModal();
}
async function saveLoan(e) {
  e.preventDefault();
  const name=$("loanName").value.trim(), lender=$("loanLender").value.trim();
  const total=Math.round(Number($("loanTotal").value)), jy=Number($("loanStartYear").value), jm=Number($("loanStartMonth").value);
  const count=Number($("loanCount").value), installment=Math.round(Number($("loanInstallment").value)), dueDay=Number($("loanDueDay").value);
  const notes=$("loanNotes").value.trim();
  if(!name||total<=0||count<1||installment<=0){toast("Complete the loan fields.");return;}
  if(installment*(count-1)>=total){toast("Installment amount is too high for this total and payment count.");return;}
  const end=addJMonth(jy,jm,count-1);
  const loanRow={user_id:user.id,name,lender:lender||null,total_amount:total,start_jyear:jy,start_jmonth:jm,end_jyear:end.jy,end_jmonth:end.jm,payment_count:count,installment_amount:installment,due_day:dueDay,notes:notes||null};
  const ins=await sb.from("loans").insert(loanRow).select().single();
  if(ins.error){toast(ins.error.message);return;}
  const rows=[];
  for(let i=0;i<count;i++){
    const d=addJMonth(jy,jm,i);
    const amount=i===count-1 ? total-installment*(count-1) : installment;
    rows.push({loan_id:ins.data.id,user_id:user.id,installment_no:i+1,due_jyear:d.jy,due_jmonth:d.jm,due_day:dueDay,amount,is_paid:false});
  }
  const p=await sb.from("loan_payments").insert(rows);
  if(p.error){await sb.from("loans").delete().eq("id",ins.data.id);toast(p.error.message);return;}
  $("loanDialog").close();toast("Loan added.");await refreshAll();
}

function renderPayments() {
  const years = new Set([selected.jy]);
  for(let y=selected.jy-5;y<=selected.jy+15;y++)years.add(y);
  payments.forEach(p=>years.add(p.due_jyear));
  const ys=Array.from(years).sort((a,b)=>a-b);
  $("payYear").innerHTML=ys.map(y=>`<option value="${y}" ${y===selectedYear?"selected":""}>${y}</option>`).join("");
  $("yearMap").innerHTML=MONTHS.map((mn,i)=>{
    const m=i+1, rows=payments.filter(p=>p.due_jyear===selectedYear&&p.due_jmonth===m);
    const due=rows.reduce((s,p)=>s+n(p.amount),0), rem=rows.filter(p=>!p.is_paid).reduce((s,p)=>s+n(p.amount),0);
    const cls=[m===selectedMonth?"active":"",selectedYear===selected.jy&&m===selected.jm?"current":""].join(" ");
    return `<button class="month-card ${cls}" data-month="${m}">
      <div class="month-name">${mn}</div>
      <div class="month-money">${money(due)}</div>
      <div class="month-sub">${rows.length} payment${rows.length===1?"":"s"} · ${money(rem)} remaining</div>
    </button>`;
  }).join("");
  renderSelectedMonth();
}
function renderSelectedMonth(){
  const rows=payments.filter(p=>p.due_jyear===selectedYear&&p.due_jmonth===selectedMonth).sort((a,b)=>a.installment_no-b.installment_no);
  const due=rows.reduce((s,p)=>s+n(p.amount),0), paid=rows.filter(p=>p.is_paid).reduce((s,p)=>s+n(p.amount),0), rem=due-paid;
  const allOutstanding=payments.filter(p=>!p.is_paid).reduce((s,p)=>s+n(p.amount),0);
  $("selectedMonthTitle").textContent=monthText(selectedYear,selectedMonth);
  $("payDue").textContent=money(due);
  $("payPaid").textContent=money(paid);
  $("payRemaining").textContent=money(rem);
  $("payOutstanding").textContent=money(allOutstanding);
  $("paymentCountLabel").textContent=`${rows.length} payment${rows.length===1?"":"s"}`;
  $("paymentsList").innerHTML=rows.length?rows.map(p=>{
    const loan=loans.find(l=>l.id===p.loan_id);
    const badge=p.is_paid?'<span class="pill good">Paid</span>':isPastMonth(p.due_jyear,p.due_jmonth)?'<span class="pill bad">Overdue</span>':isCurrentMonth(p.due_jyear,p.due_jmonth)?'<span class="pill warn">Due</span>':'<span class="pill">Upcoming</span>';
    return `<div class="row">
      <div><div class="row-title">${esc(loan?.name||"Loan")}</div><div class="small muted">Installment ${p.installment_no} · day ${p.due_day}</div></div>
      <div>${money(p.amount)}</div>
      <div class="mobile-hide">${badge}</div>
      <div class="optional small muted">${p.paid_at ? "Paid "+new Date(p.paid_at).toLocaleDateString("fa-IR-u-ca-persian") : "Not paid"}</div>
      <div><input class="pay-toggle" type="checkbox" data-id="${p.id}" ${p.is_paid?"checked":""} title="Mark paid/unpaid"></div>
    </div>`;
  }).join(""):'<div class="empty">No loan payments in this Solar month.</div>';
}
async function togglePayment(id,checked){
  const r=await sb.from("loan_payments").update({is_paid:checked,paid_at:checked?new Date().toISOString():null}).eq("id",id);
  if(r.error){toast(r.error.message);return;}
  toast(checked?"Payment marked paid.":"Payment marked unpaid.");
  await refreshAll();
}

function renderTransactions(){
  const q=($("txSearch")?.value||"").toLowerCase(), type=$("txFilter")?.value||"all";
  const rows=transactions.filter(t=>(type==="all"||t.type===type)&&(!q||[t.category,t.description,t.date].join(" ").toLowerCase().includes(q)));
  $("transactionsList").innerHTML=rows.length?rows.map(t=>{
    const a=accounts.find(x=>x.id===t.account_id), to=accounts.find(x=>x.id===t.to_account_id);
    return `<div class="row">
      <div><div class="row-title">${esc(t.category||t.type)}</div><div class="small muted">${esc(t.description||"")}</div></div>
      <div class="${t.type==="income"?"good":t.type==="expense"?"bad":""}">${money(t.amount,t.currency)}</div>
      <div class="mobile-hide">${esc(a?.name||"")} ${to?"→ "+esc(to.name):""}</div>
      <div class="optional muted">${esc(t.date)}</div>
      <div><button class="ghost danger tx-delete" data-id="${t.id}">Delete</button></div>
    </div>`;
  }).join(""):'<div class="empty">No transactions.</div>';
}
function fillAccountSelects(){
  const opts=accounts.map(a=>`<option value="${a.id}">${esc(a.name)} (${a.currency})</option>`).join("");
  $("txAccount").innerHTML=opts; $("txToAccount").innerHTML=opts;
}
function typeChanged(){
  const tr=$("txType").value==="transfer";
  $("txToWrap").classList.toggle("hidden",!tr);
  $("txCategoryWrap").classList.toggle("hidden",tr);
}
function openTx(){
  if(!accounts.length){toast("Add an account first.");return;}
  $("txForm").reset();$("txDate").value=todayISO();$("txType").value="expense";$("txCurrency").value="TOMAN";typeChanged();fillAccountSelects();$("txDialog").showModal();
}
async function saveTx(e){
  e.preventDefault();
  const tr=$("txType").value==="transfer";
  if(tr&&$("txAccount").value===$("txToAccount").value){toast("Choose two different accounts.");return;}
  const row={user_id:user.id,type:$("txType").value,date:$("txDate").value,amount:Number($("txAmount").value),currency:$("txCurrency").value,account_id:$("txAccount").value,to_account_id:tr?$("txToAccount").value:null,category:tr?null:($("txCategory").value.trim()||"Other"),description:$("txDescription").value.trim()||null};
  const r=await sb.from("transactions").insert(row);if(r.error){toast(r.error.message);return;}$("txDialog").close();await refreshAll();
}

function renderAccounts(){
  $("accountsGrid").innerHTML=accounts.length?accounts.map(a=>`<div class="mini-card"><h3>${esc(a.name)}</h3><div class="small muted">${esc(a.type)} · ${a.currency}</div><div style="font-size:22px;font-weight:900;margin-top:10px">${money(accountBalance(a),a.currency)}</div><div class="mini-actions"><button class="ghost danger account-delete" data-id="${a.id}">Delete</button></div></div>`).join(""):'<div class="empty">No accounts.</div>';
}
function openAccount(){ $("accountForm").reset();$("accountCurrency").value="TOMAN";$("accountOpening").value=0;$("accountDialog").showModal(); }
async function saveAccount(e){
  e.preventDefault();const row={user_id:user.id,name:$("accountName").value.trim(),type:$("accountType").value,currency:$("accountCurrency").value,opening_balance:Number($("accountOpening").value||0)};
  const r=await sb.from("accounts").insert(row);if(r.error){toast(r.error.message);return;}$("accountDialog").close();await refreshAll();
}

function renderBudgets(){
  const now=new Date(), y=now.getFullYear(),m=now.getMonth();
  $("budgetsGrid").innerHTML=budgets.length?budgets.map(b=>{
    const spent=transactions.filter(t=>t.type==="expense"&&t.currency===b.currency&&t.category===b.category&&(()=>{const d=new Date(t.date+"T12:00:00");return d.getFullYear()===y&&d.getMonth()===m})()).reduce((s,t)=>s+n(t.amount),0);
    const pct=Math.min(100,Math.round(spent/n(b.amount)*100)||0);
    return `<div class="mini-card"><h3>${esc(b.category)}</h3><div>${money(spent,b.currency)} / ${money(b.amount,b.currency)}</div><div class="progress"><span style="width:${pct}%"></span></div><div class="mini-actions"><button class="ghost danger budget-delete" data-id="${b.id}">Delete</button></div></div>`;
  }).join(""):'<div class="empty">No budgets.</div>';
}
function openBudget(){ $("budgetForm").reset();$("budgetCurrency").value="TOMAN";$("budgetDialog").showModal(); }
async function saveBudget(e){
  e.preventDefault();const row={user_id:user.id,category:$("budgetCategory").value.trim(),amount:Number($("budgetAmount").value),currency:$("budgetCurrency").value};
  const r=await sb.from("budgets").upsert(row,{onConflict:"user_id,category,currency"});if(r.error){toast(r.error.message);return;}$("budgetDialog").close();await refreshAll();
}

function exportBackup(){
  const blob=new Blob([JSON.stringify({exported_at:new Date().toISOString(),accounts,transactions,budgets,loans,loan_payments:payments},null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="my-finance-backup-"+todayISO()+".json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

function bind(){
  $("loginBtn").onclick=signIn;$("signupBtn").onclick=createAccount;$("logoutBtn").onclick=async()=>{await sb.auth.signOut();showAuth();};
  $("authForm").onsubmit=e=>{e.preventDefault();signIn();};
  $$(".tab").forEach(b=>b.onclick=()=>{
    $$(".tab").forEach(x=>x.classList.remove("active"));b.classList.add("active");
    $$(".view").forEach(v=>v.classList.remove("active"));$(b.dataset.view+"View").classList.add("active");
    $("pageTitle").textContent=b.textContent.trim();
  });
  $$("[data-close]").forEach(b=>b.onclick=()=>$(b.dataset.close).close());
  $("addLoanBtn").onclick=openLoanDialog;$("loanForm").onsubmit=saveLoan;
  ["loanTotal","loanStartYear","loanStartMonth","loanCount"].forEach(id=>$(id).addEventListener("input",updateLoanCalc));
  $("loanInstallment").addEventListener("input",()=>{$("loanInstallment").dataset.manual="1";});
  $("yearMap").onclick=e=>{const b=e.target.closest("[data-month]");if(!b)return;selectedMonth=Number(b.dataset.month);renderPayments();};
  $("payYear").onchange=()=>{selectedYear=Number($("payYear").value);renderPayments();};
  $("prevYearBtn").onclick=()=>{selectedYear--;renderPayments();};$("nextYearBtn").onclick=()=>{selectedYear++;renderPayments();};
  $("todayMonthBtn").onclick=()=>{selectedYear=selected.jy;selectedMonth=selected.jm;renderPayments();};
  $("paymentsList").onchange=e=>{if(e.target.classList.contains("pay-toggle"))togglePayment(e.target.dataset.id,e.target.checked);};
  $("loansGrid").onclick=async e=>{
    const del=e.target.closest(".loan-delete"), map=e.target.closest(".loan-open-map");
    if(map){const l=loans.find(x=>x.id===map.dataset.id);if(l){selectedYear=l.start_jyear;selectedMonth=l.start_jmonth;document.querySelector('[data-view="payments"]').click();renderPayments();}}
    if(del&&confirm("Delete this loan and all its payment schedule?")){const r=await sb.from("loans").delete().eq("id",del.dataset.id);if(r.error)toast(r.error.message);else await refreshAll();}
  };
  $("addTxBtn").onclick=openTx;$("txForm").onsubmit=saveTx;$("txType").onchange=typeChanged;$("txSearch").oninput=renderTransactions;$("txFilter").onchange=renderTransactions;
  $("transactionsList").onclick=async e=>{const b=e.target.closest(".tx-delete");if(b&&confirm("Delete this transaction?")){const r=await sb.from("transactions").delete().eq("id",b.dataset.id);if(r.error)toast(r.error.message);else await refreshAll();}};
  $("addAccountBtn").onclick=openAccount;$("accountForm").onsubmit=saveAccount;
  $("accountsGrid").onclick=async e=>{const b=e.target.closest(".account-delete");if(!b)return;if(transactions.some(t=>t.account_id===b.dataset.id||t.to_account_id===b.dataset.id)){toast("Delete related transactions first.");return;}if(confirm("Delete this account?")){const r=await sb.from("accounts").delete().eq("id",b.dataset.id);if(r.error)toast(r.error.message);else await refreshAll();}};
  $("addBudgetBtn").onclick=openBudget;$("budgetForm").onsubmit=saveBudget;
  $("budgetsGrid").onclick=async e=>{const b=e.target.closest(".budget-delete");if(b&&confirm("Delete this budget?")){const r=await sb.from("budgets").delete().eq("id",b.dataset.id);if(r.error)toast(r.error.message);else await refreshAll();}};
  $("exportBtn").onclick=exportBackup;
}
bind();
sb.auth.onAuthStateChange((event,session)=>{if(event==="SIGNED_OUT")showAuth();else if(session&&(!user||session.user.id!==user.id))enter(session.user);});
sb.auth.getSession().then(r=>r.data.session?enter(r.data.session.user):showAuth());
})();