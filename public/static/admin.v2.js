/* StemForge Admin Panel JS v2 — 2026-09-27 — country column in users + flag inline in countries chart */

// ── Shared lookup: ISO 3166-1 alpha-2 → country name ─────────
var COUNTRY_NAMES={AF:'Afghanistan',AL:'Albania',DZ:'Algeria',AD:'Andorra',AO:'Angola',AG:'Antigua & Barbuda',AR:'Argentina',AM:'Armenia',AU:'Australia',AT:'Austria',AZ:'Azerbaijan',BS:'Bahamas',BH:'Bahrain',BD:'Bangladesh',BB:'Barbados',BY:'Belarus',BE:'Belgium',BZ:'Belize',BJ:'Benin',BT:'Bhutan',BO:'Bolivia',BA:'Bosnia & Herzegovina',BW:'Botswana',BR:'Brazil',BN:'Brunei',BG:'Bulgaria',BF:'Burkina Faso',BI:'Burundi',CV:'Cabo Verde',KH:'Cambodia',CM:'Cameroon',CA:'Canada',CF:'Central African Republic',TD:'Chad',CL:'Chile',CN:'China',CO:'Colombia',KM:'Comoros',CG:'Congo',CD:'DR Congo',CR:'Costa Rica',HR:'Croatia',CU:'Cuba',CY:'Cyprus',CZ:'Czech Republic',DK:'Denmark',DJ:'Djibouti',DM:'Dominica',DO:'Dominican Republic',EC:'Ecuador',EG:'Egypt',SV:'El Salvador',GQ:'Equatorial Guinea',ER:'Eritrea',EE:'Estonia',SZ:'Eswatini',ET:'Ethiopia',FJ:'Fiji',FI:'Finland',FR:'France',GA:'Gabon',GM:'Gambia',GE:'Georgia',DE:'Germany',GH:'Ghana',GR:'Greece',GD:'Grenada',GT:'Guatemala',GN:'Guinea',GW:'Guinea-Bissau',GY:'Guyana',HT:'Haiti',HN:'Honduras',HU:'Hungary',IS:'Iceland',IN:'India',ID:'Indonesia',IR:'Iran',IQ:'Iraq',IE:'Ireland',IL:'Israel',IT:'Italy',JM:'Jamaica',JP:'Japan',JO:'Jordan',KZ:'Kazakhstan',KE:'Kenya',KI:'Kiribati',KW:'Kuwait',KG:'Kyrgyzstan',LA:'Laos',LV:'Latvia',LB:'Lebanon',LS:'Lesotho',LR:'Liberia',LY:'Libya',LI:'Liechtenstein',LT:'Lithuania',LU:'Luxembourg',MG:'Madagascar',MW:'Malawi',MY:'Malaysia',MV:'Maldives',ML:'Mali',MT:'Malta',MH:'Marshall Islands',MR:'Mauritania',MU:'Mauritius',MX:'Mexico',FM:'Micronesia',MD:'Moldova',MC:'Monaco',MN:'Mongolia',ME:'Montenegro',MA:'Morocco',MZ:'Mozambique',MM:'Myanmar',NA:'Namibia',NR:'Nauru',NP:'Nepal',NL:'Netherlands',NZ:'New Zealand',NI:'Nicaragua',NE:'Niger',NG:'Nigeria',MK:'North Macedonia',NO:'Norway',OM:'Oman',PK:'Pakistan',PW:'Palau',PA:'Panama',PG:'Papua New Guinea',PY:'Paraguay',PE:'Peru',PH:'Philippines',PL:'Poland',PT:'Portugal',QA:'Qatar',RO:'Romania',RU:'Russia',RW:'Rwanda',KN:'Saint Kitts & Nevis',LC:'Saint Lucia',VC:'Saint Vincent',WS:'Samoa',SM:'San Marino',ST:'São Tomé & Príncipe',SA:'Saudi Arabia',SN:'Senegal',RS:'Serbia',SC:'Seychelles',SL:'Sierra Leone',SG:'Singapore',SK:'Slovakia',SI:'Slovenia',SB:'Solomon Islands',SO:'Somalia',ZA:'South Africa',SS:'South Sudan',ES:'Spain',LK:'Sri Lanka',SD:'Sudan',SR:'Suriname',SE:'Sweden',CH:'Switzerland',SY:'Syria',TW:'Taiwan',TJ:'Tajikistan',TZ:'Tanzania',TH:'Thailand',TL:'Timor-Leste',TG:'Togo',TO:'Tonga',TT:'Trinidad & Tobago',TN:'Tunisia',TR:'Turkey',TM:'Turkmenistan',TV:'Tuvalu',UG:'Uganda',UA:'Ukraine',AE:'UAE',GB:'United Kingdom',US:'United States',UY:'Uruguay',UZ:'Uzbekistan',VU:'Vanuatu',VE:'Venezuela',VN:'Vietnam',YE:'Yemen',ZM:'Zambia',ZW:'Zimbabwe',T1:'Tor/VPN',XX:'Unknown'};

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

