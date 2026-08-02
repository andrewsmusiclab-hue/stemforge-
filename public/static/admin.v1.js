/* StemForge Admin Panel JS — loaded as external file to avoid browser inline-script caching */

// ── Diagnostic strip ─────────────────────────────────────────
function diagSet(id, ok, msg){
  var el=document.getElementById('diag-'+id);
  if(!el) return;
  el.textContent=(ok?'✅ ':'❌ ')+id+': '+msg;
  el.style.background=ok?'rgba(16,185,129,.15)':'rgba(239,68,68,.15)';
  el.style.color=ok?'#6ee7b7':'#fca5a5';
  el.style.border='1px solid '+(ok?'rgba(16,185,129,.3)':'rgba(239,68,68,.4)');
}
async function runDiag(){
  var diagEl=document.getElementById('admin-diag');
  if(diagEl){ var ts=document.createElement('span'); ts.style.cssText='margin-left:8px;font-size:.75rem;color:#f59e0b'; ts.id='diag-ts'; ts.textContent='running @ '+new Date().toLocaleTimeString(); diagEl.appendChild(ts); }
  ['ping','stats','analytics','revenue','users'].forEach(function(id){
    var el=document.getElementById('diag-'+id);
    if(el){el.textContent=id+'…';el.style.background='#1e293b';el.style.color='#94a3b8';el.style.border='none';}
  });
  // ping
  try{
    var r=await fetch('/api/admin/ping',{credentials:'include'});
    var d=await r.json();
    if(!d.ok) diagSet('ping',false,'ok=false admin='+d.admin+' email='+d.email);
    else if(!d.admin) diagSet('ping',false,'NOT ADMIN — email='+d.email+' plan='+d.plan);
    else diagSet('ping',true,'admin=true email='+d.email);
  }catch(e){ diagSet('ping',false,String(e.message||e)); }
  // stats
  try{
    var r2=await fetch('/api/admin/stats',{credentials:'include'});
    if(!r2.ok){ var t=await r2.text(); diagSet('stats',false,'HTTP '+r2.status+' '+t.slice(0,60)); }
    else{ var d2=await r2.json(); if(d2.error) diagSet('stats',false,d2.error); else diagSet('stats',true,'users='+d2.users.total); }
  }catch(e){ diagSet('stats',false,String(e.message||e)); }
  // analytics
  try{
    var r3=await fetch('/api/admin/analytics',{credentials:'include'});
    if(!r3.ok){ var t3=await r3.text(); diagSet('analytics',false,'HTTP '+r3.status+' '+t3.slice(0,60)); }
    else{ var d3=await r3.json(); if(d3.error) diagSet('analytics',false,d3.error); else diagSet('analytics',true,'today='+d3.today+' month='+d3.month); }
  }catch(e){ diagSet('analytics',false,String(e.message||e)); }
  // revenue
  try{
    var r4=await fetch('/api/admin/revenue',{credentials:'include'});
    if(!r4.ok){ var t4=await r4.text(); diagSet('revenue',false,'HTTP '+r4.status+' '+t4.slice(0,60)); }
    else{ var d4=await r4.json(); if(d4.error) diagSet('revenue',false,d4.error); else diagSet('revenue',true,'mrr=$'+d4.mrr); }
  }catch(e){ diagSet('revenue',false,String(e.message||e)); }
  // users
  try{
    var r5=await fetch('/api/admin/users',{credentials:'include'});
    if(!r5.ok){ var t5=await r5.text(); diagSet('users',false,'HTTP '+r5.status+' '+t5.slice(0,60)); }
    else{ var d5=await r5.json(); if(d5.error) diagSet('users',false,d5.error); else diagSet('users',true,'count='+d5.users.length); }
  }catch(e){ diagSet('users',false,String(e.message||e)); }
}
runDiag();

// ── Stats bar ────────────────────────────────────────────────
(function loadAdminStats(){
  var errEl=document.getElementById('admin-stats-err');
  function showErr(msg){
    if(errEl){ errEl.innerHTML='<b>⚠️ Stats error:</b> '+msg; errEl.style.display='block'; }
    ['stat-users','stat-pro','stat-creator','stat-jobs'].forEach(function(id){ var el=document.getElementById(id); if(el) el.textContent='ERR'; });
  }
  var ctrl=new AbortController(), tid=setTimeout(function(){ ctrl.abort(); showErr('Timed out after 8s'); },8000);
  fetch('/api/admin/stats',{signal:ctrl.signal,credentials:'include'})
    .then(function(res){ clearTimeout(tid); if(!res.ok) return res.text().then(function(t){ throw new Error('HTTP '+res.status+': '+t.slice(0,120)); }); return res.json(); })
    .then(function(data){
      if(data.error) throw new Error(data.error);
      var u=document.getElementById('stat-users'),p=document.getElementById('stat-pro'),cr=document.getElementById('stat-creator');
      if(u)u.textContent=String(data.users?.total||0);
      if(p)p.textContent=String(data.users?.pro_count||0);
      if(cr)cr.textContent=String(data.users?.creator_count||0);
      var j=document.getElementById('stat-jobs'); if(j)j.textContent=String(data.jobs?.total||0);
      if(errEl) errEl.style.display='none';
    })
    .catch(function(e){ showErr(String(e.message||e)); });
})();

var adminTabs=['analytics','revenue','users'];
function adminTab(tab){
  document.querySelectorAll('.admin-tab[data-tab]').forEach(function(t){ t.classList.remove('admin-tab--active'); });
  var btn=document.querySelector('[data-tab="'+tab+'"]'); if(btn) btn.classList.add('admin-tab--active');
  adminTabs.forEach(function(t){ var el=document.getElementById('admin-tab-'+t); if(el) el.style.display=t===tab?'block':'none'; });
  if(tab==='analytics'&&!window._analyticsLoaded){ loadAnalytics(); window._analyticsLoaded=true; }
  if(tab==='revenue'&&!window._revenueLoaded){ loadRevenue(); window._revenueLoaded=true; }
  if(tab==='users'&&!window._usersLoaded){ loadUsers(); window._usersLoaded=true; }
}
loadAnalytics(); window._analyticsLoaded=true;

var SOCIAL_ICONS={tiktok:'<i class="fab fa-tiktok" style="color:#69C9D0"></i>',facebook:'<i class="fab fa-facebook" style="color:#1877F2"></i>',instagram:'<i class="fab fa-instagram" style="color:#E1306C"></i>',youtube:'<i class="fab fa-youtube" style="color:#FF0000"></i>',twitter:'<i class="fab fa-twitter" style="color:#1DA1F2"></i>',snapchat:'<i class="fab fa-snapchat" style="color:#FFFC00"></i>',pinterest:'<i class="fab fa-pinterest" style="color:#E60023"></i>',reddit:'<i class="fab fa-reddit" style="color:#FF4500"></i>',linkedin:'<i class="fab fa-linkedin" style="color:#0A66C2"></i>',google:'<i class="fab fa-google" style="color:#4285F4"></i>',bing:'<i class="fas fa-search" style="color:#008373"></i>',direct:'<i class="fas fa-link" style="color:var(--primary)"></i>',referral:'<i class="fas fa-external-link-alt" style="color:var(--muted)"></i>'};