var adminTabs=['analytics','revenue','users','signups','stuckjobs','broadcasts','security'];
function adminTab(tab){
  document.querySelectorAll('.admin-tab[data-tab]').forEach(function(t){ t.classList.remove('admin-tab--active'); });
  var btn=document.querySelector('[data-tab="'+tab+'"]'); if(btn) btn.classList.add('admin-tab--active');
  adminTabs.forEach(function(t){ var el=document.getElementById('admin-tab-'+t); if(el) el.style.display=t===tab?'block':'none'; });
  if(tab==='analytics'&&!window._analyticsLoaded){ loadAnalytics(); window._analyticsLoaded=true; }
  if(tab==='revenue'&&!window._revenueLoaded){ loadRevenue(); window._revenueLoaded=true; }
  if(tab==='users'&&!window._usersLoaded){ loadUsers(); window._usersLoaded=true; }
  if(tab==='signups'&&!window._signupsLoaded){ loadSignupClicks(); window._signupsLoaded=true; }
  if(tab==='stuckjobs'){ loadStuckJobs(); }
  if(tab==='broadcasts'&&!window._broadcastsLoaded){ loadBroadcastStats(); bcLoadTemplates(); bcLoadHistory(); window._broadcastsLoaded=true; }
  // Persist active tab in URL hash so hard refresh restores it
  try { history.replaceState(null, '', '#tab-' + tab); } catch(e) {}
}
// Restore tab from hash on page load
(function(){
  var hash = window.location.hash || '';
  var match = hash.match(/^#tab-(.+)$/);
  var startTab = match ? match[1] : 'analytics';
  var validTabs = ['analytics','revenue','users','signups','stuckjobs','broadcasts','promos','email'];
  if (validTabs.indexOf(startTab) === -1) startTab = 'analytics';
  if (startTab !== 'analytics') {
    adminTab(startTab);
  } else {
    loadAnalytics(); window._analyticsLoaded=true;
  }
})();

var SOCIAL_ICONS={tiktok:'<i class="fab fa-tiktok" style="color:#69C9D0"></i>',facebook:'<i class="fab fa-facebook" style="color:#1877F2"></i>',instagram:'<i class="fab fa-instagram" style="color:#E1306C"></i>',youtube:'<i class="fab fa-youtube" style="color:#FF0000"></i>',twitter:'<i class="fab fa-twitter" style="color:#1DA1F2"></i>',snapchat:'<i class="fab fa-snapchat" style="color:#FFFC00"></i>',pinterest:'<i class="fab fa-pinterest" style="color:#E60023"></i>',reddit:'<i class="fab fa-reddit" style="color:#FF4500"></i>',linkedin:'<i class="fab fa-linkedin" style="color:#0A66C2"></i>',google:'<i class="fab fa-google" style="color:#4285F4"></i>','google-organic':'<i class="fab fa-google" style="color:#4285F4"></i>',bing:'<i class="fas fa-search" style="color:#008373"></i>',direct:'<i class="fas fa-mouse-pointer" style="color:#a78bfa"></i>',referral:'<i class="fas fa-external-link-alt" style="color:var(--muted)"></i>'};
var SOURCE_LABELS={'google-organic':'Google','direct':'Direct','tiktok':'TikTok','facebook':'Facebook','instagram':'Instagram','youtube':'YouTube','twitter':'Twitter','snapchat':'Snapchat','pinterest':'Pinterest','reddit':'Reddit','linkedin':'LinkedIn','google':'Google','bing':'Bing','referral':'Referral'};

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
    // Busy errors stat
    var busyEl=document.getElementById('an-busy-30d');
    var busyTodayEl=document.getElementById('an-busy-today');
    if(busyEl){
      var b30=d.busy_errors_30d||0;
      busyEl.textContent=b30;
      busyEl.style.color=b30>0?'#f59e0b':'';
    }
    if(busyTodayEl){
      var bToday=d.busy_errors_today||0;
      busyTodayEl.textContent='today: '+bToday;
      busyTodayEl.style.color=bToday>0?'#fbbf24':'';
      busyTodayEl.style.display='block';
      // Show breakdown by type if data exists
      var byType=d.busy_errors_by_type||[];
      if(byType.length>1){
        var parts=byType.map(function(t){ return t.error_type.replace('_busy','').replace('musicapi','MusicAPI').replace('mureka','Mureka')+': '+t.cnt; });
        busyTodayEl.textContent='today: '+bToday+' ('+parts.join(', ')+')';
      }
    }
    var daily=d.daily||[],chartEl=document.getElementById('daily-chart');
    if(!daily.length){ chartEl.innerHTML='<p style="color:var(--muted);font-size:.82rem;text-align:center;width:100%">No data yet</p>'; }
    else {
      // ── Professional SVG area line chart ──────────────────────
      var W=chartEl.offsetWidth||560, H=160, PAD={top:12,right:16,bottom:40,left:36};
      var cW=W-PAD.left-PAD.right, cH=H-PAD.top-PAD.bottom;
      var vals=daily.map(function(r){return r.cnt||0;});
      var maxV=Math.max.apply(null,vals.concat([1]));
      var minV=0;
      // X positions
      var xStep=cW/(daily.length-1||1);
      var pts=daily.map(function(r,i){
        var x=PAD.left+i*xStep;
        var y=PAD.top+cH-Math.round(((r.cnt-minV)/(maxV-minV))*cH);
        return {x:x,y:y,cnt:r.cnt,lbl:new Date(r.day_bucket*86400000).toLocaleDateString('en-US',{month:'short',day:'numeric'})};
      });
      // Build smooth polyline points
      var linePoints=pts.map(function(p){return p.x+','+p.y;}).join(' ');
      // Area fill polygon (line + bottom edge)
      var areaPoints=linePoints+' '+pts[pts.length-1].x+','+(PAD.top+cH)+' '+pts[0].x+','+(PAD.top+cH);
      // Y axis grid lines & labels (4 levels)
      var gridLines='';
      for(var gi=0;gi<=4;gi++){
        var gy=PAD.top+cH-Math.round((gi/4)*cH);
        var gv=Math.round((gi/4)*maxV);
        gridLines+='<line x1="'+PAD.left+'" y1="'+gy+'" x2="'+(W-PAD.right)+'" y2="'+gy+'" stroke="rgba(255,255,255,.06)" stroke-width="1"/>';
        gridLines+='<text x="'+(PAD.left-6)+'" y="'+(gy+4)+'" text-anchor="end" fill="rgba(148,163,184,.6)" font-size="10">'+gv+'</text>';
      }
      // X axis labels — show every Nth label to avoid overlap
      var labelEvery=Math.ceil(daily.length/8);
      var xLabels=pts.map(function(p,i){
        if(i%labelEvery!==0 && i!==daily.length-1) return '';
        return '<text x="'+p.x+'" y="'+(H-6)+'" text-anchor="middle" fill="rgba(148,163,184,.7)" font-size="10">'+p.lbl+'</text>';
      }).join('');
      // Tooltip dots (invisible, revealed on hover via title)
      var dots=pts.map(function(p){
        return '<circle cx="'+p.x+'" cy="'+p.y+'" r="4" fill="#4e9fff" stroke="#0f172a" stroke-width="2" opacity="0" style="cursor:pointer" onmouseenter="this.setAttribute(\'opacity\',\'1\');document.getElementById(\'chart-tip\').style.display=\'block\';document.getElementById(\'chart-tip\').style.left=\''+'\'+(this.cx.baseVal.value+8)+\'px\';document.getElementById(\'chart-tip\').textContent=\''+p.lbl+': '+p.cnt+' views\';" onmouseleave="this.setAttribute(\'opacity\',\'0\');document.getElementById(\'chart-tip\').style.display=\'none\'"><title>'+p.lbl+': '+p.cnt+' views</title></circle>';
      }).join('');
      chartEl.style.height='auto';
      chartEl.style.display='block';
      chartEl.style.position='relative';
      chartEl.innerHTML=
        '<div id="chart-tip" style="display:none;position:absolute;background:#1e293b;border:1px solid #334155;color:#e2e8f0;font-size:.75rem;padding:4px 10px;border-radius:6px;pointer-events:none;white-space:nowrap;z-index:10"></div>'+
        '<svg width="100%" viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block">'+
          '<defs>'+
            '<linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">'+
              '<stop offset="0%" stop-color="#4e9fff" stop-opacity="0.25"/>'+
              '<stop offset="100%" stop-color="#4e9fff" stop-opacity="0.02"/>'+
            '</linearGradient>'+
          '</defs>'+
          gridLines+
          '<polygon points="'+areaPoints+'" fill="url(#areaGrad)"/>'+
          '<polyline points="'+linePoints+'" fill="none" stroke="#4e9fff" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>'+
          dots+
          xLabels+
        '</svg>';
    }
    var sources=d.sources||[],totalSrc=sources.reduce(function(a,s){return a+s.cnt;},0)||1,srcEl=document.getElementById('sources-chart');
    if(!sources.length){ srcEl.innerHTML='<p style="color:var(--muted);font-size:.82rem">No traffic data yet</p>'; }
    else { srcEl.innerHTML=sources.map(function(s){ var pct=Math.round((s.cnt/totalSrc)*100),icon=SOCIAL_ICONS[s.source||'direct']||SOCIAL_ICONS.referral,label=SOURCE_LABELS[s.source||'direct']||(s.source||'direct'); return '<div class="rv-bar-wrap" style="margin-bottom:10px"><div style="width:22px;text-align:center">'+icon+'</div><div style="width:80px;font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+label+'</div><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:var(--primary)"></div></div><div style="width:36px;text-align:right;font-size:.82rem;font-weight:700">'+s.cnt+'</div><div style="width:34px;text-align:right;font-size:.75rem;color:var(--muted)">'+pct+'%</div></div>'; }).join(''); }
    var socialKeys=['tiktok','facebook','instagram','youtube','twitter','snapchat','pinterest','reddit','linkedin'],srcMap={};
    (d.sources||[]).forEach(function(s){srcMap[s.source]=s.cnt;});
    document.getElementById('social-breakdown').innerHTML=socialKeys.map(function(k){ var cnt=srcMap[k]||0; return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center"><div style="font-size:1.4rem;margin-bottom:6px">'+(SOCIAL_ICONS[k]||'')+'</div><div style="font-size:1.1rem;font-weight:700">'+cnt+'</div><div style="font-size:.72rem;color:var(--muted);text-transform:capitalize;margin-top:2px">'+k+'</div></div>'; }).join('');
    var pages=d.top_pages||[],pgEl=document.getElementById('top-pages');
    if(!pages.length){ pgEl.innerHTML='<p style="color:var(--muted);font-size:.82rem">No data yet</p>'; }
    else { var maxPg=Math.max.apply(null,pages.map(function(p){return p.cnt;}).concat([1])); pgEl.innerHTML='<table class="admin-table"><thead><tr><th>Page</th><th>Views</th><th style="width:200px">Share</th></tr></thead><tbody>'+pages.map(function(p){ var pct=Math.round((p.cnt/maxPg)*100); return '<tr><td><code style="font-size:.85rem">'+p.path+'</code></td><td style="font-weight:700">'+p.cnt+'</td><td><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:#a78bfa"></div></div></td></tr>'; }).join('')+'</tbody></table>'; }
    // ── Countries chart ───────────────────────────────────────────
    var countries=d.countries||[],ccEl=document.getElementById('countries-chart');
    if(ccEl){
      if(!countries.length){ ccEl.innerHTML='<p style="color:var(--muted);font-size:.82rem">No country data yet — will populate on next page view</p>'; }
      else {
        var totalCC=countries.reduce(function(a,c){return a+(c.cnt||0);},0)||1;
        var maxCC=countries[0].cnt||1;
        ccEl.innerHTML='<table class="admin-table"><thead><tr><th>Country</th><th style="width:60px">Views</th><th style="width:220px">Share</th></tr></thead><tbody>'+
          countries.map(function(c){
            var flag=c.country && c.country.length===2 ? String.fromCodePoint(0x1F1E6+c.country.charCodeAt(0)-65)+String.fromCodePoint(0x1F1E6+c.country.charCodeAt(1)-65) : '🌐';
            var name=COUNTRY_NAMES[c.country]||c.country||'Unknown';
            var pct=Math.round((c.cnt/maxCC)*100);
            var share=((c.cnt/totalCC)*100).toFixed(1);
            return '<tr>'+
              '<td style="font-size:.88rem"><span style="font-size:1.2rem;margin-right:8px;vertical-align:middle">'+flag+'</span>'+name+'</td>'+
              '<td style="font-weight:700;text-align:right">'+c.cnt+'</td>'+
              '<td><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:#34d399"></div></div><span style="font-size:.72rem;color:var(--muted);margin-left:6px">'+share+'%</span></td></tr>';
          }).join('')+
        '</tbody></table>';
      }
    }
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
    var be=document.getElementById('an-busy-30d'); if(be) be.textContent='ERR';
    var ce=document.getElementById('countries-chart'); if(ce) ce.innerHTML=eh;
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

var _userSearchTimeout=null;
function initUserSearch(){
  var wrap=document.getElementById('admin-users-list');
  if(!wrap||document.getElementById('admin-user-search')) return;
  var bar='<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px">'+
    '<div style="position:relative;flex:1;max-width:360px">'+
      '<i class="fas fa-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:.85rem"></i>'+
      '<input id="admin-user-search" type="text" placeholder="Search by email or name…" '+
        'style="width:100%;padding:9px 12px 9px 32px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:.88rem;box-sizing:border-box"'+
        ' oninput="onUserSearch(this.value)"/>'+
    '</div>'+
    '<span id="admin-user-count" style="font-size:.82rem;color:var(--muted)"></span>'+
  '</div>'+
  '<div id="admin-users-table"></div>';
  wrap.innerHTML=bar;
}
function onUserSearch(q){
  clearTimeout(_userSearchTimeout);
  _userSearchTimeout=setTimeout(function(){ loadUsers(q); },320);
}

async function resendWelcomeEmail(email){
  if(!confirm('Send welcome email to '+email+'?')) return;
  try {
    var res=await fetch('/api/admin/resend-welcome',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email})});
    var data=await res.json();
    if(res.ok && data.ok){
      alert('✅ Welcome email sent to '+email);
      window._usersLoaded=false; loadUsers(); // refresh table so ✅ appears
    } else { alert('❌ Error: '+(data.error||'Unknown error')); }
  } catch(e){ alert('❌ Request failed: '+e.message); }
}

async function loadUsers(q){
  initUserSearch();
  var tableEl=document.getElementById('admin-users-table');
  var countEl=document.getElementById('admin-user-count');
  if(!tableEl) return;
  tableEl.innerHTML='<p style="color:var(--muted)"><i class="fas fa-spinner fa-spin"></i> Loading…</p>';
  try{
    var url='/api/admin/users'+(q?'?q='+encodeURIComponent(q):'');
    var ctrl=new AbortController(),tid=setTimeout(function(){ctrl.abort();},12000);
    var res=await fetch(url,{signal:ctrl.signal,credentials:'include'});
    clearTimeout(tid);
    var data=await res.json();
    if(data.error){ tableEl.innerHTML='<p style="color:#ef4444">Error: '+data.error+'</p>'; return; }
    if(!data.users||!data.users.length){ tableEl.innerHTML='<p style="color:var(--muted)">No users found.</p>'; return; }
    if(countEl) countEl.textContent=data.users.length+' user'+(data.users.length!==1?'s':'');
    tableEl.innerHTML='<div style="overflow-x:auto"><table class="admin-table"><thead><tr>'+
      '<th>Email / Name</th><th>Plan</th><th>Status</th>'+
      '<th>Points</th><th>Bonus</th>'+
      '<th>Source</th>'+
      '<th>Welcome</th>'+
      '<th>Signed Up</th><th>Renewal</th><th>Actions</th>'+
    '</tr></thead><tbody id="admin-users-tbody">'+
      data.users.map(function(u){
        var rem=Math.max(0,(u.gens_limit||0)-(u.gens_used||0));
        var remColor=rem===0?'#ef4444':rem<=(u.gens_limit*0.1)?'#f59e0b':'#10b981';
        var bonus=u.bonus_credits||0;
        var isLocked=u.account_locked===1;
        var lockBadge=isLocked
          ?'<span style="background:#7f1d1d;color:#fca5a5;font-size:.65rem;padding:2px 7px;border-radius:999px;font-weight:700;border:1px solid rgba(239,68,68,.3)">LOCKED</span>'
          :'<span style="color:#10b981;font-size:.75rem">Active</span>';
        var signupDate=u.created_at?new Date(u.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—';
        var hasSub=!!u.stripe_subscription_id;
        // Traffic source badge
        var srcRaw=u.signup_source||'';
        var srcRef=u.signup_referrer||'';
        var srcIcon=SOCIAL_ICONS[srcRaw]||SOCIAL_ICONS[srcRaw.split(':')[0]]||'';
        var srcLabel=SOURCE_LABELS[srcRaw]||(srcRaw.startsWith('referral:')?srcRaw.replace('referral:',''):srcRaw)||'—';
        var srcBadge=srcRaw
          ? (srcIcon?'<span title="'+srcRef.replace(/"/g,'&quot;')+'" style="display:inline-flex;align-items:center;gap:4px;font-size:.78rem;white-space:nowrap">'+srcIcon+' <span style="max-width:90px;overflow:hidden;text-overflow:ellipsis;display:inline-block">'+srcLabel+'</span></span>'
             : '<span title="'+srcRef.replace(/"/g,'&quot;')+'" style="font-size:.75rem;color:var(--muted)">'+srcLabel+'</span>')
          : '<span style="color:var(--muted);font-size:.75rem">—</span>';
        // Welcome email status cell
        var welcomeCell;
        if(u.welcome_sent_at){
          var wDate=new Date(u.welcome_sent_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
          var wTime=new Date(u.welcome_sent_at).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
          welcomeCell='<span title="Sent '+wDate+' at '+wTime+'" style="display:inline-flex;align-items:center;gap:4px;color:#10b981;font-size:.78rem;font-weight:600">'+
            '<i class="fas fa-check-circle"></i> '+wDate+'</span>';
        } else {
          welcomeCell='<button onclick="resendWelcomeEmail(\''+u.email+'\')" class="btn btn--sm" '+
            'style="font-size:.7rem;padding:3px 8px;background:rgba(78,159,255,.12);border:1px solid rgba(78,159,255,.3);color:#4e9fff" '+
            'title="Welcome email not sent — click to send now">'+
            '<i class="fas fa-paper-plane"></i> Send</button>';
        }
        var renewalCell;
        if(hasSub){
          renewalCell='<span id="renew-'+u.id+'" style="color:var(--muted);font-size:.78rem" data-user-id="'+u.id+'" data-loaded="0">Loading…</span>';
        } else if(u.plan==='free' && u.cycle_start){
          // Free plan — show next reset date (cycle_start + 30 days)
          var nextReset=new Date(u.cycle_start + 30*24*60*60*1000);
          var nextResetStr=nextReset.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
          var nowMs=Date.now();
          var daysLeft=Math.max(0,Math.ceil((nextReset.getTime()-nowMs)/(24*60*60*1000)));
          var badge=daysLeft<=3?'<span style="background:rgba(245,158,11,.15);color:#f59e0b;font-size:.65rem;padding:1px 6px;border-radius:999px;margin-left:4px">'+daysLeft+'d left</span>':'';
          renewalCell='<span style="color:#94a3b8;font-size:.78rem" title="Free plan resets every 30 days">'+nextResetStr+badge+'</span>';
        } else {
          renewalCell='<span style="color:var(--muted);font-size:.78rem">—</span>';
        }
        return '<tr data-uid="'+u.id+'" style="'+(isLocked?'background:rgba(239,68,68,.04)':'')+'">'+
          '<td><div style="font-weight:600;font-size:.85rem">'+u.email+'</div><div style="color:var(--muted);font-size:.78rem">'+u.name+'</div></td>'+
          '<td><span class="plan-badge plan-badge--'+u.plan+'">'+u.plan+'</span></td>'+
          '<td>'+lockBadge+'</td>'+
          '<td style="color:'+remColor+';font-weight:700">'+rem+'<small style="font-weight:400;color:var(--muted)"> / '+u.gens_limit+'</small></td>'+
          '<td style="color:'+(bonus>0?'#a78bfa':'var(--muted)')+';font-weight:700">'+(bonus>0?'+'+bonus:'—')+'</td>'+
          '<td>'+srcBadge+'</td>'+
          '<td style="white-space:nowrap">'+welcomeCell+'</td>'+
          '<td style="font-size:.78rem;color:var(--muted)">'+signupDate+'</td>'+
          '<td style="font-size:.78rem">'+renewalCell+'</td>'+
          '<td><div style="display:flex;gap:4px;flex-wrap:wrap">'+
            '<button onclick="changeUserPlan(\''+u.id+'\',\''+u.email+'\')" class="btn btn--outline btn--sm" style="font-size:.72rem;padding:4px 8px">Plan</button>'+
            '<button onclick="addCredits(\''+u.id+'\',\''+u.email+'\')" class="btn btn--outline btn--sm" style="font-size:.72rem;padding:4px 8px">+Pts</button>'+
            '<button onclick="toggleLockUser(\''+u.id+'\',\''+u.email+'\','+(isLocked?1:0)+')" class="btn btn--sm" style="font-size:.72rem;padding:4px 8px;background:'+(isLocked?'rgba(16,185,129,.15)':'rgba(239,68,68,.15)')+';border:1px solid '+(isLocked?'rgba(16,185,129,.3)':'rgba(239,68,68,.3)')+';color:'+(isLocked?'#10b981':'#ef4444')+'">'+(isLocked?'Unlock':'Lock')+'</button>'+
            '<button onclick="deleteUserAccount(\''+u.id+'\',\''+u.email+'\')" class="btn btn--sm" style="font-size:.72rem;padding:4px 8px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#ef4444"><i class="fas fa-trash"></i></button>'+
          '</div></td>'+
        '</tr>';
      }).join('')+'</tbody></table></div>';
    // Lazy-load renewal dates for users with subscriptions
    data.users.filter(function(u){ return !!u.stripe_subscription_id; }).forEach(function(u){
      fetch('/api/admin/user-renewal/'+u.id,{credentials:'include'})
        .then(function(r){ return r.json(); })
        .then(function(d){
          var el=document.getElementById('renew-'+u.id);
          if(el) el.textContent=d.renewal_date||'—';
        }).catch(function(){
          var el=document.getElementById('renew-'+u.id);
          if(el) el.textContent='—';
        });
    });
    window._usersLoaded=true;
  }catch(e){ if(tableEl) tableEl.innerHTML='<p style="color:#ef4444"><i class="fas fa-exclamation-circle"></i> Failed to load: '+(e.message||'timeout')+'</p>'; }
}

// ── Signup Clicks Tab ────────────────────────────────────────
async function loadSignupClicks(){
  var errHtml=function(msg){ return '<p style="color:#fca5a5;font-size:.82rem;padding:8px;background:rgba(239,68,68,.1);border-radius:6px;border:1px solid rgba(239,68,68,.3)"><b>\u274c Error:</b> '+msg+'</p>'; };
  try{
    var res=await fetch('/api/admin/signup-clicks',{credentials:'include'});
    if(!res.ok) throw new Error('HTTP '+res.status);
    var d=await res.json(); if(d.error) throw new Error(d.error);
    var s=d.stats||{};
    var todayEl=document.getElementById('sc-today'); if(todayEl) todayEl.textContent=s.today||0;
    var weekEl=document.getElementById('sc-week'); if(weekEl) weekEl.textContent=s.this_week||0;
    var g30El=document.getElementById('sc-google30'); if(g30El) g30El.textContent=s.google_30d||0;
    var e30El=document.getElementById('sc-email30'); if(e30El) e30El.textContent=s.email_30d||0;

    // ── Daily trend chart ───────────────────────────────────
    var chartEl=document.getElementById('sc-daily-chart');
    if(chartEl){
      var daily=d.daily||[];
      if(!daily.length){ chartEl.innerHTML='<p style="color:var(--muted);font-size:.82rem;text-align:center;padding-top:40px">No data yet</p>'; }
      else {
        // Merge rows by day: google + email each get own array
        var dayMap={};
        daily.forEach(function(r){ var day=r.day; if(!dayMap[day]) dayMap[day]={day:day,google:0,email:0}; dayMap[day][r.event_type]=(dayMap[day][r.event_type]||0)+r.cnt; });
        var days=Object.keys(dayMap).sort();
        var googleVals=days.map(function(d){ return dayMap[d].google||0; });
        var emailVals=days.map(function(d){ return dayMap[d].email||0; });
        var maxV=Math.max.apply(null,days.map(function(d){ return dayMap[d].google+dayMap[d].email; }).concat([1]));
        var W=chartEl.offsetWidth||560, H=160, PAD={top:12,right:16,bottom:40,left:36};
        var cW=W-PAD.left-PAD.right, cH=H-PAD.top-PAD.bottom;
        var xStep=cW/(days.length-1||1);
        // Grid lines
        var gridLines='';
        for(var gi=0;gi<=4;gi++){
          var gy=PAD.top+cH-Math.round((gi/4)*cH);
          var gv=Math.round((gi/4)*maxV);
          gridLines+='<line x1="'+PAD.left+'" y1="'+gy+'" x2="'+(W-PAD.right)+'" y2="'+gy+'" stroke="rgba(255,255,255,.06)" stroke-width="1"/>';
          gridLines+='<text x="'+(PAD.left-6)+'" y="'+(gy+4)+'" text-anchor="end" fill="rgba(148,163,184,.6)" font-size="10">'+gv+'</text>';
        }
        // Google line (blue)
        var gPts=days.map(function(day,i){ var x=PAD.left+i*xStep; var v=dayMap[day].google||0; var y=PAD.top+cH-Math.round((v/maxV)*cH); return {x:x,y:y,cnt:v,lbl:day}; });
        var gLine=gPts.map(function(p){return p.x+','+p.y;}).join(' ');
        var gArea=gLine+' '+gPts[gPts.length-1].x+','+(PAD.top+cH)+' '+gPts[0].x+','+(PAD.top+cH);
        // Email line (amber)
        var ePts=days.map(function(day,i){ var x=PAD.left+i*xStep; var v=dayMap[day].email||0; var y=PAD.top+cH-Math.round((v/maxV)*cH); return {x:x,y:y,cnt:v,lbl:day}; });
        var eLine=ePts.map(function(p){return p.x+','+p.y;}).join(' ');
        // X labels
        var labelEvery=Math.ceil(days.length/8);
        var xLabels=days.map(function(day,i){ if(i%labelEvery!==0 && i!==days.length-1) return ''; return '<text x="'+(PAD.left+i*xStep)+'" y="'+(H-6)+'" text-anchor="middle" fill="rgba(148,163,184,.7)" font-size="10">'+day.slice(5)+'</text>'; }).join('');
        chartEl.style.height='auto'; chartEl.style.display='block'; chartEl.style.position='relative';
        chartEl.innerHTML=
          '<div style="display:flex;gap:16px;margin-bottom:8px;font-size:.75rem;">'+
            '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#4285F4;margin-right:4px"></span>Google</span>'+
            '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#f59e0b;margin-right:4px"></span>Email</span>'+
          '</div>'+
          '<svg width="100%" viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block">'+
            '<defs>'+
              '<linearGradient id="gAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4285F4" stop-opacity="0.2"/><stop offset="100%" stop-color="#4285F4" stop-opacity="0.01"/></linearGradient>'+
            '</defs>'+
            gridLines+
            '<polygon points="'+gArea+'" fill="url(#gAreaGrad)"/>'+
            '<polyline points="'+gLine+'" fill="none" stroke="#4285F4" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>'+
            '<polyline points="'+eLine+'" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="5,3"/>'+
            xLabels+
          '</svg>';
      }
    }

    // ── Breakdown pie bars ──────────────────────────────────
    var bkEl=document.getElementById('sc-breakdown');
    if(bkEl){
      var total=(s.google_30d||0)+(s.email_30d||0);
      if(!total){ bkEl.innerHTML='<p style="color:var(--muted);font-size:.85rem">No clicks recorded yet.</p>'; }
      else {
        var rows2=[
          {label:'Google Sign-up',cnt:s.google_30d||0,color:'#4285F4',icon:'fab fa-google'},
          {label:'Email Sign-up',cnt:s.email_30d||0,color:'#f59e0b',icon:'fas fa-envelope'},
        ];
        bkEl.innerHTML=rows2.map(function(r){ var pct=total>0?Math.round((r.cnt/total)*100):0; return '<div class="rv-bar-wrap" style="margin-bottom:14px"><div style="width:24px;text-align:center"><i class="'+r.icon+'" style="color:'+r.color+'"></i></div><div style="width:110px;font-size:.84rem">'+r.label+'</div><div class="rv-bar-track"><div class="rv-bar-fill" style="width:'+pct+'%;background:'+r.color+'"></div></div><div style="width:36px;text-align:right;font-size:.85rem;font-weight:700">'+r.cnt+'</div><div style="width:40px;text-align:right;font-size:.75rem;color:var(--muted)">'+pct+'%</div></div>'; }).join(''); }
    }

    // ── Recent events table ──────────────────────────────────
    var recEl=document.getElementById('sc-recent');
    if(recEl){
      var recent=d.recent||[];
      if(!recent.length){ recEl.innerHTML='<p style="color:var(--muted);font-size:.85rem">No click events yet.</p>'; }
      else {
        recEl.innerHTML='<table class="admin-table"><thead><tr><th>Type</th><th>Page</th><th>Country</th><th>Referrer</th><th>Time</th></tr></thead><tbody>'+
          recent.map(function(r){
            var typeIcon=r.event_type==='google'
              ?'<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(66,133,244,.15);color:#4285F4;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:600"><i class="fab fa-google"></i> Google</span>'
              :'<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(245,158,11,.15);color:#f59e0b;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:600"><i class="fas fa-envelope"></i> Email</span>';
            var flag=r.country && r.country.length===2
              ?String.fromCodePoint(0x1F1E6+r.country.charCodeAt(0)-65)+String.fromCodePoint(0x1F1E6+r.country.charCodeAt(1)-65)+' '
              :'\uD83C\uDF10 ';
            var ref=r.referrer?('<code style="font-size:.75rem;max-width:180px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle" title="'+r.referrer+'">'+r.referrer.replace(/^https?:\/\//,'').slice(0,40)+'</code>'):'<span style="color:var(--muted);font-size:.78rem">direct</span>';
            var ts=new Date(r.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
            return '<tr><td>'+typeIcon+'</td><td style="font-size:.82rem;color:var(--muted)">'+r.page+'</td><td style="font-size:.85rem">'+flag+(r.country||'?')+'</td><td>'+ref+'</td><td style="font-size:.78rem;color:var(--muted);white-space:nowrap">'+ts+'</td></tr>';
          }).join('')+
        '</tbody></table>';
      }
    }

    window._signupsLoaded=true;
  }catch(e){
    var msg=String(e.message||e);
    var eh=errHtml(msg);
    var dc2=document.getElementById('sc-daily-chart'); if(dc2) dc2.innerHTML=eh;
    var bk=document.getElementById('sc-breakdown'); if(bk) bk.innerHTML=eh;
    var rc=document.getElementById('sc-recent'); if(rc) rc.innerHTML=eh;
  }
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

// ── Stuck Jobs Tab ──────────────────────────────────────────────────────────
async function loadStuckJobs(){
  var listEl=document.getElementById('stuck-jobs-list');
  var summaryEl=document.getElementById('stuck-jobs-summary');
  if(!listEl) return;
  listEl.innerHTML='<p style="color:var(--muted)"><i class="fas fa-spinner fa-spin"></i> Loading stuck jobs…</p>';
  try{
    var res=await fetch('/api/admin/stuck-jobs',{credentials:'include'});
    if(!res.ok) throw new Error('HTTP '+res.status);
    var d=await res.json();
    if(d.error){ listEl.innerHTML='<p style="color:#ef4444">Error: '+d.error+'</p>'; return; }
    if(summaryEl) summaryEl.textContent='Generating: '+d.total_generating+' | Errors (24h): '+(d.total_errored_24h||0)+' | Stuck: '+d.stuck_count;
    // Update tab badge
    var tabBtn=document.getElementById('stuck-jobs-tab-btn');
    if(tabBtn && d.stuck_count>0){
      tabBtn.innerHTML='<i class="fas fa-exclamation-triangle" style="color:#f59e0b"></i> Stuck Jobs <span style="background:#ef4444;color:#fff;font-size:.65rem;padding:1px 6px;border-radius:999px;margin-left:4px">'+d.stuck_count+'</span>';
    } else if(tabBtn){
      tabBtn.innerHTML='<i class="fas fa-exclamation-triangle" style="color:#10b981"></i> Stuck Jobs';
    }
    if(!d.jobs||!d.jobs.length){
      listEl.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted)"><i class="fas fa-check-circle" style="font-size:2rem;color:#10b981;margin-bottom:12px;display:block"></i><p>No stuck or errored jobs right now.</p></div>';
      return;
    }
    var rows=d.jobs.map(function(j){
      var ageColor=j.age_min>=30?'#ef4444':j.age_min>=10?'#f59e0b':'#10b981';
      var isErr=j.status==='error';
      var stuckBadge=isErr
        ?'<span style="background:rgba(239,68,68,.15);color:#ef4444;font-size:.65rem;padding:2px 7px;border-radius:999px;font-weight:700;border:1px solid rgba(239,68,68,.3)">ERROR</span>'
        :j.stuck?'<span style="background:rgba(245,158,11,.15);color:#f59e0b;font-size:.65rem;padding:2px 7px;border-radius:999px;font-weight:700;border:1px solid rgba(245,158,11,.3)">STUCK</span>'
        :'<span style="color:#10b981;font-size:.72rem">running</span>';
      var taskChip=j.stereo_task_id?'<code style="font-size:.68rem;background:var(--surface);padding:2px 6px;border-radius:4px;color:var(--muted)">'+j.stereo_task_id.slice(0,16)+'…</code>':'—';
      var errCell=isErr&&j.error_msg?'<td style="font-size:.72rem;color:#ef4444;max-width:180px;overflow:hidden;text-overflow:ellipsis" title="'+j.error_msg+'">'+j.error_msg.slice(0,50)+(j.error_msg.length>50?'…':'')+'</td>':'<td style="color:var(--muted);font-size:.72rem">—</td>';
      var deleteBtn='<button onclick="adminDeleteJob(\''+j.id+'\',this)" style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);color:#ef4444;border-radius:6px;padding:3px 10px;font-size:.72rem;cursor:pointer;font-weight:600">Delete</button>';
      return '<tr id="stuck-row-'+j.id+'">'+
        '<td style="font-size:.8rem;font-family:monospace;max-width:100px;overflow:hidden;text-overflow:ellipsis" title="'+j.id+'">'+j.id.slice(0,14)+'…</td>'+
        '<td style="font-size:.82rem">'+j.user_email+'</td>'+
        '<td style="font-size:.82rem;max-width:140px;overflow:hidden;text-overflow:ellipsis">'+j.title+'</td>'+
        '<td>'+stuckBadge+'</td>'+
        '<td style="color:'+ageColor+';font-weight:700">'+j.age_min+'m</td>'+
        '<td>'+taskChip+'</td>'+
        errCell+
        '<td style="font-size:.72rem;color:var(--muted)">'+j.created_at?.replace('T',' ').slice(0,16)+' UTC</td>'+
        '<td>'+deleteBtn+'</td>'+
      '</tr>';
    }).join('');
    listEl.innerHTML='<table class="admin-table"><thead><tr>'+
      '<th>Job ID</th><th>User</th><th>Title</th><th>Status</th>'+
      '<th>Age</th><th>Task ID</th><th>Error</th><th>Started</th><th></th>'+
    '</tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){
    listEl.innerHTML='<p style="color:#ef4444">Failed to load: '+String(e.message||e)+'</p>';
  }
}

async function rescueStuckJobs(){
  var summaryEl=document.getElementById('stuck-jobs-summary');
  if(summaryEl) summaryEl.textContent='Rescuing stuck jobs…';
  try{
    var res=await fetch('/api/admin/rescue-stuck-jobs',{credentials:'include'});
    if(!res.ok) throw new Error('HTTP '+res.status);
    var d=await res.json();
    if(summaryEl) summaryEl.textContent='Rescue complete: '+d.rescued+' jobs processed. Refreshing…';
    setTimeout(loadStuckJobs,1500);
  }catch(e){
    if(summaryEl) summaryEl.textContent='Rescue failed: '+String(e.message||e);
  }
}

async function adminDeleteJob(jobId, btnEl){
  if(!confirm('Delete job '+jobId.slice(0,14)+'… from the database? This removes it from the user\'s library permanently.')) return;
  if(btnEl){ btnEl.disabled=true; btnEl.textContent='Deleting…'; }
  try{
    var res=await fetch('/api/admin/job/'+jobId,{method:'DELETE',credentials:'include'});
    if(!res.ok){ var e=await res.json().catch(function(){return{};}); throw new Error(e.error||'HTTP '+res.status); }
    // Remove row from table immediately
    var row=document.getElementById('stuck-row-'+jobId);
    if(row) row.remove();
    var summaryEl=document.getElementById('stuck-jobs-summary');
    if(summaryEl) summaryEl.textContent='Deleted job '+jobId.slice(0,14)+'…';
  }catch(e){
    alert('Delete failed: '+String(e.message||e));
    if(btnEl){ btnEl.disabled=false; btnEl.textContent='Delete'; }
  }
}

// ─── BROADCAST EMAIL BUILDER ─────────────────────────────────────────────────
var _bcBlocks = [];
var _bcNextId = 1;

async function loadBroadcastStats() {
  try {
    var res = await fetch('/api/admin/broadcast/subscribers', { credentials: 'include' });
    var d = await res.json();
    var el = function(id, v) { var e = document.getElementById(id); if(e) e.textContent = v; };
    el('bc-count-all', d.all || 0);
    el('bc-count-free', d.free || 0);
    el('bc-count-paid', d.paid || 0);
  } catch(e) { console.error('[broadcast] stats failed', e); }
}

function bcAddBlock(type) {
  var id = 'bc-block-' + (_bcNextId++);
  var block = { id: id, type: type };
  if (type === 'header')  { block.text = 'Your Headline Here'; block.fontSize = '28'; block.color = ''; block.align = 'center'; block.bold = true; }
  if (type === 'text')    { block.text = 'Write your message here. You can use multiple lines.'; block.fontSize = '16'; block.color = ''; block.align = 'left'; block.bold = false; }
  if (type === 'image')   { block.src = ''; block.alt = ''; block.link = ''; block.width = '100%'; }
  if (type === 'button')  { block.text = 'Click Here'; block.url = 'https://stemforge.studio'; block.bgColor = '#4e9fff'; block.textColor = '#ffffff'; block.align = 'center'; }
  if (type === 'divider') { block.color = '#1e293b'; }
  if (type === 'spacer')  { block.height = '24'; }
  if (type === 'rawhtml') { block.html = '<div style="text-align:center;padding:16px"><!-- paste your HTML here --></div>'; }
  if (type === 'youtube') { block.url = 'https://youtu.be/'; block.caption = 'Watch it in action — click to play on YouTube'; }
  _bcBlocks.push(block);
  bcRenderBlocks();
  bcUpdatePreview();
}

function bcRenderBlocks() {
  var container = document.getElementById('bc-blocks');
  var empty = document.getElementById('bc-blocks-empty');
  if (!container) return;
  if (_bcBlocks.length === 0) { if(empty) empty.style.display=''; container.querySelectorAll('.bc-block-row').forEach(function(el){el.remove()}); return; }
  if (empty) empty.style.display = 'none';
  // Remove existing block rows
  container.querySelectorAll('.bc-block-row').forEach(function(el){el.remove();});
  _bcBlocks.forEach(function(block, idx) {
    var row = document.createElement('div');
    row.className = 'bc-block-row';
    row.id = 'bc-row-' + block.id;
    row.style.cssText = 'background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px;margin-bottom:8px';
    var header = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
      + '<span style="font-size:.78rem;color:#a78bfa;font-weight:600;text-transform:uppercase">' + block.type + '</span>'
      + '<div style="display:flex;gap:6px">'
      + (idx > 0 ? '<button onclick="bcMoveBlock(\'' + block.id + '\',-1)" style="padding:2px 8px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#94a3b8;cursor:pointer;font-size:.75rem">↑</button>' : '')
      + (idx < _bcBlocks.length-1 ? '<button onclick="bcMoveBlock(\'' + block.id + '\',1)" style="padding:2px 8px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#94a3b8;cursor:pointer;font-size:.75rem">↓</button>' : '')
      + '<button onclick="bcRemoveBlock(\'' + block.id + '\')" style="padding:2px 8px;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);border-radius:4px;color:#ef4444;cursor:pointer;font-size:.75rem">✕</button>'
      + '</div></div>';
    var controls = '';
    if (block.type === 'header' || block.type === 'text') {
      controls += '<textarea onchange="bcUpdateField(\'' + block.id + '\',\'text\',this.value)" oninput="bcUpdateField(\'' + block.id + '\',\'text\',this.value)" style="width:100%;padding:8px;background:#0d1117;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.85rem;min-height:' + (block.type==='header'?'48':'80') + 'px;resize:vertical;box-sizing:border-box;margin-bottom:8px">' + escHtml(block.text) + '</textarea>';
      controls += '<div style="display:flex;flex-wrap:wrap;gap:8px">';
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block">Font Size</label><input type="number" value="' + block.fontSize + '" min="10" max="72" onchange="bcUpdateField(\'' + block.id + '\',\'fontSize\',this.value)" style="width:70px;padding:4px 8px;background:#0d1117;border:1px solid #334155;border-radius:4px;color:#e2e8f0;font-size:.82rem"/></div>';
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block">Color</label><input type="color" value="' + (block.color||'#e2e8f0') + '" onchange="bcUpdateField(\'' + block.id + '\',\'color\',this.value)" style="width:50px;height:28px;border-radius:4px;border:1px solid #334155;background:none;cursor:pointer"/></div>';
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block">Align</label><select onchange="bcUpdateField(\'' + block.id + '\',\'align\',this.value)" style="padding:4px 8px;background:#0d1117;border:1px solid #334155;border-radius:4px;color:#e2e8f0;font-size:.82rem"><option value="left"' + (block.align==='left'?' selected':'') + '>Left</option><option value="center"' + (block.align==='center'?' selected':'') + '>Center</option><option value="right"' + (block.align==='right'?' selected':'') + '>Right</option></select></div>';
      controls += '<div style="display:flex;align-items:flex-end"><label style="display:flex;align-items:center;gap:4px;font-size:.82rem;color:#94a3b8;cursor:pointer"><input type="checkbox"' + (block.bold?' checked':'') + ' onchange="bcUpdateField(\'' + block.id + '\',\'bold\',this.checked)"/> Bold</label></div>';
      controls += '</div>';
    }
    if (block.type === 'image') {
      controls += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
      controls += '<div style="grid-column:1/-1"><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">Image URL</label><input type="url" value="' + escHtml(block.src) + '" placeholder="https://..." onchange="bcUpdateField(\'' + block.id + '\',\'src\',this.value)" style="width:100%;padding:6px 10px;background:#0d1117;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.82rem;box-sizing:border-box"/></div>';
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">Link URL (optional)</label><input type="url" value="' + escHtml(block.link) + '" placeholder="https://..." onchange="bcUpdateField(\'' + block.id + '\',\'link\',this.value)" style="width:100%;padding:6px 10px;background:#0d1117;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.82rem;box-sizing:border-box"/></div>';
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">Width</label><input type="text" value="' + escHtml(block.width) + '" placeholder="100%" onchange="bcUpdateField(\'' + block.id + '\',\'width\',this.value)" style="width:100%;padding:6px 10px;background:#0d1117;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.82rem;box-sizing:border-box"/></div>';
      controls += '</div>';
    }
    if (block.type === 'button') {
      controls += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">Button Text</label><input type="text" value="' + escHtml(block.text) + '" onchange="bcUpdateField(\'' + block.id + '\',\'text\',this.value)" style="width:100%;padding:6px 10px;background:#0d1117;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.82rem;box-sizing:border-box"/></div>';
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">Button URL</label><input type="url" value="' + escHtml(block.url) + '" onchange="bcUpdateField(\'' + block.id + '\',\'url\',this.value)" style="width:100%;padding:6px 10px;background:#0d1117;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.82rem;box-sizing:border-box"/></div>';
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">Button Color</label><input type="color" value="' + block.bgColor + '" onchange="bcUpdateField(\'' + block.id + '\',\'bgColor\',this.value)" style="width:100%;height:32px;border-radius:4px;border:1px solid #334155;background:none;cursor:pointer"/></div>';
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">Text Color</label><input type="color" value="' + block.textColor + '" onchange="bcUpdateField(\'' + block.id + '\',\'textColor\',this.value)" style="width:100%;height:32px;border-radius:4px;border:1px solid #334155;background:none;cursor:pointer"/></div>';
      controls += '<div style="grid-column:1/-1"><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">Alignment</label><select onchange="bcUpdateField(\'' + block.id + '\',\'align\',this.value)" style="padding:6px 10px;background:#0d1117;border:1px solid #334155;border-radius:4px;color:#e2e8f0;font-size:.82rem"><option value="center"' + (block.align==='center'?' selected':'') + '>Center</option><option value="left"' + (block.align==='left'?' selected':'') + '>Left</option><option value="right"' + (block.align==='right'?' selected':'') + '>Right</option></select></div>';
      controls += '</div>';
    }
    if (block.type === 'divider') {
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">Line Color</label><input type="color" value="' + block.color + '" onchange="bcUpdateField(\'' + block.id + '\',\'color\',this.value)" style="width:60px;height:28px;border-radius:4px;border:1px solid #334155;background:none;cursor:pointer"/></div>';
    }
    if (block.type === 'spacer') {
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">Height (px)</label><input type="number" value="' + block.height + '" min="4" max="120" onchange="bcUpdateField(\'' + block.id + '\',\'height\',this.value)" style="width:80px;padding:4px 8px;background:#0d1117;border:1px solid #334155;border-radius:4px;color:#e2e8f0;font-size:.82rem"/></div>';
    }
    if (block.type === 'rawhtml') {
      controls += '<textarea onchange="bcUpdateField(\'' + block.id + '\',\'html\',this.value)" oninput="bcUpdateField(\'' + block.id + '\',\'html\',this.value)" style="width:100%;padding:8px;background:#0d1117;border:1px solid #334155;border-radius:6px;color:#a78bfa;font-size:.78rem;min-height:100px;resize:vertical;box-sizing:border-box;font-family:monospace">' + escHtml(block.html||'') + '</textarea>';
      controls += '<p style="font-size:.72rem;color:#64748b;margin:4px 0 0">Raw HTML — injected directly into the email.</p>';
    }
    if (block.type === 'youtube') {
      var vidId = (block.url||'').match(/(?:youtu\.be\/|v=)([\w-]{11})/);
      var thumbSrc = vidId ? 'https://img.youtube.com/vi/' + vidId[1] + '/hqdefault.jpg' : '';
      controls += '<div style="display:grid;gap:8px">';
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">YouTube URL</label><input type="url" value="' + escHtml(block.url||'') + '" placeholder="https://youtu.be/XXXXXXXXXXX" onchange="bcUpdateField(\'' + block.id + '\',\'url\',this.value);bcRenderBlocks()" style="width:100%;padding:6px 10px;background:#0d1117;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.82rem;box-sizing:border-box"/></div>';
      controls += '<div><label style="font-size:.72rem;color:#64748b;display:block;margin-bottom:3px">Caption text</label><input type="text" value="' + escHtml(block.caption||'') + '" placeholder="Watch it in action..." onchange="bcUpdateField(\'' + block.id + '\',\'caption\',this.value)" style="width:100%;padding:6px 10px;background:#0d1117;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.82rem;box-sizing:border-box"/></div>';
      if (thumbSrc) controls += '<div style="margin-top:4px"><img src="' + thumbSrc + '" style="width:100%;max-width:320px;border-radius:8px;border:2px solid #a78bfa;display:block"/><p style="font-size:.72rem;color:#10b981;margin:4px 0 0">✓ Thumbnail preview — auto-fetched from YouTube</p></div>';
      else controls += '<p style="font-size:.72rem;color:#f59e0b;margin:4px 0 0">Paste a valid YouTube URL above to see the thumbnail</p>';
      controls += '</div>';
    }
    row.innerHTML = header + controls;
    container.appendChild(row);
  });
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function bcUpdateField(id, field, value) {
  var block = _bcBlocks.find(function(b){return b.id===id;});
  if (!block) return;
  block[field] = value;
  bcUpdatePreview();
}

function bcRemoveBlock(id) {
  _bcBlocks = _bcBlocks.filter(function(b){return b.id!==id;});
  bcRenderBlocks();
  bcUpdatePreview();
}

function bcMoveBlock(id, dir) {
  var idx = _bcBlocks.findIndex(function(b){return b.id===id;});
  if (idx < 0) return;
  var newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= _bcBlocks.length) return;
  var tmp = _bcBlocks[idx]; _bcBlocks[idx] = _bcBlocks[newIdx]; _bcBlocks[newIdx] = tmp;
  bcRenderBlocks();
  bcUpdatePreview();
}

function bcBuildHtml() {
  var bg = document.getElementById('bc-bg-color')?.value || '#0d0d1a';
  var textColor = document.getElementById('bc-text-color')?.value || '#e2e8f0';
  var accent = document.getElementById('bc-accent-color')?.value || '#4e9fff';
  var font = document.getElementById('bc-font')?.value || 'Inter,system-ui,sans-serif';
  var width = document.getElementById('bc-width')?.value || '600px';

  var blocksHtml = _bcBlocks.map(function(block) {
    if (block.type === 'header') {
      var c = block.color || accent;
      return '<h1 style="margin:0 0 16px;font-size:' + block.fontSize + 'px;color:' + c + ';text-align:' + block.align + ';font-weight:' + (block.bold?'700':'400') + ';font-family:' + font + '">' + escHtml(block.text) + '</h1>';
    }
    if (block.type === 'text') {
      var c = block.color || textColor;
      return '<p style="margin:0 0 16px;font-size:' + block.fontSize + 'px;color:' + c + ';text-align:' + block.align + ';font-weight:' + (block.bold?'700':'400') + ';font-family:' + font + ';line-height:1.6">' + escHtml(block.text).replace(/\n/g,'<br/>') + '</p>';
    }
    if (block.type === 'image') {
      if (!block.src) return '<div style="background:#1e293b;border:2px dashed #334155;border-radius:8px;padding:20px;text-align:center;color:#64748b;font-family:'+font+';margin-bottom:16px">[ Image: paste URL in builder ]</div>';
      var img = '<img src="' + escHtml(block.src) + '" alt="' + escHtml(block.alt) + '" width="' + escHtml(block.width) + '" style="display:block;max-width:100%;height:auto;border-radius:8px;margin:0 auto 16px"/>';
      return block.link ? '<a href="' + escHtml(block.link) + '" style="display:block;text-align:center">' + img + '</a>' : img;
    }
    if (block.type === 'button') {
      return '<div style="text-align:' + block.align + ';margin-bottom:20px"><a href="' + escHtml(block.url) + '" style="display:inline-block;padding:14px 32px;background:' + block.bgColor + ';color:' + block.textColor + ';text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;font-family:' + font + '">' + escHtml(block.text) + '</a></div>';
    }
    if (block.type === 'divider') {
      return '<hr style="border:none;border-top:1px solid ' + block.color + ';margin:16px 0"/>';
    }
    if (block.type === 'spacer') {
      return '<div style="height:' + block.height + 'px"></div>';
    }
    if (block.type === 'rawhtml') {
      return block.html || '';
    }
    if (block.type === 'youtube') {
      var vidMatch = (block.url||'').match(/(?:youtu\.be\/|v=)([\w-]{11})/);
      if (!vidMatch) return '<div style="background:#1e293b;border:2px dashed #334155;border-radius:8px;padding:20px;text-align:center;color:#64748b;font-family:'+font+';margin-bottom:16px">[ YouTube: paste URL in builder ]</div>';
      var vid = vidMatch[1];
      var ytLink = 'https://youtu.be/' + vid;
      var ytThumb = 'https://img.youtube.com/vi/' + vid + '/maxresdefault.jpg';
      var cap = escHtml(block.caption || 'Click to watch on YouTube');
      return '<div style="margin-bottom:20px">'
        + (block.caption ? '<p style="font-family:'+font+';font-size:14px;color:#c084fc;text-align:center;margin:0 0 10px;font-weight:600">&#127916; ' + cap + '</p>' : '')
        + '<a href="' + ytLink + '" target="_blank" style="display:block;position:relative;border-radius:12px;overflow:hidden;border:2px solid rgba(192,132,252,0.5);box-shadow:0 8px 32px rgba(139,92,246,0.4);text-decoration:none">'
        + '<img src="' + ytThumb + '" alt="YouTube video thumbnail" style="width:100%;display:block;border-radius:10px"/>'
        + '<div style="position:absolute;inset:0;background:rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center">'
        + '<div style="width:68px;height:68px;border-radius:50%;background:rgba(220,38,38,0.95);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 24px rgba(0,0,0,0.6);border:3px solid rgba(255,255,255,0.9)">'
        + '<svg viewBox="0 0 24 24" width="32" height="32" fill="white" style="margin-left:4px"><polygon points="9,5 20,12 9,19"/></svg>'
        + '</div></div></a>'
        + '</div>';
    }
    return '';
  }).join('\n');

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>'
    + '<body style="margin:0;padding:0;background:' + bg + '">'
    + '<div style="max-width:' + width + ';margin:0 auto;padding:32px 24px;background:' + bg + ';font-family:' + font + '">'
    + '<div style="text-align:center;margin-bottom:28px"><a href="https://stemforge.studio" style="text-decoration:none"><span style="font-size:22px;font-weight:800;color:' + accent + ';font-family:' + font + '">StemForge</span></a></div>'
    + blocksHtml
    + '</div></body></html>';
}

function bcUpdatePreview() {
  var frame = document.getElementById('bc-preview-frame');
  var subjLine = document.getElementById('bc-preview-subject-line');
  var subj = document.getElementById('bc-subject')?.value || '';
  if (subjLine) { var s = subjLine.querySelector('span'); if(s) s.textContent = subj || '(no subject)'; }
  if (!frame) return;
  frame.innerHTML = bcBuildHtml();
}

// Attach live preview updates to style controls
document.addEventListener('DOMContentLoaded', function() {
  ['bc-bg-color','bc-text-color','bc-accent-color','bc-font','bc-width','bc-subject'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { el.addEventListener('input', bcUpdatePreview); el.addEventListener('change', bcUpdatePreview); }
  });
});


async function bcSendBroadcast() {
  var subject = document.getElementById('bc-subject')?.value?.trim();
  if (!subject) { alert('Enter a subject line first.'); return; }
  if (_bcBlocks.length === 0) { alert('Add at least one content block first.'); return; }
  var audience = document.getElementById('bc-audience')?.value || 'none';
  if (audience === 'none') { alert('Please select an audience (All Users, Free Plan, or Paid Plan) before sending.'); return; }
  var broadcastName = document.getElementById('bc-template-name')?.value?.trim() || subject;
  var label = audience === 'all' ? 'ALL users' : audience === 'free' ? 'free plan users' : 'paid plan users';
  var countEl = document.getElementById('bc-count-' + audience);
  var count = countEl ? countEl.textContent : '?';
  if (!confirm('Send "' + subject + '" to ' + count + ' ' + label + '?\n\nThis cannot be undone.')) return;
  bcSetStatus('<i class="fas fa-spinner fa-spin"></i> Sending…', '#f59e0b');
  try {
    var res = await fetch('/api/admin/broadcast/send', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: subject, html: bcBuildHtml(), audience: audience, broadcast_name: broadcastName })
    });
    var d = await res.json();
    if (d.ok) {
      bcSetStatus('✓ Sent to ' + d.sent + ' / ' + d.total + ' users' + (d.errors > 0 ? ' (' + d.errors + ' failed)' : ''), '#10b981');
      bcLoadHistory(); // refresh history table
    } else {
      bcSetStatus('Error: ' + (d.error || 'Unknown'), '#ef4444');
    }
  } catch(e) { bcSetStatus('Network error: ' + e.message, '#ef4444'); }
}

function bcSetStatus(msg, color) {
  var el = document.getElementById('bc-status');
  if (!el) return;
  el.style.display = 'block';
  el.style.color = color || '#e2e8f0';
  el.innerHTML = msg;
}

// ── Send to Individual User ───────────────────────────────────────────────────
var _bcAllUsers       = [];   // full list fetched once
var _bcSelectedUser   = null; // { id, email, name }
var _bcIndividualOpen = false;

function bcToggleIndividual() {
  _bcIndividualOpen = !_bcIndividualOpen;
  var body    = document.getElementById('bc-individual-body');
  var chevron = document.getElementById('bc-individual-chevron');
  if (body)    body.style.display    = _bcIndividualOpen ? 'block' : 'none';
  if (chevron) chevron.style.transform = _bcIndividualOpen ? 'rotate(180deg)' : 'rotate(0deg)';
  if (_bcIndividualOpen && _bcAllUsers.length === 0) bcFetchAllUsers();
}

async function bcFetchAllUsers() {
  var list = document.getElementById('bc-user-list');
  if (!list) return;
  list.innerHTML = '<div style="padding:20px;text-align:center;color:#475569;font-size:.85rem"><i class="fas fa-spinner fa-spin" style="margin-right:6px"></i> Loading users…</div>';
  try {
    var res = await fetch('/api/admin/users', { credentials: 'include' });
    var d   = await res.json();
    _bcAllUsers = d.users || [];
    bcRenderUserList(_bcAllUsers);
  } catch(e) {
    list.innerHTML = '<div style="padding:16px;color:#ef4444;font-size:.85rem">Failed to load users</div>';
  }
}

function bcSearchUsers(q) {
  if (!_bcAllUsers.length) { bcFetchAllUsers(); return; }
  // Clear any previously selected user when the search query changes
  if (_bcSelectedUser) { bcClearSelectedUser(); }
  q = q.trim().toLowerCase();
  var filtered = q
    ? _bcAllUsers.filter(function(u) {
        return (u.email || '').toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q);
      })
    : _bcAllUsers;
  bcRenderUserList(filtered);
}

// Stores the currently rendered filtered list so click handler can look up by index safely
var _bcRenderedUsers = [];

function bcRenderUserList(users) {
  _bcRenderedUsers = users;
  var list = document.getElementById('bc-user-list');
  if (!list) return;
  if (!users.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:#475569;font-size:.85rem">No users found</div>';
    return;
  }
  var planColor = { free: '#64748b', creator: '#f59e0b', pro: '#a78bfa' };
  list.innerHTML = users.map(function(u, idx) {
    var selected = _bcSelectedUser && _bcSelectedUser.id === u.id;
    var pc = planColor[u.plan] || '#64748b';
    var initials = ((u.name || u.email || '?')[0]).toUpperCase();
    return '<div data-uindex="' + idx + '" class="bc-user-row" '
      + 'style="display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;border-bottom:1px solid #0f1e35;'
      + 'background:' + (selected ? '#0d2440' : 'transparent') + '">'
      // Avatar circle
      + '<div style="width:32px;height:32px;border-radius:50%;background:#1e293b;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;color:#94a3b8;flex-shrink:0">' + initials + '</div>'
      // Name + email
      + '<div style="flex:1;min-width:0">'
      +   '<div style="font-size:.88rem;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(u.name || '—') + '</div>'
      +   '<div style="font-size:.78rem;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(u.email) + '</div>'
      + '</div>'
      // Plan badge
      + '<span style="font-size:.68rem;font-weight:600;color:' + pc + ';background:' + pc + '22;border-radius:20px;padding:2px 8px;flex-shrink:0">' + (u.plan || 'free') + '</span>'
      // Checkmark if selected
      + (selected ? '<i class="fas fa-check-circle" style="color:#4e9fff;font-size:.9rem;flex-shrink:0"></i>' : '')
      + '</div>';
  }).join('');

  // Single event listener on the container — no onclick attributes needed
  list.onclick = function(e) {
    var row = e.target.closest('.bc-user-row');
    if (!row) return;
    var idx = parseInt(row.getAttribute('data-uindex'), 10);
    var u = _bcRenderedUsers[idx];
    if (!u) return;
    bcSelectUser(u);
  };
}

function bcSelectUser(u) {
  _bcSelectedUser = u;
  // Highlight selected row, un-highlight others
  document.querySelectorAll('.bc-user-row').forEach(function(row) {
    var idx = parseInt(row.getAttribute('data-uindex'), 10);
    var isSelected = _bcRenderedUsers[idx] && _bcRenderedUsers[idx].id === u.id;
    row.style.background = isSelected ? '#0d2440' : 'transparent';
    // Add/remove checkmark
    var existing = row.querySelector('.bc-check');
    if (isSelected && !existing) {
      var chk = document.createElement('i');
      chk.className = 'fas fa-check-circle bc-check';
      chk.style.cssText = 'color:#4e9fff;font-size:.9rem;flex-shrink:0';
      row.appendChild(chk);
    } else if (!isSelected && existing) {
      existing.remove();
    }
  });
  // Show selected badge
  var badge  = document.getElementById('bc-selected-user');
  var nameEl = document.getElementById('bc-selected-name');
  var emailEl = document.getElementById('bc-selected-email');
  if (badge)  { badge.style.display = 'flex'; badge.style.alignItems = 'center'; badge.style.justifyContent = 'space-between'; }
  if (nameEl)  nameEl.textContent  = u.name || u.email;
  if (emailEl) emailEl.textContent = u.email;
  bcSetIndividualStatus('', '');
}

function bcClearSelectedUser() {
  _bcSelectedUser = null;
  var badge = document.getElementById('bc-selected-user');
  if (badge) badge.style.display = 'none';
  // Clear all row highlights and checkmarks
  document.querySelectorAll('.bc-user-row').forEach(function(row) {
    row.style.background = 'transparent';
    var chk = row.querySelector('.bc-check');
    if (chk) chk.remove();
  });
  bcSetIndividualStatus('', '');
}

async function bcSendToUser() {
  if (!_bcSelectedUser) { alert('Select a user from the list first.'); return; }
  var subject = document.getElementById('bc-subject')?.value?.trim();
  if (!subject) { alert('Enter a subject line first.'); return; }
  if (_bcBlocks.length === 0) { alert('Add at least one content block first.'); return; }
  var u = _bcSelectedUser;
  var broadcastName = document.getElementById('bc-template-name')?.value?.trim() || subject;
  if (!confirm('Send "' + subject + '" to ' + u.name + ' (' + u.email + ')?\n\nThis will send immediately and appear in Broadcast History.')) return;
  // Make status visible immediately before async call
  var statusEl = document.getElementById('bc-individual-status');
  if (statusEl) { statusEl.style.display = 'block'; statusEl.style.color = '#f59e0b'; statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…'; }
  try {
    var payload = {
      subject: subject,
      html: bcBuildHtml(),
      user_email: u.email,
      broadcast_name: broadcastName
    };
    var res = await fetch('/api/admin/broadcast/send-one', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var rawText = await res.text();
    var d;
    try { d = JSON.parse(rawText); } catch(pe) { d = { error: 'Bad response: ' + rawText.slice(0, 100) }; }
    if (d.ok) {
      if (statusEl) { statusEl.style.color = '#10b981'; statusEl.innerHTML = '✓ Sent to ' + escHtml(d.name || u.name) + ' (' + escHtml(u.email) + ') — check Broadcast History below'; }
      // Scroll to and refresh broadcast history
      window._broadcastsLoaded = false; // force reload
      bcLoadHistory();
      var histEl = document.getElementById('bc-history-table');
      if (histEl) histEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      if (statusEl) { statusEl.style.color = '#ef4444'; statusEl.innerHTML = '✗ Error: ' + escHtml(d.error || 'Unknown error (status ' + res.status + ')'); }
    }
  } catch(e) {
    if (statusEl) { statusEl.style.color = '#ef4444'; statusEl.innerHTML = '✗ Network error: ' + escHtml(e.message); }
  }
}

function bcSetIndividualStatus(msg, color) {
  var el = document.getElementById('bc-individual-status');
  if (!el) return;
  el.style.display = msg ? 'block' : 'none';
  el.style.color   = color || '#e2e8f0';
  el.innerHTML     = msg;
}

// ── Saved Templates ──────────────────────────────────────────────────────────
var _bcEditId = null; // null = new template, number = editing existing

async function bcLoadTemplates() {
  var el = document.getElementById('bc-templates-list');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;margin:0"><i class="fas fa-spinner fa-spin"></i> Loading…</p>';
  try {
    var res = await fetch('/api/admin/templates', { credentials: 'include' });
    var d = await res.json();
    if (!d.templates || !d.templates.length) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;margin:0">No saved templates yet. Build one and click <strong>Save Template</strong>.</p>';
      return;
    }
    el.innerHTML = d.templates.map(function(t) {
      var badge = t.is_system ? '<span style="font-size:.65rem;background:rgba(167,139,250,.2);color:#a78bfa;border-radius:4px;padding:1px 6px;margin-left:6px">system</span>' : '';
      var delBtn = t.is_system ? '' : '<button onclick="bcDeleteTemplate(' + t.id + ',\'' + escHtml(t.name) + '\')" style="background:none;border:none;color:#475569;cursor:pointer;padding:2px 6px;font-size:.8rem" title="Delete"><i class="fas fa-trash"></i></button>';
      return '<div style="display:flex;align-items:center;gap:8px;background:#0f172a;border:1px solid var(--border);border-radius:10px;padding:10px 14px;cursor:pointer;transition:border-color .2s" onmouseover="this.style.borderColor=\'#4e9fff\'" onmouseout="this.style.borderColor=\'var(--border)\'">'+
        '<div style="flex:1" onclick="bcLoadTemplate(' + t.id + ')">'+
          '<div style="font-size:.88rem;font-weight:600;color:#e2e8f0">' + escHtml(t.name) + badge + '</div>'+
          '<div style="font-size:.75rem;color:#64748b;margin-top:2px">' + escHtml(t.subject || '(no subject)') + '</div>'+
        '</div>'+
        '<button onclick="bcLoadTemplate(' + t.id + ')" style="background:none;border:none;color:#4e9fff;cursor:pointer;padding:2px 6px;font-size:.8rem" title="Load"><i class="fas fa-edit"></i> Edit</button>'+
        delBtn +
      '</div>';
    }).join('');
    // store templates for lookup
    window._bcTemplates = d.templates;
  } catch(e) {
    el.innerHTML = '<p style="color:#ef4444;font-size:.85rem;margin:0">Failed to load templates: ' + e.message + '</p>';
  }
}

function bcLoadTemplate(id) {
  var t = (window._bcTemplates || []).find(function(x){ return x.id == id; });
  if (!t) return;
  _bcEditId = id;
  // Load name + subject
  var nameEl = document.getElementById('bc-template-name');
  var subjectEl = document.getElementById('bc-subject');
  if (nameEl) nameEl.value = t.name || '';
  if (subjectEl) subjectEl.value = t.subject || '';
  // Load styles
  try {
    var styles = JSON.parse(t.styles_json || '{}');
    var bg = document.getElementById('bc-bg-color');
    var tc = document.getElementById('bc-text-color');
    var ac = document.getElementById('bc-accent-color');
    var fn = document.getElementById('bc-font');
    var wd = document.getElementById('bc-width');
    if (bg && styles.bgColor) bg.value = styles.bgColor;
    if (tc && styles.textColor) tc.value = styles.textColor;
    if (ac && styles.accentColor) ac.value = styles.accentColor;
    if (fn && styles.font) fn.value = styles.font;
    if (wd && styles.width) wd.value = styles.width;
  } catch(e) {}
  // Load blocks
  try {
    var rawBlocks = JSON.parse(t.blocks_json || '[]');
    // Convert from server block format to client format
    window._bcBlocks = rawBlocks.map(function(b) {
      if (b.type === 'header' || b.type === 'text') {
        return { id: b.id || ('b'+Date.now()+Math.random()), type: b.type, text: b.text || '', align: b.align || 'left', fontSize: (b.fontSize||'').replace('px','')||'16', bold: b.bold || false };
      }
      if (b.type === 'image') return { id: b.id || ('b'+Date.now()+Math.random()), type: 'image', src: b.url || b.src || '', alt: b.alt || '', link: b.link || '', width: (b.width||'100%').replace('px','')+'px', align: b.align || 'center' };
      if (b.type === 'button') return { id: b.id || ('b'+Date.now()+Math.random()), type: 'button', text: b.text || 'Click Here', url: b.url || '#', align: b.align || 'center', bgColor: b.bgColor || '#4e9fff', textColor: b.textColor || '#050c1a' };
      if (b.type === 'divider') return { id: b.id || ('b'+Date.now()+Math.random()), type: 'divider' };
      if (b.type === 'spacer') return { id: b.id || ('b'+Date.now()+Math.random()), type: 'spacer', height: (b.height||'16px').replace('px','') };
      if (b.type === 'rawhtml') return { id: b.id || ('b'+Date.now()+Math.random()), type: 'rawhtml', html: b.html || b.content || '' };
      if (b.type === 'youtube') return { id: b.id || ('b'+Date.now()+Math.random()), type: 'youtube', url: b.url || '', caption: b.caption || '' };
      return b;
    });
  } catch(e) { window._bcBlocks = []; }
  bcRenderBlocks();
  bcUpdatePreview();
  var wrap = document.getElementById('bc-builder-wrap');
  if (wrap) { wrap.style.display = 'block'; wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  bcSetStatus('✓ Template "' + t.name + '" loaded — edit and click Save Template', '#10b981');
}

function bcCloseBuilder() {
  var wrap = document.getElementById('bc-builder-wrap');
  if (wrap) wrap.style.display = 'none';
  _bcEditId = null;
}

function bcOpenNew() {
  _bcEditId = null;
  var nameEl = document.getElementById('bc-template-name');
  var subjectEl = document.getElementById('bc-subject');
  if (nameEl) nameEl.value = '';
  if (subjectEl) subjectEl.value = '';
  window._bcBlocks = [];
  bcRenderBlocks();
  bcUpdatePreview();
  var wrap = document.getElementById('bc-builder-wrap');
  if (wrap) { wrap.style.display = 'block'; wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  bcSetStatus('New template — add blocks and click Save Template', '#64748b');
}

function bcNewTemplate() {
  // Internal reset only (called after save) — does NOT show builder
  _bcEditId = null;
  var nameEl = document.getElementById('bc-template-name');
  var subjectEl = document.getElementById('bc-subject');
  if (nameEl) nameEl.value = '';
  if (subjectEl) subjectEl.value = '';
  window._bcBlocks = [];
  bcRenderBlocks();
  bcUpdatePreview();
  var wrap = document.getElementById('bc-builder-wrap');
  if (wrap) wrap.style.display = 'none';
}

async function bcSaveTemplate() {
  var name = (document.getElementById('bc-template-name') || {}).value || '';
  var subject = (document.getElementById('bc-subject') || {}).value || '';
  if (!name.trim()) { bcSetStatus('Please enter a template name first', '#f59e0b'); return; }
  var blocks = window._bcBlocks || [];
  var styles = {
    bgColor: (document.getElementById('bc-bg-color') || {}).value || '#0d0d1a',
    textColor: (document.getElementById('bc-text-color') || {}).value || '#e2e8f0',
    accentColor: (document.getElementById('bc-accent-color') || {}).value || '#4e9fff',
    font: (document.getElementById('bc-font') || {}).value || 'Inter,system-ui,sans-serif',
    width: (document.getElementById('bc-width') || {}).value || '600px'
  };
  var payload = { name: name.trim(), subject: subject, blocks_json: JSON.stringify(blocks), styles_json: JSON.stringify(styles) };
  bcSetStatus('<i class="fas fa-spinner fa-spin"></i> Saving…', '#f59e0b');
  try {
    var url = _bcEditId ? '/api/admin/templates/' + _bcEditId : '/api/admin/templates';
    var method = _bcEditId ? 'PUT' : 'POST';
    var res = await fetch(url, { method: method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    var d = await res.json();
    if (d.ok || d.id) {
      var savedName = name.trim();
      bcLoadTemplates(); // refresh list
      bcNewTemplate();   // clear builder, reset to new
      bcSetStatus('✓ Template "' + savedName + '" saved! Builder reset — ready for a new template.', '#10b981');
    } else {
      bcSetStatus('Error: ' + (d.error || 'Save failed'), '#ef4444');
    }
  } catch(e) { bcSetStatus('Network error: ' + e.message, '#ef4444'); }
}

async function bcDeleteTemplate(id, name) {
  if (!confirm('Delete template "' + name + '"? This cannot be undone.')) return;
  try {
    var res = await fetch('/api/admin/templates/' + id, { method: 'DELETE', credentials: 'include' });
    var d = await res.json();
    if (d.ok) { bcLoadTemplates(); bcSetStatus('Template deleted', '#64748b'); }
    else bcSetStatus('Error: ' + (d.error || 'Delete failed'), '#ef4444');
  } catch(e) { bcSetStatus('Network error: ' + e.message, '#ef4444'); }
}

async function bcLoadHistory() {
  var el = document.getElementById('bc-history-table');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;margin:0"><i class="fas fa-spinner fa-spin"></i> Loading\u2026</p>';
  try {
    var res = await fetch('/api/admin/broadcast/history', { credentials: 'include' });
    var d = await res.json();
    if (!d.sends || !d.sends.length) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;margin:0">No broadcasts sent yet.</p>';
      return;
    }
    var rows = d.sends.map(function(s) {
      var rate = s.sent_count > 0 ? Math.round((s.opened_count / s.sent_count) * 100) : 0;
      var rateColor = rate >= 30 ? '#10b981' : rate >= 15 ? '#f59e0b' : '#94a3b8';
      var openerId = 'openers-' + s.id;
      var btnId = 'opener-btn-' + s.id;
      var openBtn = s.opened_count > 0
        ? '<button id="' + btnId + '" onclick="bcToggleOpeners(' + s.id + ')" style="background:rgba(16,185,129,.15);color:#10b981;border:1px solid rgba(16,185,129,.3);border-radius:4px;padding:2px 8px;font-size:.76rem;cursor:pointer;white-space:nowrap">' +
          '<i class="fas fa-eye" style="margin-right:4px"></i>' + s.opened_count + ' opened</button>'
        : '<span style="color:#475569;font-size:.82rem">0</span>';
      return '<tr>' +
        '<td style="font-weight:600">' + escHtml(s.name) + '</td>' +
        '<td style="color:#94a3b8;font-size:.85rem">' + escHtml(s.subject || '') + '</td>' +
        '<td><span style="background:' + (s.audience==='individual' ? 'rgba(167,139,250,.15)' : 'rgba(78,159,255,.15)') + ';color:' + (s.audience==='individual' ? '#a78bfa' : '#4e9fff') + ';border-radius:4px;padding:2px 8px;font-size:.78rem">' + escHtml(s.audience || 'all') + '</span></td>' +
        '<td style="font-weight:700">' + (s.sent_count || 0) + '</td>' +
        '<td>' + openBtn + '</td>' +
        '<td><span style="font-weight:700;color:' + rateColor + '">' + rate + '%</span></td>' +
        '<td style="color:#64748b;font-size:.82rem">' + new Date(s.sent_at).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'}) + '</td>' +
        '</tr>' +
        '<tr id="' + openerId + '" style="display:none"><td colspan="7" style="padding:0;background:rgba(16,185,129,.04);border-bottom:1px solid rgba(16,185,129,.15)">' +
        '<div style="padding:12px 16px"><p style="color:var(--muted);font-size:.82rem;margin:0"><i class="fas fa-spinner fa-spin"></i> Loading openers\u2026</p></div>' +
        '</td></tr>';
    }).join('');
    el.innerHTML = '<div style="overflow-x:auto"><table class="admin-table"><thead><tr>' +
      '<th>Name</th><th>Subject</th><th>Audience</th><th>Sent</th><th>Opened</th><th>Open Rate</th><th>Date</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  } catch(e) {
    el.innerHTML = '<p style="color:#ef4444;font-size:.85rem;margin:0">Failed to load history: ' + escHtml(e.message) + '</p>';
  }
}

// Track which opener panels are open
window._bcOpenersState = {};

async function bcToggleOpeners(sendId) {
  var row = document.getElementById('openers-' + sendId);
  var btn = document.getElementById('opener-btn-' + sendId);
  if (!row) return;
  var isOpen = window._bcOpenersState[sendId];
  if (isOpen) {
    row.style.display = 'none';
    window._bcOpenersState[sendId] = false;
    if (btn) btn.innerHTML = btn.innerHTML.replace('fa-chevron-up','fa-eye');
    return;
  }
  // Open: fetch openers
  row.style.display = '';
  window._bcOpenersState[sendId] = true;
  var cell = row.querySelector('td > div');
  if (cell) cell.innerHTML = '<p style="color:var(--muted);font-size:.82rem;margin:0"><i class="fas fa-spinner fa-spin"></i> Loading openers\u2026</p>';
  try {
    var res = await fetch('/api/admin/broadcast/openers/' + sendId, { credentials: 'include' });
    var d = await res.json();
    if (!d.openers || !d.openers.length) {
      if (cell) cell.innerHTML = '<p style="color:var(--muted);font-size:.82rem;margin:0;padding:4px 0"><i class="fas fa-inbox" style="margin-right:6px"></i>No opener data yet — opens will appear here for future sends.</p>';
      return;
    }
    var tableRows = d.openers.map(function(o) {
      var name = o.name || '—';
      var email = o.email || (o.user_id ? '(id: ' + o.user_id + ')' : 'Unknown');
      var plan = o.plan || 'free';
      var planColor = plan === 'free' ? '#94a3b8' : '#10b981';
      var openedAt = o.opened_at ? new Date(o.opened_at).toLocaleString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
      return '<tr>' +
        '<td style="font-weight:600;font-size:.85rem">' + escHtml(name) + '</td>' +
        '<td style="color:#94a3b8;font-size:.82rem">' + escHtml(email) + '</td>' +
        '<td><span style="background:rgba(78,159,255,.1);color:' + planColor + ';border-radius:3px;padding:1px 6px;font-size:.75rem;font-weight:600">' + escHtml(plan) + '</span></td>' +
        '<td style="color:#64748b;font-size:.8rem;white-space:nowrap"><i class="fas fa-clock" style="margin-right:4px;opacity:.5"></i>' + escHtml(openedAt) + '</td>' +
        '</tr>';
    }).join('');
    if (cell) cell.innerHTML =
      '<div style="font-size:.78rem;font-weight:600;color:#10b981;letter-spacing:.05em;margin-bottom:8px;text-transform:uppercase"><i class="fas fa-eye" style="margin-right:5px"></i>Who Opened — ' + d.openers.length + ' ' + (d.openers.length === 1 ? 'person' : 'people') + '</div>' +
      '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-family:inherit">' +
      '<thead><tr style="border-bottom:1px solid rgba(255,255,255,.07)">' +
      '<th style="text-align:left;padding:4px 12px 4px 0;font-size:.75rem;color:#64748b;font-weight:600">Name</th>' +
      '<th style="text-align:left;padding:4px 12px 4px 0;font-size:.75rem;color:#64748b;font-weight:600">Email</th>' +
      '<th style="text-align:left;padding:4px 12px 4px 0;font-size:.75rem;color:#64748b;font-weight:600">Plan</th>' +
      '<th style="text-align:left;padding:4px 0;font-size:.75rem;color:#64748b;font-weight:600">Opened At</th>' +
      '</tr></thead><tbody>' + tableRows + '</tbody></table></div>';
  } catch(e) {
    if (cell) cell.innerHTML = '<p style="color:#ef4444;font-size:.82rem;margin:0">Failed to load openers: ' + escHtml(e.message) + '</p>';
  }
}

// ─────────────────────────────────────────────
// MY MUSIC ADMIN FUNCTIONS
// ─────────────────────────────────────────────

async function adminLoadAlbums() {
  var el = document.getElementById('admin-albums-list');
  if (el) el.innerHTML = '<p style="color:var(--muted);font-size:.85rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p>';
  try {
    var res = await fetch('/api/admin/albums', { credentials: 'include' });
    var d = await res.json();
    var albums = d.albums || [];
    if (!albums.length) {
      if (el) el.innerHTML = '<p style="color:#64748b;font-size:.85rem">No albums found.</p>';
    } else {
      var html = '<div style="display:flex;flex-direction:column;gap:10px">';
      albums.forEach(function(a) {
        var activeColor = a.is_active ? '#10b981' : '#ef4444';
        var activeLabel = a.is_active ? 'Active' : 'Hidden';
        html += '<div style="background:rgba(192,132,252,.06);border:1px solid rgba(192,132,252,.15);border-radius:10px;padding:14px;display:flex;align-items:center;gap:14px">' +
          (a.cover_key ? '<img src="/api/cover-art/' + escHtml(a.cover_key) + '" style="width:56px;height:56px;border-radius:8px;object-fit:cover;flex-shrink:0" onerror="this.style.display=\'none\'">' : '<div style="width:56px;height:56px;border-radius:8px;background:rgba(192,132,252,.12);display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fas fa-compact-disc" style="color:#c084fc;font-size:1.4rem"></i></div>') +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-weight:700;font-size:.92rem;color:#e2e8f0;margin-bottom:3px">' + escHtml(a.title || 'Untitled') + '</div>' +
            '<div style="font-size:.78rem;color:#94a3b8">' + escHtml(a.artist || '') + ' &nbsp;·&nbsp; $' + (parseFloat(a.mp3_price)||0).toFixed(2) + ' MP3</div>' +
            '<div style="margin-top:6px;display:flex;align-items:center;gap:8px">' +
              '<span style="font-size:.7rem;font-weight:600;padding:1px 8px;border-radius:4px;background:rgba(' + (a.is_active?'16,185,129':'239,68,68') + ',.12);color:' + activeColor + '">' + activeLabel + '</span>' +
              '<span style="font-size:.7rem;color:#64748b">Sort: ' + (a.sort_order||0) + '</span>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">' +
            '<button onclick="adminToggleAlbumActive(' + a.id + ',' + (a.is_active?0:1) + ')" style="padding:5px 10px;background:rgba(192,132,252,.12);border:1px solid rgba(192,132,252,.25);color:#c084fc;border-radius:7px;font-size:.72rem;font-weight:600;cursor:pointer;white-space:nowrap">' +
              (a.is_active ? '<i class="fas fa-eye-slash" style="margin-right:4px"></i>Hide' : '<i class="fas fa-eye" style="margin-right:4px"></i>Show') + '</button>' +
          '</div>' +
        '</div>';
      });
      html += '</div>';
      if (el) el.innerHTML = html;
    }
    // Also load tracks for album 1 (or first album)
    if (albums.length > 0) {
      adminLoadTracks(albums[0].id);
    }
  } catch(e) {
    if (el) el.innerHTML = '<p style="color:#ef4444;font-size:.82rem">Error: ' + escHtml(e.message) + '</p>';
  }
  // Also load singles
  adminLoadSingles();
}

async function adminToggleAlbumActive(id, newVal) {
  try {
    await fetch('/api/admin/album/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ is_active: newVal })
    });
    adminLoadAlbums();
  } catch(e) {
    alert('Error: ' + e.message);
  }
}

async function adminLoadTracks(albumId) {
  var el = document.getElementById('admin-tracks-list');
  if (el) el.innerHTML = '<p style="color:var(--muted);font-size:.82rem"><i class="fas fa-spinner fa-spin"></i> Loading tracks…</p>';
  try {
    var res = await fetch('/api/admin/album/' + (albumId||1) + '/tracks', { credentials: 'include' });
    var d = await res.json();
    var tracks = d.tracks || [];
    if (!tracks.length) {
      if (el) el.innerHTML = '<p style="color:#64748b;font-size:.82rem">No tracks found for this album.</p>';
      return;
    }
    var html = '<div style="display:flex;flex-direction:column;gap:6px">';
    tracks.forEach(function(t, i) {
      html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(255,255,255,.03);border-radius:8px;border:1px solid rgba(255,255,255,.06)">' +
        '<span style="width:24px;text-align:center;font-size:.75rem;color:#64748b;font-weight:600">' + (i+1) + '</span>' +
        '<span style="flex:1;font-size:.84rem;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(t.title||t.name||'Track '+t.id) + '</span>' +
        '<span style="font-size:.72rem;color:#94a3b8;white-space:nowrap">Preview @</span>' +
        '<input type="number" min="0" value="' + (t.preview_start_sec||0) + '" id="preview-sec-' + t.id + '" style="width:60px;padding:4px 6px;background:#1e293b;border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#e2e8f0;font-size:.8rem;text-align:center">' +
        '<span style="font-size:.72rem;color:#94a3b8">s</span>' +
        '<button onclick="adminSaveTrackPreview(' + t.id + ')" style="padding:4px 10px;background:rgba(192,132,252,.15);border:1px solid rgba(192,132,252,.3);color:#c084fc;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer">Save</button>' +
      '</div>';
    });
    html += '</div>';
    if (el) el.innerHTML = html;
  } catch(e) {
    if (el) el.innerHTML = '<p style="color:#ef4444;font-size:.82rem">Error: ' + escHtml(e.message) + '</p>';
  }
}

async function adminSaveTrackPreview(trackId) {
  var input = document.getElementById('preview-sec-' + trackId);
  if (!input) return;
  var sec = parseInt(input.value) || 0;
  try {
    var res = await fetch('/api/admin/album-track/' + trackId + '/preview', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ preview_start_sec: sec })
    });
    var d = await res.json();
    if (d.ok) {
      // Flash green feedback on the input
      input.style.borderColor = '#10b981';
      setTimeout(function() { input.style.borderColor = 'rgba(255,255,255,.12)'; }, 1500);
    }
  } catch(e) {
    alert('Error saving preview start: ' + e.message);
  }
}

async function adminLoadSingles() {
  var el = document.getElementById('admin-singles-list');
  if (el) el.innerHTML = '<p style="color:var(--muted);font-size:.85rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p>';
  try {
    var res = await fetch('/api/admin/singles', { credentials: 'include' });
    var d = await res.json();
    var singles = d.singles || [];
    if (!singles.length) {
      if (el) el.innerHTML = '<p style="color:#64748b;font-size:.85rem;padding:10px 0">No singles yet. Click <strong style="color:#34d399">Add Single</strong> to add your first one.</p>';
      return;
    }
    var html = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.82rem">' +
      '<thead><tr style="border-bottom:1px solid rgba(255,255,255,.07)">' +
      '<th style="text-align:left;padding:6px 10px;color:#64748b;font-weight:600">Cover</th>' +
      '<th style="text-align:left;padding:6px 10px;color:#64748b;font-weight:600">Title</th>' +
      '<th style="text-align:left;padding:6px 10px;color:#64748b;font-weight:600">Artist</th>' +
      '<th style="text-align:left;padding:6px 10px;color:#64748b;font-weight:600">Price</th>' +
      '<th style="text-align:left;padding:6px 10px;color:#64748b;font-weight:600">Genre</th>' +
      '<th style="text-align:left;padding:6px 10px;color:#64748b;font-weight:600">Preview@</th>' +
      '<th style="text-align:left;padding:6px 10px;color:#64748b;font-weight:600">Status</th>' +
      '<th style="text-align:right;padding:6px 10px;color:#64748b;font-weight:600">Actions</th>' +
      '</tr></thead><tbody>';
    singles.forEach(function(s) {
      var activeColor = s.is_active ? '#10b981' : '#ef4444';
      html += '<tr style="border-bottom:1px solid rgba(255,255,255,.04)">' +
        '<td style="padding:8px 10px">' +
          (s.cover_key ? '<img src="/api/cover-art/' + escHtml(s.cover_key) + '" style="width:38px;height:38px;border-radius:6px;object-fit:cover" onerror="this.style.display=\'none\'">' :
            '<div style="width:38px;height:38px;border-radius:6px;background:rgba(52,211,153,.1);display:flex;align-items:center;justify-content:center"><i class="fas fa-music" style="color:#34d399;font-size:.9rem"></i></div>') +
        '</td>' +
        '<td style="padding:8px 10px;font-weight:600;color:#e2e8f0">' + escHtml(s.title||'') + '</td>' +
        '<td style="padding:8px 10px;color:#94a3b8">' + escHtml(s.artist||'') + '</td>' +
        '<td style="padding:8px 10px;color:#34d399;font-weight:600">$' + (parseFloat(s.price)||0).toFixed(2) + '</td>' +
        '<td style="padding:8px 10px;color:#94a3b8">' + escHtml(s.genre||'—') + '</td>' +
        '<td style="padding:8px 10px;color:#94a3b8">' + (s.preview_start_sec||0) + 's</td>' +
        '<td style="padding:8px 10px"><span style="font-size:.7rem;font-weight:600;padding:2px 7px;border-radius:4px;background:rgba(' + (s.is_active?'16,185,129':'239,68,68') + ',.1);color:' + activeColor + '">' + (s.is_active?'Active':'Hidden') + '</span></td>' +
        '<td style="padding:8px 10px;text-align:right">' +
          '<button onclick="adminToggleSingleActive(' + s.id + ',' + (s.is_active?0:1) + ')" style="margin-right:6px;padding:4px 8px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#94a3b8;border-radius:6px;font-size:.72rem;cursor:pointer">' +
            (s.is_active ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>') + '</button>' +
          '<button onclick="adminDeleteSingle(' + s.id + ',\'' + escHtml(s.title||'') + '\')" style="padding:4px 8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);color:#ef4444;border-radius:6px;font-size:.72rem;cursor:pointer"><i class="fas fa-trash"></i></button>' +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    if (el) el.innerHTML = html;
  } catch(e) {
    if (el) el.innerHTML = '<p style="color:#ef4444;font-size:.82rem">Error: ' + escHtml(e.message) + '</p>';
  }
}

function adminShowAddSingle() {
  var form = document.getElementById('admin-add-single-form');
  if (!form) return;
  var isVisible = form.style.display !== 'none';
  form.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) {
    // Clear form fields
    ['as-title','as-artist','as-genre','as-cover','as-r2','as-desc'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el && el.tagName !== 'TEXTAREA') { /* keep defaults */ }
    });
    document.getElementById('as-preview').value = '0';
    document.getElementById('as-price').value = '1.99';
    document.getElementById('as-artist').value = 'Andrew Pryce';
    // Scroll to form
    setTimeout(function() { form.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
  }
}

async function adminSaveSingle() {
  var title = (document.getElementById('as-title')||{}).value || '';
  if (!title.trim()) { alert('Title is required.'); return; }
  var body = {
    title: title.trim(),
    artist: (document.getElementById('as-artist')||{}).value || 'Andrew Pryce',
    price: parseFloat((document.getElementById('as-price')||{}).value) || 1.99,
    genre: (document.getElementById('as-genre')||{}).value || null,
    cover_key: (document.getElementById('as-cover')||{}).value || null,
    r2_key: (document.getElementById('as-r2')||{}).value || null,
    preview_start_sec: parseInt((document.getElementById('as-preview')||{}).value) || 0,
    description: (document.getElementById('as-desc')||{}).value || null
  };
  var btn = document.querySelector('[onclick="adminSaveSingle()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:4px"></i>Saving…'; }
  try {
    var res = await fetch('/api/admin/singles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    var d = await res.json();
    if (d.ok) {
      document.getElementById('admin-add-single-form').style.display = 'none';
      adminLoadSingles();
    } else {
      alert('Error: ' + (d.error || 'Unknown error'));
    }
  } catch(e) {
    alert('Error: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save" style="margin-right:4px"></i>Save'; }
  }
}

async function adminToggleSingleActive(id, newVal) {
  try {
    await fetch('/api/admin/single/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ is_active: newVal })
    });
    adminLoadSingles();
  } catch(e) {
    alert('Error: ' + e.message);
  }
}

async function adminDeleteSingle(id, title) {
  if (!confirm('Delete single "' + title + '"? This cannot be undone.')) return;
  try {
    var res = await fetch('/api/admin/single/' + id, { method: 'DELETE', credentials: 'include' });
    var d = await res.json();
    if (d.ok) {
      adminLoadSingles();
    } else {
      alert('Error: ' + (d.error || 'Unknown error'));
    }
  } catch(e) {
    alert('Error: ' + e.message);
  }
}

// ─────────────────────────────────────────────
// SMART LINKS ADMIN FUNCTIONS
// ─────────────────────────────────────────────

async function adminLoadSmartLinks() {
  var el = document.getElementById('admin-sl-list');
  var countEl = document.getElementById('admin-sl-count');
  if (el) el.innerHTML = '<p style="color:var(--muted);font-size:.85rem"><i class="fas fa-spinner fa-spin"></i> Loading…</p>';
  try {
    var res = await fetch('/api/admin/smart-links', { credentials: 'include' });
    var d = await res.json();
    var links = d.links || [];
    if (countEl) countEl.textContent = links.length + ' link' + (links.length !== 1 ? 's' : '') + ' total';
    if (!links.length) {
      if (el) el.innerHTML = '<p style="color:#64748b;font-size:.85rem;padding:10px 0">No smart links created yet.</p>';
      return;
    }
    var html = '<div style="overflow-x:auto"><table class="admin-table">' +
      '<thead><tr>' +
      '<th>Cover</th><th>Title</th><th>Artist</th><th>User</th><th>Slug</th><th>Genre</th><th>Platforms</th><th>Views</th><th>Created</th><th style="text-align:right">Actions</th>' +
      '</tr></thead><tbody>';
    links.forEach(function(lk) {
      var platforms = [];
      if (lk.spotify_url) platforms.push('<span style="color:#1db954;font-size:.78rem" title="Spotify"><i class="fab fa-spotify"></i></span>');
      if (lk.apple_url) platforms.push('<span style="color:#fc3c44;font-size:.78rem" title="Apple Music"><i class="fab fa-apple"></i></span>');
      if (lk.youtube_url) platforms.push('<span style="color:#ff0000;font-size:.78rem" title="YouTube"><i class="fab fa-youtube"></i></span>');
      if (lk.soundcloud_url) platforms.push('<span style="color:#ff5500;font-size:.78rem" title="SoundCloud"><i class="fab fa-soundcloud"></i></span>');
      if (lk.tidal_url) platforms.push('<span style="color:#00ffff;font-size:.78rem" title="Tidal"><i class="fas fa-music"></i></span>');
      if (lk.amazon_url) platforms.push('<span style="color:#ff9900;font-size:.78rem" title="Amazon"><i class="fab fa-amazon"></i></span>');
      if (lk.deezer_url) platforms.push('<span style="color:#a238ff;font-size:.78rem" title="Deezer"><i class="fas fa-headphones"></i></span>');
      var createdDate = lk.created_at ? new Date(lk.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
      html += '<tr>' +
        '<td>' + (lk.cover_url ? '<img src="' + escHtml(lk.cover_url) + '" style="width:36px;height:36px;border-radius:6px;object-fit:cover" onerror="this.style.display=\'none\'">' : '<div style="width:36px;height:36px;border-radius:6px;background:rgba(52,211,153,.1);display:flex;align-items:center;justify-content:center"><i class="fas fa-link" style="color:#34d399;font-size:.8rem"></i></div>') + '</td>' +
        '<td style="font-weight:600;color:#e2e8f0;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(lk.title||'') + '</td>' +
        '<td style="color:#94a3b8;white-space:nowrap">' + escHtml(lk.artist||'') + '</td>' +
        '<td style="color:#64748b;font-size:.78rem;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(lk.email||lk.username||'—') + '</td>' +
        '<td><a href="/s/' + escHtml(lk.slug||'') + '" target="_blank" style="color:#34d399;font-size:.78rem;font-family:monospace">/s/' + escHtml(lk.slug||'') + '</a></td>' +
        '<td style="color:#94a3b8;font-size:.78rem">' + escHtml(lk.genre||'—') + '</td>' +
        '<td><div style="display:flex;gap:4px;flex-wrap:wrap">' + (platforms.join(' ')||'<span style="color:#64748b;font-size:.75rem">—</span>') + '</div></td>' +
        '<td style="color:#94a3b8;font-size:.82rem;text-align:center">' + (lk.view_count||0) + '</td>' +
        '<td style="color:#64748b;font-size:.78rem;white-space:nowrap">' + createdDate + '</td>' +
        '<td style="text-align:right">' +
          '<a href="/s/' + escHtml(lk.slug||'') + '" target="_blank" style="display:inline-block;padding:4px 8px;background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.2);color:#34d399;border-radius:6px;font-size:.72rem;text-decoration:none;margin-right:4px"><i class="fas fa-external-link-alt"></i></a>' +
          '<button onclick="adminDeleteSmartLink(' + lk.id + ',\'' + escHtml(lk.title||lk.slug||'') + '\')" style="padding:4px 8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);color:#ef4444;border-radius:6px;font-size:.72rem;cursor:pointer"><i class="fas fa-trash"></i></button>' +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    if (el) el.innerHTML = html;
  } catch(e) {
    if (el) el.innerHTML = '<p style="color:#ef4444;font-size:.82rem">Error: ' + escHtml(e.message) + '</p>';
  }
}

async function adminDeleteSmartLink(id, title) {
  if (!confirm('Delete smart link "' + title + '"? This cannot be undone.')) return;
  try {
    var res = await fetch('/api/admin/smart-links/' + id, { method: 'DELETE', credentials: 'include' });
    var d = await res.json();
    if (d.ok) {
      adminLoadSmartLinks();
    } else {
      alert('Error: ' + (d.error || 'Unknown error'));
    }
  } catch(e) {
    alert('Error: ' + e.message);
  }
}