async function loadAnalytics(){
  var errHtml=function(msg){ return '<p style="color:#fca5a5;font-size:.82rem;padding:8px;background:rgba(239,68,68,.1);border-radius:6px;border:1px solid rgba(239,68,68,.3)"><b>❌ Error:</b> '+msg+'</p>'; };
  try{
    var ctrl=new AbortController(),tid=setTimeout(function(){ctrl.abort();},10000);
    var res=await fetch('/api/admin/analytics',{signal:ctrl.signal,credentials:'include'});
    clearTimeout(tid);
    if(!res.ok){ var errTxt=await res.text(); throw new Error('HTTP '+res.status+': '+errTxt.slice(0,120)); }
    var d=await res.json(); if(d.error) throw new Error(d.error);
    document.getElementById('an-today').textContent=d.today||0;
    document.getElementById('an-week').textContent=d.week||0;
    document.getElementById('an-month').textContent=d.month||0;
    var daily=d.daily||[],maxV=Math.max.apply(null,daily.map(function(r){return r.cnt;}).concat([1])),chartEl=document.getElementById('daily-chart');
    if(!daily.length){ chartEl.innerHTML='<p style="color:var(--muted);font-size:.82rem;text-align:center;width:100%">No data yet</p>'; }
    else { chartEl.innerHTML=daily.map(function(r){ var h=Math.round((r.cnt/maxV)*100),lbl=new Date(r.day_bucket*86400000).toLocaleDateString('en-US',{month:'short',day:'numeric'}); return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0" title="'+lbl+': '+r.cnt+' views"><div style="width:100%;background:var(--primary);border-radius:3px 3px 0 0;height:'+h+'%;opacity:.85;min-height:2px"></div><div style="font-size:.55rem;color:var(--muted);writing-mode:vertical-lr;transform:rotate(180deg);max-height:36px;overflow:hidden">'+lbl+'</div></div>'; }).join(''); }
    var sources=d.sources||[],totalSrc=sources.reduce(function(a,s){return a+s.cnt;},0)||1,srcEl=document.getElementById('sources-chart');
    if(!sources.length){ srcEl.innerHTML='<p style="color:var(--muted);font-size:.82rem">No traffic data yet</p>'; }
    else { srcEl.innerHTML=sources.map(function(s){ var pct=Math.round((s.cnt/totalSrc)*100),icon=SOCIAL_ICONS[s.source||'direct']||SOCIAL_ICONS.referral,name=s.source||'direct'; return '<div class="rv-bar-wrap" style="margin-bottom:10px"><div style="width:22px;text-align:center">'+icon+'</div><div style="width:80px;font-size:.82rem;text-transform:capitalize;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+name+'</div><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:var(--primary)"></div></div><div style="width:36px;text-align:right;font-size:.82rem;font-weight:700">'+s.cnt+'</div><div style="width:34px;text-align:right;font-size:.75rem;color:var(--muted)">'+pct+'%</div></div>'; }).join(''); }
    var socialKeys=['tiktok','facebook','instagram','youtube','twitter','snapchat','pinterest','reddit','linkedin'],srcMap={};
    (d.sources||[]).forEach(function(s){srcMap[s.source]=s.cnt;});
    document.getElementById('social-breakdown').innerHTML=socialKeys.map(function(k){ var cnt=srcMap[k]||0; return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-size:1.4rem;margin-bottom:6px">'+(SOCIAL_ICONS[k]||'')+'</div><div style="font-size:1.1rem;font-weight:700">'+cnt+'</div><div style="font-size:.72rem;color:var(--muted);text-transform:capitalize;margin-top:2px">'+k+'</div></div>'; }).join('');
    var pages=d.top_pages||[],pgEl=document.getElementById('top-pages');
    if(!pages.length){ pgEl.innerHTML='<p style="color:var(--muted);font-size:.82rem">No data yet</p>'; }
    else { var maxPg=Math.max.apply(null,pages.map(function(p){return p.cnt;}).concat([1])); pgEl.innerHTML='<table class="admin-table"><thead><tr><th>Page</th><th>Views</th><th style="width:200px">Share</th></tr></thead><tbody>'+pages.map(function(p){ var pct=Math.round((p.cnt/maxPg)*100); return '<tr><td><code style="font-size:.85rem">'+p.path+'</code></td><td style="font-weight:700">'+p.cnt+'</td><td><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:#a78bfa"></div></div></td></tr>'; }).join('')+'</tbody></table>'; }
  }catch(e){
    var msg=String(e.message||e);
    var eh=errHtml(msg);
    var dc=document.getElementById('daily-chart'); if(dc) dc.innerHTML=eh;
    var sc=document.getElementById('sources-chart'); if(sc) sc.innerHTML=eh;
    var sb=document.getElementById('social-breakdown'); if(sb) sb.innerHTML='<div style="grid-column:1/-1">'+eh+'</div>';
    var tp=document.getElementById('top-pages'); if(tp) tp.innerHTML=eh;
    document.getElementById('an-today').textContent='ERR';
    document.getElementById('an-week').textContent='ERR';
    document.getElementById('an-month').textContent='ERR';
  }
}

async function loadRevenue(){
  try{
    var res=await fetch('/api/admin/revenue',{credentials:'include'});
    if(!res.ok) throw new Error('HTTP '+res.status);
    var d=await res.json(); if(d.error) throw new Error(d.error);
    var mrr=d.mrr||0;
    document.getElementById('rv-mrr').textContent='$'+mrr.toLocaleString();
    document.getElementById('rv-pro').textContent=d.pro_count||0;
    document.getElementById('rv-creator').textContent=d.creator_count||0;
    document.getElementById('rv-free').textContent=d.free_count||0;
    document.getElementById('stat-mrr').textContent='$'+mrr;
    document.getElementById('rv-pl-mrr').textContent='$'+mrr.toLocaleString();
    document.getElementById('rv-pl-credits').textContent=d.credit_pack_revenue?'$'+parseFloat(d.credit_pack_revenue).toFixed(2):'$0';
    document.getElementById('rv-pl-musicapi').textContent='-$'+(d.estimated_musicapi_cost||0).toFixed(2)+' ('+(d.jobs_this_month||0)+' jobs)';
    var profit=d.estimated_profit||0,profitEl=document.getElementById('rv-pl-profit');
    profitEl.textContent=(profit>=0?'+':'')+'$'+profit.toFixed(2); profitEl.style.color=profit>=0?'#10b981':'#ef4444';
    var total=mrr+(d.credit_pack_revenue||0),pieEl=document.getElementById('rv-pie');
    if(!total){ pieEl.innerHTML='<p style="color:var(--muted);font-size:.85rem">No revenue yet</p>'; }
    else { var rows=[{label:'Pro Artist ('+(d.pro_count||0)+'x$26)',val:(d.pro_count||0)*26,color:'#a78bfa'},{label:'Creator ('+(d.creator_count||0)+'x$10)',val:(d.creator_count||0)*10,color:'#3b82f6'},{label:'Credit Packs',val:d.credit_pack_revenue||0,color:'#f59e0b'}]; pieEl.innerHTML=rows.map(function(r){ var pct=total>0?Math.round((r.val/total)*100):0; return '<div class="rv-bar-wrap" style="margin-bottom:12px"><div style="width:12px;height:12px;border-radius:3px;background:'+r.color+';flex-shrink:0"></div><div style="flex:1;font-size:.85rem">'+r.label+'</div><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:'+r.color+'"></div></div><div style="width:52px;text-align:right;font-size:.85rem;font-weight:700">$'+r.val+'</div></div>'; }).join(''); }
    var subs=d.recent_subscribers||[],subsEl=document.getElementById('rv-subs');
    if(!subs.length){ subsEl.innerHTML='<p style="color:var(--muted);font-size:.85rem">No paid subscribers yet.</p>'; }
    else { subsEl.innerHTML='<table class="admin-table"><thead><tr><th>Email</th><th>Name</th><th>Plan</th><th>Joined</th></tr></thead><tbody>'+subs.map(function(s){ return '<tr><td>'+s.email+'</td><td>'+s.name+'</td><td><span class="plan-badge plan-badge--'+s.plan+'">'+s.plan+'</span></td><td>'+new Date(s.created_at).toLocaleDateString()+'</td></tr>'; }).join('')+'</tbody></table>'; }
  }catch(e){
    var msg=String(e.message||e);
    var eh='<p style="color:#fca5a5;font-size:.82rem;padding:8px;background:rgba(239,68,68,.1);border-radius:6px;border:1px solid rgba(239,68,68,.3)"><b>❌ Error:</b> '+msg+'</p>';
    document.getElementById('rv-mrr').textContent='ERR';
    var pie=document.getElementById('rv-pie'); if(pie) pie.innerHTML=eh;
    var subs=document.getElementById('rv-subs'); if(subs) subs.innerHTML=eh;
  }
}

async function loadUsers(){
  var el=document.getElementById('admin-users-list');
  try{
    var ctrl=new AbortController(),tid=setTimeout(function(){ctrl.abort();},10000);
    var res=await fetch('/api/admin/users',{signal:ctrl.signal,credentials:'include'});
    clearTimeout(tid);
    var data=await res.json();
    if(data.error){ el.innerHTML='<p style="color:#ef4444">Error: '+data.error+'</p>'; return; }
    if(!data.users||!data.users.length){ el.innerHTML='<p style="color:var(--muted)">No users yet.</p>'; return; }
    el.innerHTML='<table class="admin-table"><thead><tr><th>Email</th><th>Name</th><th>Plan</th><th>Status</th><th>Points</th><th>Extra</th><th>Actions</th></tr></thead><tbody>'+
      data.users.map(function(u){
        var rem=Math.max(0,u.gens_limit-u.gens_used),remColor=rem===0?'#ef4444':rem<=10?'#f59e0b':'#10b981',bonus=u.bonus_credits||0,isLocked=u.account_locked===1;
        var lockBadge=isLocked?'<span style="background:#7f1d1d;color:#fca5a5;font-size:.65rem;padding:2px 7px;border-radius:999px;font-weight:700;border:1px solid rgba(239,68,68,.3)">LOCKED</span>':'<span style="color:#10b981;font-size:.75rem">Active</span>';
        return '<tr style="'+(isLocked?'background:rgba(239,68,68,.04)':'')+'"><td>'+u.email+'</td><td>'+u.name+'</td><td><span class="plan-badge plan-badge--'+u.plan+'">'+u.plan+'</span></td><td>'+lockBadge+'</td><td style="font-weight:700;color:'+remColor+'">'+rem+' <small style="font-weight:400;color:var(--muted)">/ '+u.gens_limit+'</small></td><td style="font-weight:700;color:'+(bonus>0?'#a78bfa':'var(--muted)')+'>'+(bonus>0?'+'+bonus:'—')+'</td><td style="display:flex;gap:5px;flex-wrap:wrap;align-items:center"><button onclick="changeUserPlan(\''+u.id+'\',\''+u.email+'\')" class="btn btn--outline btn--sm" style="font-size:.75rem">Edit Plan</button><button onclick="addCredits(\''+u.id+'\',\''+u.email+'\')" class="btn btn--outline btn--sm" style="font-size:.75rem">+Credits</button><button onclick="toggleLockUser(\''+u.id+'\',\''+u.email+'\','+(isLocked?1:0)+')" class="btn btn--sm" style="font-size:.75rem;background:'+(isLocked?'rgba(16,185,129,.15)':'rgba(239,68,68,.15)')+';border:1px solid '+(isLocked?'rgba(16,185,129,.3)':'rgba(239,68,68,.3)')+';color:'+(isLocked?'#10b981':'#ef4444')+'">'+(isLocked?'Unlock':'Lock')+'</button><button onclick="deleteUserAccount(\''+u.id+'\',\''+u.email+'\')" class="btn btn--sm" style="font-size:.75rem;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#ef4444"><i class="fas fa-trash"></i> Delete</button></td></tr>';
      }).join('')+'</tbody></table>';
    window._usersLoaded=true;
  }catch(e){ if(el) el.innerHTML='<p style="color:#ef4444"><i class="fas fa-exclamation-circle"></i> Failed to load users: '+(e.message||'timeout')+'</p>'; }
}

async function toggleLockUser(userId,email,currentlyLocked){
  var lock=!currentlyLocked,reason='';
  if(lock){ reason=prompt('Reason for locking "'+email+'" (shown to user):','Multiple accounts detected. Only one free account per household.'); if(reason===null)return; }
  else { if(!confirm('Unlock account for "'+email+'"?'))return; }
  var res=await fetch('/api/admin/user/lock',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({user_id:userId,locked:lock,reason:reason})});
  var data=await res.json(); if(data.ok){ window._usersLoaded=false; loadUsers(); } else { alert('Error: '+(data.error||'Failed')); }
}

async function deleteUserAccount(userId,email){
  if(!confirm('Delete account for "'+email+'"? This cannot be undone.')) return;
  if(!confirm('Are you absolutely sure? Permanent.')) return;
  var res=await fetch('/api/admin/user/'+userId,{method:'DELETE',credentials:'include'});
  var data=await res.json(); if(data.ok){ window._usersLoaded=false; loadUsers(); alert('Account deleted.'); } else { alert('Error: '+(data.error||'Failed')); }
}

function changeUserPlan(userId,email){
  document.getElementById('umod-title').textContent='Edit Plan — '+email;
  document.getElementById('umod-plan-section').style.display='';
  document.getElementById('umod-credits-section').style.display='none';
  document.getElementById('umod-user-id').value=userId;
  document.getElementById('umod-overlay').style.display='flex';
  document.getElementById('umod-plan').focus();
}

function addCredits(userId,email){
  document.getElementById('umod-title').textContent='+Credits — '+email;
  document.getElementById('umod-plan-section').style.display='none';
  document.getElementById('umod-credits-section').style.display='';
  document.getElementById('umod-user-id').value=userId;
  document.getElementById('umod-amount').value='';
  document.getElementById('umod-overlay').style.display='flex';
  document.getElementById('umod-amount').focus();
}

function umodClose(){ document.getElementById('umod-overlay').style.display='none'; document.getElementById('umod-status').textContent=''; }

async function umodSave(){
  var userId=document.getElementById('umod-user-id').value,isPlan=document.getElementById('umod-plan-section').style.display!=='none',statusEl=document.getElementById('umod-status');
  statusEl.style.color='var(--muted)'; statusEl.textContent='Saving…';
  if(isPlan){
    var plan=document.getElementById('umod-plan').value.trim().toLowerCase();
    if(!['free','creator','pro','developer'].includes(plan)){ statusEl.style.color='#ef4444'; statusEl.textContent='Invalid plan name.'; return; }
    var res=await fetch('/api/admin/user/update',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({user_id:userId,plan:plan})});
    var data=await res.json(); if(data.ok){ statusEl.style.color='#10b981'; statusEl.textContent='Plan updated'; window._usersLoaded=false; loadUsers(); setTimeout(umodClose,1000); } else { statusEl.style.color='#ef4444'; statusEl.textContent='Error: '+(data.error||'Failed'); }
  } else {
    var amt=parseInt(document.getElementById('umod-amount').value);
    if(!amt||isNaN(amt)||amt<=0){ statusEl.style.color='#ef4444'; statusEl.textContent='Enter a positive number.'; return; }
    var res2=await fetch('/api/admin/user/add-credits',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({user_id:userId,amount:amt})});
    var data2=await res2.json(); if(data2.ok){ statusEl.style.color='#10b981'; statusEl.textContent='Added '+amt+' pts, new limit: '+data2.gens_limit; window._usersLoaded=false; loadUsers(); setTimeout(umodClose,1800); } else { statusEl.style.color='#ef4444'; statusEl.textContent='Error: '+(data2.error||'Failed'); }
  }
}
